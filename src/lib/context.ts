import type { BuiltContext } from "./tree";

/**
 * Rough token estimate (~4 chars/token). Not exact, but good enough to decide
 * when a conversation is approaching a model's context window and should be
 * auto-compacted. Providers report exact usage after the fact; this is the
 * cheap pre-flight gauge.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Estimated input tokens for an assembled context (system + all turns). */
export function contextTokens(ctx: BuiltContext): number {
  let chars = ctx.system.length;
  for (const m of ctx.messages) chars += m.content.length + 8; // small per-turn overhead
  return Math.ceil(chars / 4);
}

/** Fraction of the window we let the input fill before auto-compacting. */
export const COMPACT_THRESHOLD = 0.8;

/**
 * True when the estimated input plus the reserved output would exceed the
 * usable fraction of the model's context window.
 */
export function needsCompaction(
  inputTokens: number,
  contextWindow: number,
  outputReserve: number,
): boolean {
  if (!contextWindow || contextWindow <= 0) return false;
  return inputTokens + outputReserve > contextWindow * COMPACT_THRESHOLD;
}
