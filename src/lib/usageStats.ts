import { DEFAULT_FREE_CALL_LIMIT } from "./constants";
import { getModel, modelLabel } from "./models";
import type { ConvNode } from "./types";

/**
 * Client-side usage stats derived from the local conversation store: how many
 * model calls (assistant turns) were made this calendar month, per model and in
 * total. Drives the local "Usage" view in Settings; no backend involved.
 */

export function freeCallLimit(): number {
  const n = Number(process.env.NEXT_PUBLIC_FREE_CALL_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_FREE_CALL_LIMIT;
}

export interface ModelUsage {
  modelId: string;
  label: string;
  count: number;
}

export interface UsageStats {
  total: number;
  limit: number;
  remaining: number;
  /** "YYYY-MM" of the counted period (UTC). */
  period: string;
  byModel: ModelUsage[];
}

export function computeUsage(
  nodes: Record<string, ConvNode>,
  limit: number = freeCallLimit(),
): UsageStats {
  const now = new Date();
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const counts = new Map<string, number>();
  let total = 0;
  for (const node of Object.values(nodes)) {
    for (const m of node.messages) {
      if (m.role !== "assistant" || !m.modelId) continue;
      if ((m.createdAt || "").slice(0, 7) !== period) continue;
      counts.set(m.modelId, (counts.get(m.modelId) ?? 0) + 1);
      total += 1;
    }
  }
  const byModel = [...counts.entries()]
    .map(([modelId, count]) => ({ modelId, label: modelLabel(getModel(modelId), "interpret"), count }))
    .sort((a, b) => b.count - a.count);
  return { total, limit, remaining: Math.max(0, limit - total), period, byModel };
}
