import type { NextRequest } from "next/server";
import type { Provider } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Best-effort detection of a model's real input context window by asking each
 * provider's models API. Only Gemini reliably exposes it (`inputTokenLimit`);
 * Anthropic/OpenAI models endpoints do not currently return a window, so we
 * parse it if present and otherwise echo the client's curated `fallback`. The
 * client caches whatever we return and uses it to drive auto-compaction.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ window: 0, source: "error" }, { status: 400 });
  }

  const provider = body.provider as Provider;
  const model = typeof body.model === "string" ? body.model : "";
  const enc = encodeURIComponent(model);
  const fallback = typeof body.fallback === "number" && body.fallback > 0 ? body.fallback : 0;
  const keys = (body.keys ?? {}) as Record<string, string | undefined>;
  const clientKey = (k: string) => (typeof keys[k] === "string" && keys[k]?.trim() ? keys[k]!.trim() : undefined);

  // Detection only uses a client-supplied key. Without one we just echo the
  // curated catalog window, so this best-effort lookup never spends a key the
  // caller didn't provide.
  const respond = (window: number, source: string) => Response.json({ window, source });

  try {
    if (provider === "gemini") {
      const key = clientKey("gemini");
      if (key && model) {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${enc}?key=${key}`,
          { cache: "no-store" },
        );
        if (r.ok) {
          const d = (await r.json()) as { inputTokenLimit?: number };
          if (typeof d.inputTokenLimit === "number" && d.inputTokenLimit > 0) {
            return respond(d.inputTokenLimit, "api");
          }
        }
      }
    } else if (provider === "anthropic") {
      const key = clientKey("anthropic");
      if (key && model) {
        const r = await fetch(`https://api.anthropic.com/v1/models/${enc}`, {
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
          cache: "no-store",
        });
        if (r.ok) {
          const d = (await r.json()) as { context_window?: number; max_input_tokens?: number };
          const w = d.context_window ?? d.max_input_tokens;
          if (typeof w === "number" && w > 0) return respond(w, "api");
        }
      }
    } else if (provider === "openai") {
      const key = clientKey("openai");
      if (key && model) {
        const r = await fetch(`https://api.openai.com/v1/models/${enc}`, {
          headers: { Authorization: `Bearer ${key}` },
          cache: "no-store",
        });
        if (r.ok) {
          const d = (await r.json()) as { context_window?: number };
          if (typeof d.context_window === "number" && d.context_window > 0) {
            return respond(d.context_window, "api");
          }
        }
      }
    }
  } catch {
    /* fall through to the curated fallback */
  }

  return respond(fallback, "catalog");
}
