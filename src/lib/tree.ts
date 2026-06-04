import { MAX_THREAD_BRANCHING } from "./models";
import type { ConvNode } from "./types";

export type NodeMap = Record<string, ConvNode>;

/** Root → … → node path through the conversation tree. */
export function nodePath(nodes: NodeMap, nodeId: string): ConvNode[] {
  const path: ConvNode[] = [];
  let cur: ConvNode | undefined = nodes[nodeId];
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    path.unshift(cur);
    cur = cur.parentId ? nodes[cur.parentId] : undefined;
  }
  return path;
}

/** Index in `parent.messages` of the message `child` is anchored to (inclusive). */
export function anchorIndex(parent: ConvNode, child: ConvNode): number {
  if (!child.anchorMessageId) return parent.messages.length - 1;
  const i = parent.messages.findIndex((m) => m.id === child.anchorMessageId);
  return i === -1 ? parent.messages.length - 1 : i;
}

export function canBranch(node: ConvNode | undefined): boolean {
  return Boolean(node) && node!.depth < MAX_THREAD_BRANCHING;
}

export function childrenOf(nodes: NodeMap, nodeId: string): ConvNode[] {
  const node = nodes[nodeId];
  if (!node) return [];
  return node.childIds.map((id) => nodes[id]).filter(Boolean);
}

export function descendantIds(nodes: NodeMap, nodeId: string): string[] {
  const out: string[] = [];
  const stack = [...(nodes[nodeId]?.childIds ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    const n = nodes[id];
    if (!n) continue;
    out.push(id);
    stack.push(...n.childIds);
  }
  return out;
}

/** A document attachment (e.g. a PDF) forwarded to providers that read it natively. */
export interface ContextDocument {
  /** The attachment URI: a `data:` URL (base64) or an http(s) URL. */
  url: string;
  mime: string;
}

export interface BuiltContext {
  system: string;
  messages: {
    role: "user" | "assistant";
    content: string;
    image_urls?: string[];
    documents?: ContextDocument[];
  }[];
}

/**
 * Assemble the LLM context for a node by walking the tree from the root down to
 * the node. For each node on the path we include messages up to (and including)
 * the anchor that spawned the next node - or all of them at the leaf. Within a
 * node we honor the *closest compaction*: the summary covering the largest
 * prefix replaces those messages and is hoisted into the system prompt. This is
 * "continue from the leaf message to the closest compacted parent": history
 * before a compaction node collapses to its summary.
 */
export function buildContext(
  nodes: NodeMap,
  nodeId: string,
  baseSystem: string,
): BuiltContext {
  const path = nodePath(nodes, nodeId);
  const summaries: string[] = [];
  const messages: BuiltContext["messages"] = [];
  // Images the assistant GENERATED (`m.images`) are shown back to the model as
  // input on the next user turn — across all providers an image is only valid in
  // a user/input position, and this is where the model "sees" what it previously
  // made (so a follow-up like "make it blue" works).
  let pendingGenImages: string[] = [];

  for (let i = 0; i < path.length; i++) {
    const node = path[i];
    const isLeaf = i === path.length - 1;
    const end = isLeaf ? node.messages.length : anchorIndex(node, path[i + 1]) + 1;

    const comp = node.compactions
      .filter((c) => c.atIndex <= end)
      .sort((a, b) => b.atIndex - a.atIndex)[0];
    let start = comp ? comp.atIndex : 0;
    if (comp) summaries.push(comp.summary);

    // Never let a compaction swallow the trailing user turn on the leaf: both
    // continuing the conversation and regenerating the last reply need the most
    // recent user message live, otherwise the request goes out with zero
    // messages ("No messages"). Re-include from the last user message onward.
    if (isLeaf && start > 0) {
      let lastUser = -1;
      for (let j = end - 1; j >= 0; j--) {
        if (node.messages[j]?.role === "user") {
          lastUser = j;
          break;
        }
      }
      if (lastUser !== -1 && lastUser < start) start = lastUser;
    }

    for (let j = start; j < end; j++) {
      const m = node.messages[j];
      if (!m || m.role === "system" || m.error) continue;

      if (m.role === "assistant") {
        // Emit the assistant's text; carry any images it generated forward to
        // the next user turn (where they're a valid input the model can see).
        if (m.content.trim()) messages.push({ role: "assistant", content: m.content });
        const gen = (m.images ?? []).filter((u) => /^(s3:|https?:|data:)/.test(u));
        if (gen.length) pendingGenImages = [...pendingGenImages, ...gen];
        continue;
      }

      // User turn: its own image attachments, plus any generated images carried
      // from the preceding assistant turn so the model can reason about them.
      const attached =
        m.attachments?.filter((a) => a.modality === "image" && a.uri).map((a) => a.uri) ?? [];
      const imageUrls = [...pendingGenImages, ...attached];
      pendingGenImages = [];
      const hasImages = imageUrls.length > 0;
      // Documents (PDFs) are read natively by Claude/Gemini/OpenAI; forward them
      // as their own content blocks rather than dropping them.
      const documents =
        m.attachments
          ?.filter((a) => a.modality === "pdf" && a.uri)
          .map((a) => ({ url: a.uri, mime: a.mime })) ?? [];
      const hasDocuments = documents.length > 0;
      if (!m.content.trim() && !hasImages && !hasDocuments) continue;
      messages.push({
        role: "user",
        content: m.content,
        ...(hasImages ? { image_urls: imageUrls } : {}),
        ...(hasDocuments ? { documents } : {}),
      });
    }
  }

  // If this thread was branched from a highlighted excerpt, focus the model on
  // it while keeping the full conversation above as context.
  const target = nodes[nodeId];
  const focus = target?.highlight?.trim()
    ? `The user branched this thread to focus on a highlighted excerpt from the previous message:\n"""\n${target.highlight.trim()}\n"""\nAddress this excerpt specifically, using the conversation above as context.`
    : null;

  const base = baseSystem.trim();
  const system = [
    base,
    ...summaries.map((s) => `Summary of earlier conversation:\n${s}`),
    focus,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system, messages };
}

/** A short, human title from the first user message. */
export function deriveTitle(text: string): string {
  const firstLine = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!firstLine) return "New chat";
  return firstLine.length > 52 ? `${firstLine.slice(0, 52).trimEnd()}…` : firstLine;
}
