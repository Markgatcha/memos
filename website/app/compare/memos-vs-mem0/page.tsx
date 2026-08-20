import { ArrowRight } from "lucide-react";
import type { Metadata } from "next";
import Reveal from "../../_components/Reveal";
import PageHeader from "../../_components/PageHeader";
import StarButton from "../../_components/StarButton";

export const metadata: Metadata = {
  title: "MemOS vs Mem0 vs Zep vs Letta",
  description:
    "An honest comparison of AI agent memory layers: MemOS, Mem0, Zep, and Letta — architecture, pricing, self-hosting, and benchmark results.",
  openGraph: {
    title: "MemOS vs Mem0 vs Zep vs Letta — Memory Layer Comparison",
    description:
      "Local-first vs hosted memory for AI agents. Architecture, pricing, and benchmarks side by side.",
    images: [{ url: "/og-compare-memory.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    images: [{ url: "/og-compare-memory.png", width: 1200, height: 630 }],
  },
};

const rows = [
  {
    label: "Where your data lives",
    memos: "SQLite file on your machine",
    mem0: "Hosted cloud (platform) or self-managed (OSS library)",
    zep: "Hosted cloud, or community edition self-hosted",
    letta: "Self-hosted server (Postgres-backed)",
  },
  {
    label: "Price",
    memos: "Free — MIT, no paid tier",
    mem0: "Free tier capped; $19–$249/mo platform plans",
    zep: "Free tier; paid plans for scale",
    letta: "Open source; managed cloud available",
  },
  {
    label: "Memory model",
    memos: "Graph-native, temporal validity, trust scoring",
    mem0: "Fact extraction + graph memory (Pro plan)",
    zep: "Temporal knowledge graph",
    letta: "Memory blocks + archival storage (MemGPT)",
  },
  {
    label: "API keys / account",
    memos: "None",
    mem0: "Account + API key for the platform",
    zep: "Account + API key for the cloud",
    letta: "None for self-hosted",
  },
  {
    label: "Embeddings",
    memos: "Local (Gemma-300M) by default",
    mem0: "Provider-hosted",
    zep: "Provider-hosted",
    letta: "Configurable",
  },
  {
    label: "MCP integration",
    memos: "Built-in adapter (stdio + HTTP/SSE)",
    mem0: "Via integrations",
    zep: "Via integrations",
    letta: "Agent-server centric",
  },
  {
    label: "BEAM-1M recall @10",
    memos: "95.9%",
    mem0: "64.1%",
    zep: "not published on BEAM-1M",
    letta: "not published on BEAM-1M",
  },
];

export default function CompareMemory() {
  return (
    <main className="min-h-screen">
      <div className="max-w-5xl mx-auto px-6 py-16 md:py-20">
        <PageHeader
          kicker="comparison"
          title="MemOS vs Mem0 vs Zep vs Letta"
          subtitle="Four ways to give an AI agent a memory. This page is written by the MemOS team, so salt accordingly — but the numbers are reproducible from the repo, and we note where competitors don't publish."
        />

        <Reveal className="mb-12">
          <div className="card overflow-hidden overflow-x-auto">
            <table className="data-table min-w-[760px]">
              <thead>
                <tr>
                  <th></th>
                  <th className="!text-emerald-400/90">MemOS</th>
                  <th>Mem0</th>
                  <th>Zep</th>
                  <th>Letta</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.label}>
                    <td className="text-zinc-500 whitespace-nowrap">{r.label}</td>
                    <td className="text-zinc-100 font-medium">{r.memos}</td>
                    <td>{r.mem0}</td>
                    <td>{r.zep}</td>
                    <td>{r.letta}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-zinc-600 leading-relaxed">
            Pricing and feature details as published on each project&apos;s
            website, August 2026. Mem0 and Zep also publish open-source
            components; the comparison above covers the hosted platforms most
            teams actually run.
          </p>
        </Reveal>

        <Reveal className="mb-12" delay={80}>
          <h2 className="text-sm font-medium text-zinc-200 mb-4">
            When to pick what
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="card p-6">
              <h3 className="text-sm font-medium text-zinc-100 mb-2">Pick MemOS when…</h3>
              <p className="text-[13px] text-zinc-500 leading-relaxed">
                You want memory that never leaves the machine, no account or
                API key, long-horizon recall at production scale, and the
                freedom to modify the storage layer itself.
              </p>
            </div>
            <div className="card p-6">
              <h3 className="text-sm font-medium text-zinc-100 mb-2">Pick a hosted service when…</h3>
              <p className="text-[13px] text-zinc-500 leading-relaxed">
                You need managed infrastructure across a team, don&apos;t want
                to run anything yourself, and the per-month cost is worth the
                zero-ops trade-off.
              </p>
            </div>
          </div>
        </Reveal>

        <Reveal delay={120}>
          <div className="flex flex-wrap gap-3">
            <a href="/memos" className="btn btn-primary">
              Explore MemOS
              <ArrowRight size={15} />
            </a>
            <a href="/benchmarks" className="btn btn-secondary">
              See the benchmarks
            </a>
            <StarButton repo="Markgatcha/memos" label="Star on GitHub" />
          </div>
        </Reveal>
      </div>
    </main>
  );
}
