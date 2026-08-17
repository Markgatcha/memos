import type { MetadataRoute } from "next";

// Required for `output: "export"` — metadata routes are dynamic by default.
export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
    },
    sitemap: "https://context-core.dev/sitemap.xml",
  };
}
