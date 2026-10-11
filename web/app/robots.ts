import type { MetadataRoute } from "next";

// Crawlers may fetch pages (link-preview fetchers need to), but every page says noindex.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/" } };
}
