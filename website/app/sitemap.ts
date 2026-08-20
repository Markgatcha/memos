import type { MetadataRoute } from "next";

// Required for `output: "export"` — metadata routes are dynamic by default.
export const dynamic = "force-static";

const BASE = "https://context-core.dev";

const pages = [
  "",
  "memos",
  "umt",
  "guardian",
  "docs",
  "docs/architecture",
  "benchmarks",
  "blog",
  "support",
  "compare/memos-vs-mem0",
  "compare/umt-vs-mcp-get-supergateway",
];

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return pages.map((slug) => ({
    url: slug ? `${BASE}/${slug}/` : `${BASE}/`,
    lastModified,
    changeFrequency: "weekly",
    priority: slug === "" ? 1 : 0.7,
  }));
}
