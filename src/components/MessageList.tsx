"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { canBranch } from "@/lib/tree";
import { useStore } from "@/lib/store";
import type { ConvNode } from "@/lib/types";
import { MessageItem } from "./MessageItem";

export function MessageList({ nodeId }: { nodeId: string }) {
  const node = useStore((s) => s.nodes[nodeId]);
  const streamingId = useStore((s) => s.streamingNodeIds[nodeId]);
  const compacting = useStore((s) => Boolean(s.compacting[nodeId]));
  const allNodes = useStore((s) => s.nodes);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const lastScrollTop = useRef(0);
  const prevLen = useRef(0);
  const prevNodeId = useRef<string | null>(null);

  // Map anchorMessageId -> child thread nodes, so each message can show its chips.
  const childThreadsByAnchor = useMemo(() => {
    const map = new Map<string, ConvNode[]>();
    if (!node) return map;
    for (const childId of node.childIds) {
      const child = allNodes[childId];
      if (!child?.anchorMessageId) continue;
      const arr = map.get(child.anchorMessageId) ?? [];
      arr.push(child);
      map.set(child.anchorMessageId, arr);
    }
    return map;
  }, [node, allNodes]);

  const lastContent = node?.messages[node.messages.length - 1]?.content;

  // Detect scroll intent. A programmatic scroll-to-bottom only ever increases
  // scrollTop, and streaming content keeps scrollTop fixed — so any decrease is
  // the user scrolling up: that unpins (we stay put). Returning to the bottom
  // re-pins (we follow again). Distance alone is never enough to keep us pinned.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const top = el.scrollTop;
      if (top < lastScrollTop.current - 2) {
        stickToBottom.current = false;
      } else if (el.scrollHeight - top - el.clientHeight < 80) {
        stickToBottom.current = true;
      }
      lastScrollTop.current = top;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Follow the conversation: jump to the bottom when switching nodes or when a
  // message is added (including the user's own send — the store appends the user
  // and assistant messages together, so the count rises). For streaming tokens
  // into the existing last message, scroll only if the user is still pinned.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const len = node?.messages.length ?? 0;
    if (prevNodeId.current !== nodeId) {
      prevNodeId.current = nodeId;
      stickToBottom.current = true;
    } else if (len > prevLen.current) {
      stickToBottom.current = true;
    }
    prevLen.current = len;
    if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
      lastScrollTop.current = el.scrollTop;
    }
  }, [nodeId, node?.messages.length, lastContent]);

  if (!node) return null;

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto flex w-full max-w-chat flex-col gap-6 px-4 py-8 md:px-6">
        {node.messages.map((m, i) => (
          <MessageItem
            key={m.id}
            message={m}
            nodeId={nodeId}
            isStreaming={streamingId === m.id}
            isLast={i === node.messages.length - 1}
            childThreads={childThreadsByAnchor.get(m.id) ?? []}
            canBranchHere={canBranch(node)}
          />
        ))}
        {compacting && (
          <div className="flex justify-center">
            <span
              data-testid="compacting-indicator"
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-[12px] text-muted"
            >
              <Loader2 size={13} className="animate-spin text-accent" />
              Compacting earlier messages to fit the model&apos;s context…
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
