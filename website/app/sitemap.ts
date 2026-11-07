import type { MetadataRoute } from "next";
import { docs } from "@/lib/docs";

// Required for `output: "export"` — metadata routes are dynamic by default.
export const dynamic = "force-static";

const BASE = "https://context-core.dev";

const pages = [
  "",
  "memos",
  "umt",
  "guardian",
  "playground",
  "playground/memory",
  "docs",
  "docs/architecture",
  "docs/install",
  "benchmarks",
  "blogs",
  "blogs/beating-supermemory-longmemeval",
  "blogs/ai-memory-landscape-2026",
  "blogs/benchmarks-honestly-explained",
  "blogs/rag-is-not-memory",
  "blogs/add-only-memory",
  "changelog",
  "privacy",
  "terms",
  "security",
  "support",
  "compare/memos-vs-mem0",
  "compare/umt-vs-mcp-get-supergateway",
  ...docs.filter((doc) => doc.slug).map((doc) => `docs/${doc.slug}`),
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
