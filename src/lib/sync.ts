"use client";

/**
 * ProperChat <-> IAI conversation-tree sync (the adapter layer).
 *
 * IAI stores a *generic* branching conversation tree per conversation: a tree of
 * nodes, each with a stable id, parent link, children, and a free-form `meta`
 * blob. ProperChat adapts its own forest (chats + ConvNode trees) onto that
 * generic shape — one IAI conversation tree per chat (keyed by `chat.id`), with
 * each ProperChat `ConvNode` carried verbatim in a node's `meta.node` and the
 * `Chat` record in the root's `meta.chat`. IAI never sees ProperChat's field
 * shapes; it just round-trips the tree.
 *
 * Everything here is best-effort: a failed request is swallowed so the backend
 * being unavailable never breaks the local (localStorage) experience.
 */

import type { Chat, ConvNode } from "./types";

/** A node in the generic IAI Tree wire shape (interpret/processing/tree.py). */
interface TreeNodeDoc {
  node_id: string;
  label: string;
  parent_id: string | null;
  children: TreeNodeDoc[];
  meta: Record<string, unknown>;
}

/** The generic IAI Tree wire shape: `{ root }`. */
interface TreeDoc {
  root: TreeNodeDoc;
}

/** Reconstructed slice of the store loaded back from the backend. */
export interface PulledState {
  chats: Record<string, Chat>;
  nodes: Record<string, ConvNode>;
  chatOrder: string[];
}

/**
 * Whether backend conversation sync is enabled. Off by default so the app stays
 * localStorage-only until a deployment opts in (same flag that enables IAI media
 * storage). `NEXT_PUBLIC_` is inlined into the client bundle at build time.
 */
export function syncEnabled(): boolean {
  return process.env.NEXT_PUBLIC_IAI_STORE === "1";
}

/**
 * Drop inline base64 (`data:`) images from a node's messages before syncing, so
 * generated images aren't shipped to the backend. Mirrors the store's
 * localStorage `stripInlineImages`. Remote (http) image URLs are kept.
 */
function stripInlineImages(node: ConvNode): ConvNode {
  let changed = false;
  const messages = node.messages.map((m) => {
    if (!m.images?.some((src) => src.startsWith("data:"))) return m;
    changed = true;
    const kept = m.images.filter((src) => !src.startsWith("data:"));
    return kept.length ? { ...m, images: kept } : { ...m, images: undefined };
  });
  return changed ? { ...node, messages } : node;
}

/** Build a generic TreeNode for a ConvNode and (recursively) its child threads. */
function buildNode(
  nodes: Record<string, ConvNode>,
  nodeId: string,
  seen: Set<string>,
  extraMeta?: Record<string, unknown>,
): TreeNodeDoc | null {
  const node = nodes[nodeId];
  if (!node || seen.has(nodeId)) return null;
  seen.add(nodeId);
  const children = node.childIds
    .map((id) => buildNode(nodes, id, seen))
    .filter((c): c is TreeNodeDoc => c !== null);
  return {
    node_id: node.id,
    // Label is cosmetic here (IAI stores verbatim, no label-based merge); a
    // stable non-empty value keeps the tree readable in the backend.
    label: node.title || node.id,
    parent_id: node.parentId,
    children,
    meta: { node: stripInlineImages(node), ...(extraMeta ?? {}) },
  };
}

/**
 * Serialize one chat (its `Chat` record + the ConvNode subtree under
 * `rootNodeId`) into the generic IAI conversation-tree wire shape.
 */
export function serializeChatTree(chat: Chat, nodes: Record<string, ConvNode>): TreeDoc | null {
  const root = buildNode(nodes, chat.rootNodeId, new Set<string>(), { chat });
  return root ? { root } : null;
}

/** Walk a tree doc, collecting every ConvNode (meta.node) and Chat (meta.chat). */
function collect(
  tn: TreeNodeDoc,
  chats: Record<string, Chat>,
  nodes: Record<string, ConvNode>,
): void {
  const node = tn.meta?.node as ConvNode | undefined;
  if (node?.id) nodes[node.id] = node;
  const chat = tn.meta?.chat as Chat | undefined;
  if (chat?.id) chats[chat.id] = chat;
  for (const child of tn.children ?? []) collect(child, chats, nodes);
}

/** PUT one chat's tree to the backend (best-effort). */
export async function pushChat(chat: Chat, nodes: Record<string, ConvNode>): Promise<void> {
  if (!syncEnabled()) return;
  const tree = serializeChatTree(chat, nodes);
  if (!tree) return;
  try {
    await fetch("/api/conversations/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: chat.id, tree }),
    });
  } catch {
    /* best-effort: a failed sync must never break the local app */
  }
}

/** DELETE one chat's tree from the backend (best-effort). */
export async function deleteChatRemote(conversationId: string): Promise<void> {
  if (!syncEnabled()) return;
  try {
    await fetch("/api/conversations/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: conversationId }),
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Load every conversation tree for the org and reconstruct the store slice.
 * `chatOrder` is derived from each chat's `updatedAt` (newest first), since it
 * is local UI state not stored server-side. Returns null on any failure so the
 * caller falls back to a fresh local session.
 */
export async function pullAll(): Promise<PulledState | null> {
  if (!syncEnabled()) return null;
  try {
    const res = await fetch("/api/conversations/list");
    if (!res.ok) return null;
    const data = (await res.json()) as { trees?: TreeDoc[] };
    const trees = Array.isArray(data.trees) ? data.trees : [];
    const chats: Record<string, Chat> = {};
    const nodes: Record<string, ConvNode> = {};
    for (const tree of trees) {
      if (tree?.root) collect(tree.root, chats, nodes);
    }
    const chatOrder = Object.values(chats)
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
      .map((c) => c.id);
    return { chats, nodes, chatOrder };
  } catch {
    return null;
  }
}
