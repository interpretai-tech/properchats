import type { MetadataRoute } from "next";
import { requestBaseUrl } from "@/lib/server/url";

// Host-aware so each domain (properchats.ai / branchchat.ai, with or without
// www) serves a sitemap full of its OWN absolute URLs. Marked dynamic because
// it reads the incoming request host.
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = await requestBaseUrl();
  // Computed per request, not at module scope.
  const lastModified = new Date();

  return [
    {
      url: `${base}/`,
      lastModified,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${base}/viz`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${base}/showcase`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.6,
    },
  ];
}
