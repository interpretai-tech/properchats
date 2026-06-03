"use client";

import { Archive, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { useStore } from "@/lib/store";

/**
 * Manual compaction control. The app auto-compacts based on each model's context
 * window, so this is a power-user affordance: it only appears when "Nerd tools"
 * is enabled in advanced settings. The model summarizes the conversation so far
 * and the summary becomes a "compacted node" (see buildContext). A badge shows
 * how many compactions exist on this node.
 */
export function CompactButton({ nodeId }: { nodeId: string }) {
  const node = useStore((s) => s.nodes[nodeId]);
  const nerdTools = useStore((s) => s.settings.nerdTools);
  const compacting = useStore((s) => Boolean(s.compacting[nodeId]));
  const compact = useStore((s) => s.compact);

  if (!node || !nerdTools) return null;
  const count = node.compactions.length;
  const disabled = compacting || node.messages.length < 2;

  return (
    <button
      type="button"
      data-testid="compact-button"
      onClick={() => void compact(nodeId)}
      disabled={disabled}
      title="Compact history into a summary"
      className={cn(
        "flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[13px] font-medium text-muted transition hover:bg-surface-2 hover:text-ink",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {compacting ? <Loader2 size={15} className="animate-spin" /> : <Archive size={15} />}
      <span className="hidden md:inline">{compacting ? "Compacting…" : "Compact"}</span>
      {count > 0 && (
        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-surface-3 px-1 text-[10px] font-semibold text-muted">
          {count}
        </span>
      )}
    </button>
  );
}
