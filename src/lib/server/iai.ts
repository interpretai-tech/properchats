/**
 * Server-side client for the InterpretAI (IAI) HTTP API beyond plain inference.
 *
 * Every call is defensive: any non-2xx resolves to null so the app degrades
 * gracefully (the caller falls back to an inline data: URL) and never crashes a
 * request.
 */

const BASE =
  process.env.INTERPRET_API_BASE?.replace(/\/$/, "") || "https://staging.interpretai.tech";

function authHeaders(credential: string): HeadersInit {
  return { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" };
}

export interface PresignResult {
  /** s3://... content-addressed URI for the (to-be) stored object. */
  uri: string;
  /** Presigned PUT URL, or null when the object already exists (deduped). */
  presigned_put_url: string | null;
  deduped: boolean;
  /** Headers that must be sent verbatim on the PUT (Content-Type is signed). */
  required_headers: Record<string, string>;
}

/**
 * Mint a presigned S3 PUT via the generic, content-addressed cloud route
 * (POST /api/v1/cloud/aws/s3/presigned-put), so the browser can PUT media bytes
 * straight to storage. Returns null on any non-2xx so callers degrade to an
 * inline data: URL.
 */
export async function presignMediaPut(
  credential: string,
  body: { sha256: string; content_type: string; size_bytes: number },
): Promise<PresignResult | null> {
  try {
    const res = await fetch(`${BASE}/api/v1/cloud/aws/s3/presigned-put`, {
      method: "POST",
      headers: authHeaders(credential),
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as Partial<PresignResult>;
    if (!d.uri) return null;
    return {
      uri: d.uri,
      presigned_put_url: d.presigned_put_url ?? null,
      deduped: Boolean(d.deduped),
      required_headers: d.required_headers ?? {},
    };
  } catch {
    return null;
  }
}
