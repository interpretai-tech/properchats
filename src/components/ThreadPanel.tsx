"use client";

import { ChevronLeft, Network, CornerDownRight, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { THREAD_WIDTH_DEFAULT, THREAD_WIDTH_MAX, THREAD_WIDTH_MIN } from "@/lib/constants";
import { useStore } from "@/lib/store";
import { Composer } from "./Composer";
import { CompactButton } from "./CompactButton";
import { MessageList } from "./MessageList";

/** Clamp a desired width to sane bounds, always leaving room for the chat pane. */
function clampWidth(w: number): number {
  const hardMax =
    typeof window !== "undefined"
      ? Math.min(THREAD_WIDTH_MAX, window.innerWidth - 380)
      : THREAD_WIDTH_MAX;
  return Math.max(THREAD_WIDTH_MIN, Math.min(w, Math.max(THREAD_WIDTH_MIN, hardMax)));
}

export function ThreadPanel() {
  const openId = useStore((s) => s.openThreadNodeId);
  const node = useStore((s) => (openId ? s.nodes[openId] : undefined));
  const openThread = useStore((s) => s.openThread);
  const closeThread = useStore((s) => s.closeThread);

  // Desktop width is a per-user setting (persisted with the rest of settings),
  // so it survives reloads and is scoped to the signed-in user. Drag updates a
  // local value live for smoothness, then commits to settings on release.
  const storedWidth = useStore((s) => s.settings.threadWidth);
  const updateSettings = useStore((s) => s.updateSettings);
  const [width, setWidth] = useState(() => clampWidth(storedWidth ?? THREAD_WIDTH_DEFAULT));
  const [dragging, setDragging] = useState(false);
  // Mirror of `dragging` readable synchronously inside pointer handlers.
  const draggingRef = useRef(false);

  // Cosmetic: while dragging, force the resize cursor and suppress text selection.
  useEffect(() => {
    if (!dragging) return;
    const { style } = document.body;
    const prevCursor = style.cursor;
    const prevSelect = style.userSelect;
    style.cursor = "col-resize";
    style.userSelect = "none";
    return () => {
      style.cursor = prevCursor;
      style.userSelect = prevSelect;
    };
  }, [dragging]);

  // Persist the settled width once dragging ends (not on every move).
  useEffect(() => {
    if (dragging || width === storedWidth) return;
    updateSettings({ threadWidth: width });
  }, [dragging, width, storedWidth, updateSettings]);

  if (!openId || !node) return null;

  const isSubThread = node.depth >= 2;
  const back = () => {
    // A sub-thread steps back to its parent thread; a top-level thread closes.
    if (isSubThread && node.parentId) openThread(node.parentId);
    else closeThread();
  };

  return (
    <aside
      data-testid="thread-panel"
      style={{ "--thread-w": `${width}px` } as React.CSSProperties}
      className="absolute inset-0 z-30 flex flex-col border-l border-line bg-bg animate-slide-in-right md:relative md:inset-auto md:w-[var(--thread-w)] md:shrink-0"
    >
      {/* Drag the left edge to resize (desktop only); double-click to reset. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize thread panel"
        title="Drag to resize · double-click to reset"
        data-testid="thread-resize"
        onPointerDown={(e) => {
          e.preventDefault();
          // Capture the pointer so every move/up lands here even as it leaves the
          // 8px strip — and the handlers are live immediately (no effect lag).
          e.currentTarget.setPointerCapture(e.pointerId);
          draggingRef.current = true;
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (!draggingRef.current) return;
          // The pane is flush to the viewport's right edge, so its width is the
          // distance from the pointer to that edge.
          setWidth(clampWidth(window.innerWidth - e.clientX));
        }}
        onPointerUp={(e) => {
          if (!draggingRef.current) return;
          draggingRef.current = false;
          setDragging(false);
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onDoubleClick={() => setWidth(THREAD_WIDTH_DEFAULT)}
        className={cn(
          "absolute left-0 top-0 z-20 hidden h-full w-2 -translate-x-1/2 cursor-col-resize touch-none transition-colors md:block",
          dragging ? "bg-accent/50" : "hover:bg-accent/40",
        )}
      />

      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            onClick={back}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-ink"
            aria-label="Back"
          >
            <ChevronLeft size={18} />
          </button>
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold text-ink">{node.title}</p>
            <p className="text-[11px] text-faint">
              {isSubThread ? "Sub-thread" : "Thread"} · depth {node.depth}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <CompactButton nodeId={node.id} />
          <Link
            href="/viz"
            data-testid="thread-viz-link"
            title="View conversation tree"
            aria-label="View conversation tree"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-ink"
          >
            <Network size={17} />
          </Link>
          <button
            type="button"
            onClick={closeThread}
            data-testid="thread-close"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-ink"
            aria-label="Close thread"
          >
            <X size={18} />
          </button>
        </div>
      </header>

      {(node.anchorPreview || node.highlight) && (
        <div className="shrink-0 space-y-2 border-b border-line bg-surface-2/60 px-4 py-2.5">
          {node.highlight && (
            <div className="rounded-lg border-l-2 border-accent bg-accent-soft/50 px-2.5 py-1.5 text-[12.5px] text-ink">
              <span className="font-medium text-accent">Focusing on: </span>
              <span className="italic">“{node.highlight}”</span>
            </div>
          )}
          {node.anchorPreview && (
            <div className="flex items-start gap-2 text-[12px] text-muted">
              <CornerDownRight size={14} className="mt-0.5 shrink-0 text-faint" />
              <span className="line-clamp-2">
                <span className="font-medium text-faint">Branched from: </span>
                {node.anchorPreview}
              </span>
            </div>
          )}
        </div>
      )}

      {node.messages.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <p className="text-[14px] font-medium text-ink">New thread</p>
          <p className="mt-1 max-w-[280px] text-[13px] text-muted">
            This thread inherits the conversation up to the branch point. Ask anything - pick a
            different model below to switch providers.
          </p>
        </div>
      ) : (
        <MessageList nodeId={node.id} />
      )}

      <Composer nodeId={node.id} autoFocus placeholder="Reply in thread…" testId="composer-thread" />
    </aside>
  );
}
