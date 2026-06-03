import { detectModality } from "./modalities";
import type { MediaAttachment } from "./types";

/**
 * The descriptor we attach to a message and that IAI tags onto the OTel span -
 * never the bytes. `uri` is an `s3://` reference once the bytes live in the IAI
 * -data- bucket, or a `data:` URL fallback when storage is unavailable (so
 * inference still works immediately). Canonical shape is `MediaAttachment`.
 */
export type MediaDescriptor = MediaAttachment;

// Cap for the inline data: URL fallback (keeps request bodies sane).
const MAX_INLINE_BYTES = 20 * 1024 * 1024;

/** Lowercase-hex SHA-256 of bytes (content address; matches the IAI presign key). */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToDataUrl(bytes: ArrayBuffer, mime: string): string {
  const arr = new Uint8Array(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    binary += String.fromCharCode(...arr.subarray(i, i + chunk));
  }
  return `data:${mime || "application/octet-stream"};base64,${btoa(binary)}`;
}

/**
 * Content-address a file, ask our proxy for a presigned PUT into the IAI -data-
 * bucket, PUT the bytes directly to S3 (they never traverse our server), and
 * return a MediaDescriptor. Falls back to an inline data: URL when storage is
 * disabled/unavailable so attachments still reach the model.
 */
export async function uploadFile(file: File): Promise<MediaDescriptor> {
  const bytes = await file.arrayBuffer();
  const sha256 = await sha256Hex(bytes);
  const mime = file.type || "application/octet-stream";
  const modality = detectModality({ type: file.type, name: file.name });

  try {
    const res = await fetch("/api/media/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha256, content_type: mime, size_bytes: file.size }),
    });
    if (res.ok) {
      const d = (await res.json()) as {
        uri?: string;
        presigned_put_url?: string | null;
        deduped?: boolean;
        required_headers?: Record<string, string>;
      };
      if (d.uri) {
        if (!d.deduped && d.presigned_put_url) {
          await fetch(d.presigned_put_url, {
            method: "PUT",
            headers: d.required_headers ?? { "Content-Type": mime },
            body: bytes,
          });
        }
        return { uri: d.uri, modality, mime, size: file.size, sha256 };
      }
    }
  } catch {
    /* fall through to the inline fallback */
  }

  const uri = file.size <= MAX_INLINE_BYTES ? bytesToDataUrl(bytes, mime) : "";
  return { uri, modality, mime, size: file.size, sha256 };
}
