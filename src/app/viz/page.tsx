"use client";

import { ChevronLeft, GitBranch, MessagesSquare, Minus, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useIsomorphicLayoutEffect } from "@/lib/hooks";
import { getModel, modelLabel, providerInk, providerTint } from "@/lib/models";
import { useStore } from "@/lib/store";
import type { ConvNode } from "@/lib/types";
import { ProviderDot } from "@/components/ProviderDot";

const CARD_W = 220;
const CARD_H = 96;
/** Horizontal spacing between depth columns (the main conversation is rightmost). */
const COL_GAP = 300;
/** Vertical spacing between sibling rows (newest threads on top). */
const ROW_GAP = 140;
const MARGIN = 48;

const MIN_SCALE = 0.3;
const MAX_SCALE = 2.5;
/** Smaller = gentler zoom per wheel/pinch tick. */
const ZOOM_SENSITIVITY = 0.01;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface Placed {
  node: ConvNode;
  depth: number;
  left: number;
  top: number;
}

/** Condense a node into a one-glance summary for its card. */
function summarize(n: ConvNode): string {
  const text =
    n.compactions[n.compactions.length - 1]?.summary ||
    [...n.messages].reverse().find((m) => m.role === "assistant" && m.content.trim())?.content ||
    n.messages.find((m) => m.role === "user" && m.content.trim())?.content ||
    "";
  const t = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "No messages yet.";
  return t.length > 150 ? `${t.slice(0, 150).trimEnd()}…` : t;
}

/**
 * Tidy left→right layout: the main conversation is anchored on the left and
 * threads fan out to the right, deeper sub-threads further right still, so the
 * most recent activity lands on the right. Within a level, the most recent
 * threads sit at the top (scroll down for older), and each parent is centered
 * vertically over its children.
 */
function layout(nodes: Record<string, ConvNode>, rootId: string) {
  const placed: Placed[] = [];
  const byId = new Map<string, Placed>();
  const raw: { node: ConvNode; depth: number; y: number }[] = [];
  let row = 0;
  let maxDepth = 0;

  const walk = (id: string, depth: number): number => {
    const node = nodes[id];
    if (!node) return row;
    maxDepth = Math.max(maxDepth, depth);
    // Newest children first so the most recent threads land in the top rows.
    const kids = node.childIds
      .map((c) => nodes[c])
      .filter(Boolean)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    let y: number;
    if (!kids.length) {
      y = row;
      row += 1;
    } else {
      const ys = kids.map((k) => walk(k.id, depth + 1));
      y = (ys[0] + ys[ys.length - 1]) / 2;
    }
    raw.push({ node, depth, y });
    return y;
  };
  walk(rootId, 0);

  for (const r of raw) {
    const p: Placed = {
      node: r.node,
      depth: r.depth,
      // depth 0 (the main conversation) is anchored to the leftmost column;
      // deeper, more recent threads extend rightward.
      left: MARGIN + r.depth * COL_GAP,
      top: MARGIN + r.y * ROW_GAP,
    };
    placed.push(p);
    byId.set(r.node.id, p);
  }

  const rows = Math.max(1, row);
  const width = MARGIN * 2 + maxDepth * COL_GAP + CARD_W;
  const height = MARGIN * 2 + (rows - 1) * ROW_GAP + CARD_H;
  return { placed, byId, width, height };
}

function LoadingShell() {
  return (
    <div className="grid h-dvh place-items-center bg-bg">
      <div className="flex items-center gap-2 text-faint">
        <span className="h-2 w-2 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-current" />
      </div>
    </div>
  );
}

export default function VizPage() {
  const router = useRouter();
  const hydrated = useStore((s) => s.hydrated);
  const chats = useStore((s) => s.chats);
  const chatOrder = useStore((s) => s.chatOrder);
  const nodes = useStore((s) => s.nodes);
  const activeChatId = useStore((s) => s.activeChatId);
  const [pickedChatId, setPickedChatId] = useState<string | null>(null);

  // Pan/zoom. Scrolling pans (two-finger scroll moves down/up); pinch or
  // Ctrl+wheel zooms toward the cursor. `scaleRef` mirrors `scale` so the
  // native wheel handler reads the latest value without re-binding.
  const scrollRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef(1);
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    void useStore.getState().bootstrap();
  }, []);

  const chatId = pickedChatId ?? activeChatId;
  const chat = chatId ? chats[chatId] : null;

  const { placed, byId, width, height } = useMemo(() => {
    if (!chat) return { placed: [] as Placed[], byId: new Map<string, Placed>(), width: 0, height: 0 };
    return layout(nodes, chat.rootNodeId);
  }, [chat, nodes]);

  // Zoom toward a point (cursor or viewport center), keeping that content point
  // fixed under the anchor by adjusting scroll once the scaled size re-renders.
  const zoomTo = (next: number, anchorX?: number, anchorY?: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const s0 = scaleRef.current;
    const s1 = clamp(next, MIN_SCALE, MAX_SCALE);
    if (s1 === s0) return;
    const rect = el.getBoundingClientRect();
    const px = anchorX === undefined ? el.clientWidth / 2 : anchorX - rect.left;
    const py = anchorY === undefined ? el.clientHeight / 2 : anchorY - rect.top;
    const contentX = (el.scrollLeft + px) / s0;
    const contentY = (el.scrollTop + py) / s0;
    pendingScroll.current = { left: contentX * s1 - px, top: contentY * s1 - py };
    scaleRef.current = s1;
    setScale(s1);
  };

  // Pinch / Ctrl+wheel to zoom. A native non-passive listener is required to
  // preventDefault (otherwise the browser zooms the whole page).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // trackpad pinch and Ctrl+wheel both set ctrlKey
      e.preventDefault();
      const s0 = scaleRef.current;
      const next = s0 * Math.exp(-clamp(e.deltaY, -30, 30) * ZOOM_SENSITIVITY);
      zoomTo(next, e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [hydrated]);

  // Apply the scroll position computed alongside a zoom change, before paint.
  useIsomorphicLayoutEffect(() => {
    const el = scrollRef.current;
    const ps = pendingScroll.current;
    if (el && ps) {
      el.scrollLeft = ps.left;
      el.scrollTop = ps.top;
      pendingScroll.current = null;
    }
  }, [scale]);

  // When the tree changes, frame it on the main conversation (rightmost) with
  // the newest threads (top) in view.
  useIsomorphicLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !chat) return;
    el.scrollLeft = el.scrollWidth;
    el.scrollTop = 0;
  }, [chatId, width, height]);

  if (!hydrated) return <LoadingShell />;

  const open = (p: Placed) => {
    if (chatId) useStore.getState().selectChat(chatId);
    if (p.depth === 0) useStore.getState().closeThread();
    else useStore.getState().openThread(p.node.id);
    router.push("/");
  };

  const resetZoom = () => {
    const el = scrollRef.current;
    const was = scaleRef.current;
    scaleRef.current = 1;
    setScale(1);
    if (was === 1 && el) {
      el.scrollLeft = el.scrollWidth;
      el.scrollTop = 0;
    } else {
      pendingScroll.current = { left: Number.MAX_SAFE_INTEGER, top: 0 };
    }
  };

  // Edges run from the parent's right edge to the child's left edge (the parent
  // sits to the left), curving horizontally.
  const edges: { x1: number; y1: number; x2: number; y2: number; key: string }[] = [];
  for (const p of placed) {
    for (const childId of p.node.childIds) {
      const c = byId.get(childId);
      if (!c) continue;
      edges.push({
        x1: p.left + CARD_W,
        y1: p.top + CARD_H / 2,
        x2: c.left,
        y2: c.top + CARD_H / 2,
        key: `${p.node.id}-${childId}`,
      });
    }
  }

  return (
    <div className="flex h-dvh flex-col bg-bg text-ink">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href="/"
            className="flex h-9 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-muted transition hover:bg-surface-2 hover:text-ink"
          >
            <ChevronLeft size={18} />
            Back to chat
          </Link>
          <span className="text-faint">/</span>
          <h1 className="truncate text-[15px] font-semibold">Conversation tree</h1>
        </div>
        {chatOrder.length > 0 && (
          <select
            data-testid="viz-chat-select"
            value={chatId ?? ""}
            onChange={(e) => setPickedChatId(e.target.value)}
            className="max-w-[260px] rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-faint"
          >
            {chatOrder.map((id) => (
              <option key={id} value={id}>
                {chats[id]?.title ?? "Chat"}
              </option>
            ))}
          </select>
        )}
      </header>

      <div className="relative flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          className="h-full w-full overflow-auto scrollbar-thin"
          data-testid="viz-canvas"
        >
          {!chat ? (
            <div className="grid h-full place-items-center px-6 text-center text-[14px] text-muted">
              No conversation selected.
            </div>
          ) : (
            <div className="relative" style={{ width: width * scale, height: height * scale }}>
              <div
                data-testid="viz-content"
                className="absolute left-0 top-0 origin-top-left"
                style={{ width, height, transform: `scale(${scale})` }}
              >
                <svg
                  className="pointer-events-none absolute inset-0"
                  width={width}
                  height={height}
                  aria-hidden
                >
                  {edges.map((e) => {
                    const mx = (e.x1 + e.x2) / 2;
                    return (
                      <path
                        key={e.key}
                        d={`M ${e.x1} ${e.y1} C ${mx} ${e.y1}, ${mx} ${e.y2}, ${e.x2} ${e.y2}`}
                        fill="none"
                        stroke="var(--border)"
                        strokeWidth={2}
                      />
                    );
                  })}
                </svg>

                {placed.map((p) => {
                  const model = getModel(p.node.currentModelId);
                  const isRoot = p.depth === 0;
                  const msgs = p.node.messages.length;
                  return (
                    <button
                      key={p.node.id}
                      type="button"
                      data-testid="viz-node"
                      onClick={() => open(p)}
                      style={{
                        left: p.left,
                        top: p.top,
                        width: CARD_W,
                        minHeight: CARD_H,
                        background: providerTint(model.provider),
                      }}
                      className="group absolute flex flex-col gap-1.5 rounded-xl border border-line p-3 text-left shadow-sm transition hover:border-accent/50 hover:shadow-md"
                    >
                      <span className="flex items-center gap-1.5">
                        {isRoot ? (
                          <MessagesSquare size={14} className="shrink-0 text-accent" />
                        ) : (
                          <GitBranch size={14} className="shrink-0 text-accent" />
                        )}
                        <span
                          className="truncate text-[13px] font-semibold"
                          style={{ color: providerInk(model.provider, 24) }}
                        >
                          {isRoot ? "Main conversation" : p.node.title}
                        </span>
                      </span>
                      <span
                        className="line-clamp-2 text-[12px] leading-snug"
                        style={{ color: providerInk(model.provider, 15, "--muted") }}
                      >
                        {summarize(p.node)}
                      </span>
                      <span className="mt-auto flex items-center gap-1.5 text-[11px] text-faint">
                        <ProviderDot provider={model.provider} />
                        {modelLabel(model, "interpret").split(" ").slice(0, 2).join(" ")}
                        <span>·</span>
                        <span>
                          {msgs} msg{msgs === 1 ? "" : "s"}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {chat && (
          <div className="absolute bottom-4 right-4 z-10 flex items-center gap-0.5 rounded-xl border border-line bg-surface/90 p-1 shadow-md backdrop-blur">
            <button
              type="button"
              data-testid="viz-zoom-out"
              onClick={() => zoomTo(scaleRef.current / 1.2)}
              title="Zoom out"
              aria-label="Zoom out"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-ink"
            >
              <Minus size={16} />
            </button>
            <button
              type="button"
              data-testid="viz-zoom-reset"
              onClick={resetZoom}
              title="Reset zoom"
              className="min-w-[3rem] rounded-lg px-1.5 py-1 text-center text-[12px] font-medium tabular-nums text-muted transition hover:bg-surface-2 hover:text-ink"
            >
              {Math.round(scale * 100)}%
            </button>
            <button
              type="button"
              data-testid="viz-zoom-in"
              onClick={() => zoomTo(scaleRef.current * 1.2)}
              title="Zoom in"
              aria-label="Zoom in"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-ink"
            >
              <Plus size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
