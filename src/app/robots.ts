import type { MetadataRoute } from "next";
import { requestBaseUrl } from "@/lib/server/url";

// Host-aware so the Sitemap line points at the requesting domain's own
// sitemap. Marked dynamic because it reads the incoming request host.
export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const base = await requestBaseUrl();

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: "/api/",
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
