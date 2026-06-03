/**
 * App-wide constants, consolidated so each value lives in exactly one place.
 * Anything that was a repeated string/number literal across files (localStorage
 * keys, the canonical site URL, token + quota limits) belongs here.
 */

/** localStorage key for the persisted Zustand store (warm-start cache). */
export const STORE_NAME = "properchat-store";

/** localStorage key for the saved theme preference. Mirrored by ThemeScript. */
export const THEME_KEY = "properchat-theme";

/** Output-token bounds for a single turn: UI control range, server clamp, default. */
export const MIN_OUTPUT_TOKENS = 256;
export const DEFAULT_OUTPUT_TOKENS = 4096;
export const MAX_OUTPUT_TOKENS = 64_000;

/** Default monthly call count shown in the local usage view when no env
 * override is set. The local view is informational only (no enforcement). */
export const DEFAULT_FREE_CALL_LIMIT = 100;

/** Thread panel width (desktop), resizable by dragging its left edge. Stored
 * per-user in settings.threadWidth; these are the bounds + default. */
export const THREAD_WIDTH_MIN = 320;
export const THREAD_WIDTH_MAX = 760;
export const THREAD_WIDTH_DEFAULT = 440;

/** Canonical production origin; an env override wins. Used for SEO/metadata. */
export const FALLBACK_SITE_URL = "https://www.properchats.ai";
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || FALLBACK_SITE_URL;
