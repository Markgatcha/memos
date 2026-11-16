export type DocProduct = "Start" | "MemOS" | "UMT" | "Guardian" | "AI Trio";

export type DocEntry = {
  slug: string;
  title: string;
  description: string;
  product: DocProduct;
  keywords?: string[];
};

export const products: {
  id: DocProduct;
  label: string;
  blurb: string;
}[] = [
  {
    id: "Start",
    label: "Start here",
    blurb: "What the trio is and which path to take.",
  },
  {
    id: "MemOS",
    label: "MemOS",
    blurb: "Persistent memory in a SQLite file you own.",
  },
  {
    id: "UMT",
    label: "Universal MCP Toolkit",
    blurb: "One CLI for 28 MCP servers and every harness.",
  },
  {
    id: "Guardian",
    label: "LLM Guardian",
    blurb: "Token folding, cost control, and provider proxies.",
  },
  {
    id: "AI Trio",
    label: "AI Trio",
    blurb: "How the three compose into one local stack.",
  },
];

export const docs: DocEntry[] = [
  {
    slug: "",
    title: "Documentation",
    description:
      "Learn the AI Trio: persistent memory, MCP tooling, and token-cost control for AI agents. Start with a 60-second install, then go as deep as you need.",
    product: "Start",
    keywords: ["overview", "start", "install", "trio", "local-first"],
  },
  {
    slug: "memos",
    title: "MemOS overview",
    description:
      "A local-first memory layer for AI agents. One SQLite file, four surfaces, no cloud account in the core path.",
    product: "MemOS",
    keywords: ["memory", "sqlite", "local-first", "mcp", "sdk"],
  },
  {
    slug: "memos/quickstart",
    title: "MemOS quickstart",
    description:
      "Store a memory, search it, and connect it to your coding agent in under two minutes.",
    product: "MemOS",
    keywords: ["quickstart", "install", "npx", "claude code", "cursor"],
  },
  {
    slug: "memos/concepts",
    title: "Memory model",
    description:
      "Nodes, edges, pools, scopes, trust, time, context packs, consolidation, and deletion.",
    product: "MemOS",
    keywords: ["concepts", "graph", "trust", "temporal", "packs"],
  },
  {
    slug: "memos/harnesses",
    title: "Harnesses and integrations",
    description:
      "Connect MemOS to Claude Code, Cursor, Codex, Gemini CLI, Hermes, OpenClaw, Cline, Zed, Goose, Kilo, pi, OpenCode, Windsurf, and any MCP client.",
    product: "MemOS",
    keywords: ["harness", "claude code", "cursor", "codex", "hermes", "mcp"],
  },
  {
    slug: "memos/ingestion",
    title: "Ingesting notes and documents",
    description:
      "Point MemOS at a folder of Markdown, HTML, or PDF, import ChatGPT and Claude exports, and keep the index current.",
    product: "MemOS",
    keywords: ["ingest", "markdown", "pdf", "obsidian", "watch", "import"],
  },
  {
    slug: "memos/reference",
    title: "CLI, MCP, and HTTP reference",
    description:
      "The commands, tools, and routes you will actually use, with links to the exhaustive generated reference.",
    product: "MemOS",
    keywords: ["cli", "mcp tools", "http api", "reference"],
  },
  {
    slug: "memos/operations",
    title: "Operations and security",
    description:
      "Backups, encryption at rest, tamper evidence, consolidation, health checks, and troubleshooting.",
    product: "MemOS",
    keywords: [
      "operations",
      "security",
      "backup",
      "encrypt",
      "audit",
      "troubleshooting",
    ],
  },
  {
    slug: "memos/benchmarks",
    title: "Benchmarks and methodology",
    description:
      "What MemOS measures, how the retrieval numbers are produced, and why end-to-end scores are reported separately.",
    product: "MemOS",
    keywords: [
      "benchmarks",
      "locomo",
      "longmemeval",
      "convomem",
      "leaderboard",
    ],
  },
  {
    slug: "memos/leaderboard",
    title: "Open benchmark leaderboard",
    description:
      "A reproducible leaderboard with two tracks, mandatory disclosure, and machine-checkable submissions.",
    product: "MemOS",
    keywords: [
      "leaderboard",
      "benchmark",
      "reproducible",
      "judge",
      "submission",
    ],
  },
  {
    slug: "umt",
    title: "UMT overview",
    description:
      "Universal MCP Toolkit: install, connect, and run 28 curated MCP servers across every major coding harness.",
    product: "UMT",
    keywords: ["mcp", "toolkit", "servers", "cli", "install"],
  },
  {
    slug: "umt/servers",
    title: "Server catalog",
    description:
      "The 28 bundled servers, what each one is for, and the environment variable it needs.",
    product: "UMT",
    keywords: ["servers", "github", "notion", "slack", "postgres", "catalog"],
  },
  {
    slug: "umt/cli",
    title: "CLI reference",
    description:
      "list, config, connect, install, run, doctor, status, logs, test, workflow, profile, and the rest.",
    product: "UMT",
    keywords: ["cli", "commands", "umt config", "umt doctor"],
  },
  {
    slug: "umt/config",
    title: "Configuration and transports",
    description:
      "Config shapes for Claude Desktop, Cursor, Claude Code, and the stdio versus HTTP+SSE transport model.",
    product: "UMT",
    keywords: [
      "config",
      "transport",
      "stdio",
      "http",
      "claude desktop",
      "cursor",
    ],
  },
  {
    slug: "umt/registry",
    title: "Registry and discovery",
    description:
      "Search the official MCP Registry and private compatible endpoints alongside local server discovery.",
    product: "UMT",
    keywords: ["registry", "discovery", "mcp registry", "well-known"],
  },
  {
    slug: "guardian",
    title: "Guardian overview",
    description:
      "LLM Guardian: semantic folding, token budgets, and zero-code proxies for Anthropic and OpenAI clients.",
    product: "Guardian",
    keywords: ["guardian", "tokens", "cost", "proxy", "folding"],
  },
  {
    slug: "guardian/folding",
    title: "Semantic folding and sharding",
    description:
      "How Guardian compresses context without dropping facts, and how memory packs from MemOS fit in.",
    product: "Guardian",
    keywords: ["folding", "sharding", "compression", "memory packs", "retain"],
  },
  {
    slug: "guardian/api",
    title: "Proxy and API",
    description:
      "Point any Anthropic or OpenAI client at Guardian, and use the HTTP endpoints directly.",
    product: "Guardian",
    keywords: ["proxy", "api", "openai", "anthropic", "endpoints"],
  },
  {
    slug: "guardian/cli",
    title: "TUI and CLI",
    description:
      "The interactive chat interface, slash commands, one-shot runs, dashboards, and budget controls.",
    product: "Guardian",
    keywords: ["tui", "cli", "slash commands", "dashboard", "budget"],
  },
  {
    slug: "guardian/config",
    title: "Providers and configuration",
    description:
      "OpenRouter, Anthropic, Gemini, local LM Studio, budgets, and the environment variables that control them.",
    product: "Guardian",
    keywords: ["providers", "openrouter", "lm studio", "config", "budget"],
  },
  {
    slug: "trio/architecture",
    title: "How the trio fits together",
    description:
      "Transport, memory, and cost control as one local stack, with the contracts that connect them.",
    product: "AI Trio",
    keywords: ["architecture", "contracts", "umt", "memos", "guardian"],
  },
];

export const sections = products.map((product) => ({
  ...product,
  items: docs.filter((doc) => doc.product === product.id),
}));

export function getDoc(slug: string): DocEntry | undefined {
  return docs.find((doc) => doc.slug === slug);
}

export function getNeighbors(slug: string): {
  previous: DocEntry | undefined;
  next: DocEntry | undefined;
} {
  const index = docs.findIndex((doc) => doc.slug === slug);
  if (index === -1) return { previous: undefined, next: undefined };
  return {
    previous: index > 0 ? docs[index - 1] : undefined,
    next: index < docs.length - 1 ? docs[index + 1] : undefined,
  };
}

export function docHref(slug: string): string {
  return slug ? `/docs/${slug}` : "/docs";
}
