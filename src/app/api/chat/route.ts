import type { NextRequest } from "next/server";
import { CAPABILITY_IDS } from "@/lib/capabilities";
import { DEFAULT_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS } from "@/lib/constants";
import { PROVIDER_ORDER } from "@/lib/models";
import { dispatch, type DispatchInput } from "@/lib/server/providers";
import { clientIp, rateLimit } from "@/lib/server/rateLimit";
import { streamEvents } from "@/lib/sse";
import type { Capability, Provider, Route } from "@/lib/types";

/** Burst backstop for the chat proxy: requests per window, per IP. */
const CHAT_BURST_LIMIT = Number(process.env.CHAT_BURST_LIMIT) || 30;
const CHAT_BURST_WINDOW_MS = 60_000;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Capability turns (esp. deep research) can run long; ask the platform for headroom.
export const maxDuration = 300;

interface RawMsg {
  role?: unknown;
  content?: unknown;
  image_urls?: unknown;
  documents?: unknown;
}

type ChatDocument = { url: string; mime: string };
type NormMsg = {
  role: "user" | "assistant";
  content: string;
  image_urls?: string[];
  documents?: ChatDocument[];
};

/**
 * Sanitize a `documents` array: keep only entries with a forwardable URL (a
 * `data:` base64 URL or an http(s) URL); default a missing mime to PDF. (No
 * `s3://` hydration here — the open-source app forwards documents the browser
 * already produced as data:/remote URLs that providers can read directly.)
 */
function cleanDocuments(raw: unknown): ChatDocument[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[])
    .filter((d) => d && typeof d.url === "string" && /^(data:|https?:\/\/)/i.test(d.url as string))
    .map((d) => ({
      url: d.url as string,
      mime: typeof d.mime === "string" && d.mime ? (d.mime as string) : "application/pdf",
    }));
}

/**
 * Make a message list safe for every provider: keep only user/assistant turns
 * with real text OR attached media, drop leading assistant turns, and merge
 * consecutive same-role turns (Anthropic rejects both). Preserves `image_urls`
 * and `documents`. Harmless for OpenAI/Gemini/interpret.
 */
function normalizeMessages(raw: unknown): NormMsg[] {
  if (!Array.isArray(raw)) return [];
  const cleaned = (raw as RawMsg[])
    .filter((m) => m?.role === "user" || m?.role === "assistant")
    .map((m) => {
      const content = typeof m.content === "string" ? m.content : "";
      const image_urls = Array.isArray(m.image_urls)
        ? (m.image_urls as unknown[]).filter((u): u is string => typeof u === "string" && !!u)
        : [];
      const documents = cleanDocuments(m.documents);
      return { role: m.role as "user" | "assistant", content, image_urls, documents };
    })
    .filter((m) => m.content.trim().length > 0 || m.image_urls.length > 0 || m.documents.length > 0);

  while (cleaned.length && cleaned[0].role === "assistant") cleaned.shift();

  const merged: {
    role: "user" | "assistant";
    content: string;
    image_urls: string[];
    documents: ChatDocument[];
  }[] = [];
  for (const m of cleaned) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      if (m.content) last.content = last.content ? `${last.content}\n\n${m.content}` : m.content;
      if (m.image_urls.length) last.image_urls = [...last.image_urls, ...m.image_urls];
      if (m.documents.length) last.documents = [...last.documents, ...m.documents];
    } else {
      merged.push({
        role: m.role,
        content: m.content,
        image_urls: [...m.image_urls],
        documents: [...m.documents],
      });
    }
  }
  return merged.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.image_urls.length ? { image_urls: m.image_urls } : {}),
    ...(m.documents.length ? { documents: m.documents } : {}),
  }));
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const model = typeof body.model === "string" ? body.model : "";
  if (!model) return new Response("Missing model", { status: 400 });

  const messages = normalizeMessages(body.messages);
  if (!messages.length) return new Response("No messages", { status: 400 });

  const rawKeys = (body.keys ?? {}) as Record<string, unknown>;
  const pickKey = (k: string) =>
    typeof rawKeys[k] === "string" && (rawKeys[k] as string).trim()
      ? (rawKeys[k] as string).trim()
      : undefined;

  const maxTokens =
    typeof body.maxTokens === "number" && body.maxTokens > 0
      ? Math.min(Math.floor(body.maxTokens), MAX_OUTPUT_TOKENS)
      : DEFAULT_OUTPUT_TOKENS;

  const capability = CAPABILITY_IDS.includes(body.capability as Capability)
    ? (body.capability as Capability)
    : "chat";

  const input: DispatchInput = {
    route: (body.route === "direct" ? "direct" : "interpret") as Route,
    provider: PROVIDER_ORDER.includes(body.provider as Provider)
      ? (body.provider as Provider)
      : "gemini",
    model,
    system: typeof body.system === "string" ? body.system : "",
    messages,
    maxTokens,
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    thinkingBudget:
      typeof body.thinkingBudget === "number" && Number.isFinite(body.thinkingBudget)
        ? Math.trunc(body.thinkingBudget)
        : undefined,
    capability,
    keys: {
      interpret: pickKey("interpret"),
      anthropic: pickKey("anthropic"),
      openai: pickKey("openai"),
      gemini: pickKey("gemini"),
    },
  };

  // Coarse per-IP burst guard so a public deployment can't be trivially flooded.
  const rl = rateLimit(`chat:ip:${clientIp(req)}`, CHAT_BURST_LIMIT, CHAT_BURST_WINDOW_MS);
  if (!rl.ok) {
    return Response.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  // When no interpret key is supplied (BYO or via Settings), fall back to the
  // optional shared INTERPRETAI_API_KEY env so a self-hosted deployment can ship
  // a default key. Direct provider turns use the matching server key the same way.
  return streamEvents(dispatch(input));
}
