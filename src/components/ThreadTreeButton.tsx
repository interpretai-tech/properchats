"use client";

import { CornerDownRight, MessagesSquare, Network } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { getModel, modelLabel } from "@/lib/models";
import { useDismiss } from "@/lib/hooks";
import { useStore } from "@/lib/store";
import type { ConvNode } from "@/lib/types";
import { ProviderDot } from "./ProviderDot";

interface Row {
  node: ConvNode;
  depth: number;
}

export function ThreadTreeButton({ chatId }: { chatId: string }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const chat = useStore((s) => s.chats[chatId]);
  const nodes = useStore((s) => s.nodes);
  const openThreadNodeId = useStore((s) => s.openThreadNodeId);
  const openThread = useStore((s) => s.openThread);
  const closeThread = useStore((s) => s.closeThread);

  const rows = useMemo<Row[]>(() => {
    if (!chat) return [];
    const out: Row[] = [];
    const walk = (id: string, depth: number) => {
      const n = nodes[id];
      if (!n) return;
      out.push({ node: n, depth });
      n.childIds.forEach((c) => walk(c, depth + 1));
    };
    walk(chat.rootNodeId, 0);
    return out;
  }, [chat, nodes]);

  const threadCount = rows.length - 1;

  const select = (row: Row) => {
    if (row.depth === 0) closeThread();
    else openThread(row.node.id);
    setOpen(false);
  };

  // When the tree opens, bring the currently-selected node to the top of the
  // list. Without this the list opens scrolled to the root, so an active deep
  // thread sits off-screen at the bottom and you have to scroll to find it.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      const list = listRef.current;
      const active = activeRef.current;
      if (!list || !active) return;
      list.scrollTop += active.getBoundingClientRect().top - list.getBoundingClientRect().top;
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  if (!chat) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        data-testid="thread-tree-button"
        onClick={() => setOpen((v) => !v)}
        title="Conversation tree"
        className={cn(
          "relative flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[13px] font-medium text-muted transition hover:bg-surface-2 hover:text-ink",
          open && "bg-surface-2 text-ink",
        )}
      >
        <MessagesSquare size={16} className="text-accent" />
        <span className="hidden sm:inline">Threads</span>
        {threadCount > 0 && (
          <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-fg">
            {threadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-2 w-[320px] overflow-hidden rounded-xl border border-line bg-surface shadow-xl">
          <div className="border-b border-line px-3.5 py-2.5">
            <p className="text-[13px] font-semibold text-ink">Conversation tree</p>
            <p className="text-[11px] text-faint">
              {threadCount === 0
                ? "No threads yet - branch any message to start one."
                : `${threadCount} thread${threadCount === 1 ? "" : "s"} · click to open`}
            </p>
          </div>
          <div ref={listRef} className="max-h-[216px] overflow-y-auto scrollbar-thin py-1">
            {rows.map(({ node, depth }) => {
              const model = getModel(node.currentModelId);
              const isActive =
                depth === 0 ? openThreadNodeId === null : openThreadNodeId === node.id;
              const msgCount = node.messages.length;
              return (
                <button
                  key={node.id}
                  ref={isActive ? activeRef : undefined}
                  type="button"
                  data-testid="thread-tree-row"
                  data-active={isActive ? "true" : undefined}
                  onClick={() => select({ node, depth })}
                  className={cn(
                    "flex w-full items-start gap-2 px-3 py-2 text-left transition hover:bg-surface-2",
                    isActive && "bg-surface-2",
                  )}
                  style={{ paddingLeft: `${12 + depth * 16}px` }}
                >
                  {depth > 0 ? (
                    <CornerDownRight size={14} className="mt-0.5 shrink-0 text-faint" />
                  ) : (
                    <MessagesSquare size={14} className="mt-0.5 shrink-0 text-accent" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium text-ink">
                        {depth === 0 ? "Main conversation" : node.title}
                      </span>
                      {isActive && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-faint">
                      <ProviderDot provider={model.provider} />
                      {modelLabel(model, "interpret").split(" ").slice(0, 2).join(" ")}
                      <span>·</span>
                      <span>{msgCount} msg{msgCount === 1 ? "" : "s"}</span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <Link
            href="/viz"
            data-testid="viz-link"
            onClick={() => setOpen(false)}
            className="flex items-center gap-1.5 border-t border-line px-3.5 py-2.5 text-[12.5px] font-medium text-muted transition hover:bg-surface-2 hover:text-ink"
          >
            <Network size={14} className="text-accent" />
            Open full tree view
          </Link>
        </div>
      )}
    </div>
  );
}
