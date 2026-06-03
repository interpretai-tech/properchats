import type { StreamEvent } from "./types";

const encoder = new TextEncoder();

/** Encode one event as an SSE `data:` frame. */
export function sseFrame(event: StreamEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

/** Standard SSE response headers (disable proxy buffering so chunks flush). */
export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

/**
 * Build a streaming Response from an async generator of events. Errors thrown
 * by the generator are surfaced as a final `error` event rather than tearing
 * down the stream, so the client always gets a clean terminal signal.
 */
export function streamEvents(gen: AsyncGenerator<StreamEvent>): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const ev of gen) controller.enqueue(sseFrame(ev));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(sseFrame({ type: "error", error: msg }));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

/**
 * Read an SSE response body and invoke `onEvent` for each parsed `data:` frame.
 * Works with our unified protocol and tolerates multi-line frames.
 */
export async function readSSE(
  res: Response,
  onEvent: (ev: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!res.body) throw new Error("No response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flush = (chunk: string) => {
    const frames = chunk.split(/\n\n/);
    for (const frame of frames) {
      const dataLines = frame
        .split(/\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      if (!dataLines.length) continue;
      const payload = dataLines.join("\n");
      if (!payload || payload === "[DONE]") continue;
      try {
        onEvent(JSON.parse(payload) as StreamEvent);
      } catch {
        /* ignore non-JSON keepalives */
      }
    }
  };

  while (true) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      throw new DOMException("Aborted", "AbortError");
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lastSep = buffer.lastIndexOf("\n\n");
    if (lastSep !== -1) {
      flush(buffer.slice(0, lastSep));
      buffer = buffer.slice(lastSep + 2);
    }
  }
  if (buffer.trim()) flush(buffer);
}
