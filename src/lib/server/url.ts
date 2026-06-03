import { headers } from "next/headers";
import { SITE_URL } from "@/lib/constants";

/**
 * Absolute base URL for the *current request*, host-aware so each domain serves
 * its own absolute URLs (used by robots.ts and sitemap.ts). Falls back to the
 * canonical SITE_URL when no host header is present. Server-only.
 */
export async function requestBaseUrl(): Promise<string> {
  const host = (await headers()).get("host");
  return host ? `https://${host}` : SITE_URL;
}
