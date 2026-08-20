import { Check, ArrowRight } from "lucide-react";
import type { Metadata } from "next";
import Reveal from "../_components/Reveal";
import PageHeader from "../_components/PageHeader";
import StarButton from "../_components/StarButton";
import ServerGrid, { type ServerEntry } from "../_components/ServerGrid";

export const metadata: Metadata = {
  title: "Universal MCP Toolkit",
  description:
    "28 production-ready MCP servers in one monorepo — transport, registry, and tool routing for AI agents. stdio + HTTP/SSE, health checks, and zero-config local discovery.",
  openGraph: {
    title: "Universal MCP Toolkit — 28 MCP Servers, One CLI",
    description:
      "Transport, registry, and routing for MCP tools. Works with Claude Desktop, Cursor, and any MCP client.",
    images: [{ url: "/og-umt.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    images: [{ url: "/og-umt.png", width: 1200, height: 630 }],
  },
};

const features = [
  "MCP transport: stdio + HTTP/SSE + streamable HTTP",
  "Server registry with health checks",
  "Tool routing across providers",
  "Ollama, LangChain, and CrewAI adapters",
  "Works with any MCP-compatible client",
  "Zero-config local discovery",
];

// Mirrors packages/cli/src/registry.ts — keep in sync when servers ship.
const servers: ServerEntry[] = [
  { id: "github", title: "GitHub", category: "Collaboration", description: "Repository search, pull requests, workflows, and issue triage.", transports: ["stdio", "sse"] },
  { id: "notion", title: "Notion", category: "Collaboration", description: "Search pages and databases, read docs, and publish structured notes.", transports: ["stdio", "sse"] },
  { id: "slack", title: "Slack", category: "Collaboration", description: "Look up channels, fetch threads, and post workspace updates.", transports: ["stdio", "sse"] },
  { id: "linear", title: "Linear", category: "Collaboration", description: "Search issues, inspect workflow state, and create new work items.", transports: ["stdio", "sse"] },
  { id: "jira", title: "Jira", category: "Collaboration", description: "Search issues, inspect tickets, and drive incident triage.", transports: ["stdio", "sse"] },
  { id: "discord", title: "Discord", category: "Collaboration", description: "Guild discovery, channel lookup, message history, and messaging.", transports: ["stdio", "sse"] },
  { id: "trello", title: "Trello", category: "Collaboration", description: "Board and list discovery, card CRUD, and archiving.", transports: ["stdio", "sse"] },
  { id: "notion-mcp", title: "Notion (MCP)", category: "Collaboration", description: "Full Notion workspace integration with search, CRUD on pages and databases.", transports: ["stdio", "sse"] },
  { id: "slack-mcp", title: "Slack (MCP)", category: "Collaboration", description: "Full Slack workspace integration with channels, messages, users, and files.", transports: ["stdio", "sse"] },
  { id: "google-calendar", title: "Google Calendar", category: "Productivity", description: "List calendars, inspect events, and schedule meetings.", transports: ["stdio", "sse"] },
  { id: "google-drive", title: "Google Drive", category: "Productivity", description: "Search Drive, inspect document metadata, and export files.", transports: ["stdio", "sse"] },
  { id: "spotify", title: "Spotify", category: "Media & Commerce", description: "Search tracks, inspect playback, and curate playlists.", transports: ["stdio", "sse"] },
  { id: "stripe", title: "Stripe", category: "Media & Commerce", description: "Inspect billing state, customers, invoices, and subscriptions.", transports: ["stdio", "sse"] },
  { id: "postgresql", title: "PostgreSQL", category: "Data", description: "Inspect schemas and run guarded SQL queries.", transports: ["stdio", "sse"] },
  { id: "mongodb", title: "MongoDB", category: "Data", description: "Explore collections and run filtered document queries.", transports: ["stdio", "sse"] },
  { id: "redis", title: "Redis", category: "Data", description: "Inspect keys, TTLs, and runtime cache diagnostics.", transports: ["stdio", "sse"] },
  { id: "supabase", title: "Supabase", category: "Data", description: "Query tables, storage, and operational project metadata.", transports: ["stdio", "sse"] },
  { id: "airtable", title: "Airtable", category: "Data", description: "Table listing, record CRUD, and filtering for Airtable bases.", transports: ["stdio", "sse"] },
  { id: "vercel", title: "Vercel", category: "Platform", description: "Track projects, deployments, and environment settings.", transports: ["stdio", "sse"] },
  { id: "cloudflare-workers", title: "Cloudflare Workers", category: "Platform", description: "Inspect workers, routes, and edge rollout state.", transports: ["stdio", "sse"] },
  { id: "docker", title: "Docker", category: "Platform", description: "Inspect containers, images, and daemon state.", transports: ["stdio", "sse"] },
  { id: "npm-registry", title: "NPM Registry", category: "Platform", description: "Search packages, inspect versions, and review release metadata.", transports: ["stdio", "sse"] },
  { id: "hackernews", title: "Hacker News", category: "Research", description: "Search trends, fetch top stories, and inspect discussion threads.", transports: ["stdio", "sse"] },
  { id: "arxiv", title: "arXiv", category: "Research", description: "Search papers and build compact literature digests.", transports: ["stdio", "sse"] },
  { id: "filesystem", title: "FileSystem", category: "Local", description: "Read and write files safely inside explicitly allowed roots.", transports: ["stdio", "sse"] },
  { id: "memos", title: "MemOS", category: "Memory", description: "Local-first persistent memory over MCP, backed by a MemOS SQLite database.", transports: ["stdio"] },
  { id: "playwright-mcp", title: "Playwright (MCP)", category: "Automation", description: "Browser automation and web scraping with Playwright.", transports: ["stdio", "sse"] },
  { id: "openai-mcp", title: "OpenAI (MCP)", category: "AI", description: "OpenAI/Codex API integration with chat, completion, embedding, and more.", transports: ["stdio", "sse"] },
];

export default function UMT() {
  return (
    <main className="min-h-screen">
      <div className="max-w-4xl mx-auto px-6 py-16 md:py-20">
        <PageHeader
          kicker="mcp toolkit"
          title="Universal MCP Toolkit"
          subtitle="28 production-ready MCP servers in one monorepo — transport, registry, and tool routing for AI agents. Works with MemOS, Claude Desktop, Cursor, and any MCP-compatible client."
        />

        <Reveal className="mb-12">
          <h2 className="text-sm font-medium text-zinc-200 mb-4">Quick start</h2>
          <div className="window">
            <div className="window-bar">
              <span className="window-dot" />
              <span className="window-dot" />
              <span className="window-dot" />
              <span className="window-title">terminal</span>
            </div>
            <div className="p-5 font-mono text-[13px] leading-7">
              <div>
                <span className="text-zinc-600 select-none">$ </span>
                <span className="text-zinc-100">npx universal-mcp-toolkit list</span>
              </div>
              <div>
                <span className="text-zinc-600 select-none">$ </span>
                <span className="text-zinc-100">npx universal-mcp-toolkit install</span>
              </div>
              <div>
                <span className="text-zinc-600 select-none">$ </span>
                <span className="text-zinc-100">
                  npx universal-mcp-toolkit config --server github slack --target claude-desktop
                </span>
              </div>
            </div>
          </div>
        </Reveal>

        <Reveal className="mb-12" delay={80}>
          <h2 className="text-sm font-medium text-zinc-200 mb-4">Key features</h2>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
            {features.map((f) => (
              <li key={f} className="flex items-start gap-2.5 text-sm text-zinc-400">
                <Check size={15} className="text-zinc-500 mt-0.5 shrink-0" />
                {f}
              </li>
            ))}
          </ul>
        </Reveal>

        <Reveal className="mb-12" delay={120}>
          <h2 className="text-sm font-medium text-zinc-200 mb-1">
            The server registry
          </h2>
          <p className="text-sm text-zinc-500 mb-5">
            Every server below ships in the monorepo. Search, filter by
            category, or hit the copy button to grab a ready-to-paste MCP
            config snippet.
          </p>
          <ServerGrid servers={servers} />
        </Reveal>

        <Reveal delay={160}>
          <div className="flex flex-wrap gap-3">
            <a href="/docs" className="btn btn-primary">
              Read the docs
              <ArrowRight size={15} />
            </a>
            <StarButton repo="Markgatcha/universal-mcp-toolkit" label="Star on GitHub" />
          </div>
        </Reveal>
      </div>
    </main>
  );
}
