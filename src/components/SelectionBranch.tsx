"use client";

import { GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { useStore } from "@/lib/store";
import { canBranch } from "@/lib/tree";

interface Popup {
  x: number;
  y: number;
  /** Which edge of the selection the popup hangs off: to the right, or flipped to the left when there's no room. */
  side: "right" | "left";
  nodeId: string;
  messageId: string;
  text: string;
}

/** Rough popup width, used only to decide whether it fits to the right of the selection. */
const POPUP_W = 168;
const GAP = 8;

/**
 * Watches for a text selection inside a message and offers to branch a thread
 * focused on the highlighted excerpt (the thread still inherits the full
 * message/conversation context - see buildContext). Rendered once at the app
 * root; sits to the right of the selection, vertically centered, so it never
 * covers the highlighted text.
 */
export function SelectionBranch() {
  const branchThread = useStore((s) => s.branchThread);
  const nodes = useStore((s) => s.nodes);
  const [popup, setPopup] = useState<Popup | null>(null);

  useEffect(() => {
    const evaluate = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setPopup(null);
        return;
      }
      const text = sel.toString().trim();
      if (text.length < 2 || text.length > 4000) {
        setPopup(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const container = range.commonAncestorContainer;
      const startEl =
        container.nodeType === Node.ELEMENT_NODE
          ? (container as Element)
          : container.parentElement;
      const msgEl = startEl?.closest('[data-testid="message"]') as HTMLElement | null;
      const nodeId = msgEl?.dataset.nodeId;
      const messageId = msgEl?.dataset.messageId;
      if (!msgEl || !nodeId || !messageId) {
        setPopup(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      // Sit to the right of the selection, vertically centered on it, so the
      // button never covers the highlighted text. Flip to the left edge when
      // there isn't room on the right.
      const fitsRight = rect.right + GAP + POPUP_W <= window.innerWidth;
      const side = fitsRight ? "right" : "left";
      setPopup({
        x: side === "right" ? rect.right + GAP : rect.left - GAP,
        y: Math.min(Math.max(rect.top + rect.height / 2, 44), window.innerHeight - 44),
        side,
        nodeId,
        messageId,
        text,
      });
    };

    const onMouseUp = () => window.setTimeout(evaluate, 10);
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setPopup(null);
    };
    const onScroll = () => setPopup(null);

    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, []);

  if (!popup) return null;
  if (!canBranch(nodes[popup.nodeId])) return null;

  return (
    <button
      type="button"
      data-testid="selection-branch"
      // Keep the selection alive through the click.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        branchThread(popup.nodeId, popup.messageId, popup.text);
        window.getSelection()?.removeAllRanges();
        setPopup(null);
      }}
      style={{ left: popup.x, top: popup.y }}
      className={cn(
        "fixed z-[60] flex -translate-y-1/2 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12.5px] font-medium text-ink shadow-lg transition hover:bg-surface-2 animate-fade",
        popup.side === "left" && "-translate-x-full",
      )}
    >
      <GitBranch size={14} className="text-accent" />
      Branch into thread
    </button>
  );
}
