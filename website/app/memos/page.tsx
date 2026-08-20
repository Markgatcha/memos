import { Check, ArrowRight, X } from "lucide-react";
import type { Metadata } from "next";
import GithubIcon from "../_components/GithubIcon";
import Reveal from "../_components/Reveal";
import PageHeader from "../_components/PageHeader";
import BenchmarkChart from "../_components/BenchmarkChart";
import StarButton from "../_components/StarButton";

export const metadata: Metadata = {
  title: "MemOS — Persistent Memory",
  description:
    "Universal, local-first, persistent memory layer for AI agents. Graph-native SQLite storage, temporal validity, trust scoring, and 77.6% token savings. Free and open source — no subscription, ever.",
  openGraph: {
    title: "MemOS — Persistent Memory for AI Agents",
    description:
      "95.9% recall on BEAM-1M. 100% local. Free and open source — no subscription, ever.",
    images: [{ url: "/og-memos.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    images: [{ url: "/og-memos.png", width: 1200, height: 630 }],
  },
};

const features = [
  "100% local SQLite-backed storage (no cloud)",
  "Graph-native with typed edges",
  "Temporal validity (validFrom/validTo)",
  "Trust scoring & provenance tracking",
  "Compact TOON format (77.6% token savings)",
  "Confidence score state machine",
  "MCP adapter (stdio + HTTP+SSE)",
  "Framework-agnostic (Ollama, LangChain, CrewAI)",
];

const benchmarks = [
  { name: "BEAM-1M (recall @10)", memos: "95.9%", mem0: "64.1%", win: true },
  { name: "BEAM-1M · temporal reasoning", memos: "97.1%", mem0: "16.3%", win: true },
  { name: "BEAM-1M · contradiction resolution", memos: "88.6%", mem0: "35.7%", win: true },
  { name: "LoCoMo", memos: "92.5", mem0: "92.5", win: false },
  { name: "LongMemEval", memos: "94.4", mem0: "94.4", win: false },
];

const pricingRows = [
  { label: "Price", memos: "Free. Forever.", mem0: "Free tier capped · $19–$249/mo after" },
  { label: "Source code", memos: "100% open source (MIT)", mem0: "Open core — platform is proprietary" },
  { label: "Your data", memos: "SQLite file on your disk", mem0: "Hosted in their cloud" },
  { label: "API keys / account", memos: "None required", mem0: "Account + API key required" },
  { label: "Modify & self-host", memos: "Fork it, change it, ship it", mem0: "Not available on the platform" },
  { label: "Graph memory", memos: "Included, free", mem0: "Pro plan ($249/mo) only" },
];

export default function MemOSPage() {
  return (
    <main className="min-h-screen">
      <div className="max-w-4xl mx-auto px-6 py-16 md:py-20">
        <PageHeader
          kicker="persistent memory"
          title="MemOS"
          subtitle="Universal, local-first, persistent memory layer for AI agents. Give any LLM a memory that survives restarts — no cloud, no API keys, no vendor lock-in, and no subscription."
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
                <span className="text-zinc-100">npm install @mem-os/sdk</span>
              </div>
              <div>
                <span className="text-zinc-600 select-none">$ </span>
                <span className="text-zinc-100">npx memos init</span>
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
          <h2 className="text-sm font-medium text-zinc-200 mb-4">
            Benchmarks — long-horizon recall
          </h2>
          <BenchmarkChart
            title="BEAM-1M · recall @10 · higher is better"
            bars={[
              {
                label: "MemOS",
                value: 95.9,
                display: "95.9%",
                accent: true,
                note: "local SQLite + Gemma-300M embeddings · zero cloud",
              },
              {
                label: "Mem0",
                value: 64.1,
                display: "64.1%",
                note: "hosted platform, default settings",
              },
            ]}
            footnote="On BEAM-1M — a million-token, months-long conversation history — MemOS recalls 31.8 points more than Mem0, while running entirely on your machine. On LoCoMo and LongMemEval the two are at parity, which is the point: you don't pay a quality tax for going local."
          />
          <div className="card overflow-hidden mt-4">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Benchmark</th>
                  <th className="!text-right">MemOS</th>
                  <th className="!text-right">Mem0</th>
                </tr>
              </thead>
              <tbody>
                {benchmarks.map((b) => (
                  <tr key={b.name}>
                    <td>{b.name}</td>
                    <td className="!text-right text-zinc-100 font-medium tabular-nums">
                      {b.memos}
                    </td>
                    <td className="!text-right text-zinc-600 tabular-nums">
                      {b.mem0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-zinc-600 leading-relaxed">
            Ties on LoCoMo and LongMemEval are honest ties — shorter-horizon
            benchmarks where both systems retrieve well. The gap opens up at
            production scale (BEAM-1M), where temporal validity and trust
            scoring start to matter.
          </p>
        </Reveal>

        <Reveal className="mb-12" delay={160}>
          <h2 className="text-sm font-medium text-zinc-200 mb-4">
            Free and open source — actually
          </h2>
          <div className="card p-6 md:p-7">
            <p className="text-sm text-zinc-400 leading-relaxed mb-6 max-w-2xl">
              MemOS is MIT-licensed and completely free — to use, to modify, to
              self-host, to ship in your product. There is no hosted platform,
              no usage metering, and no paid tier hiding the good features.
              Mem0&apos;s platform, by contrast, starts at $19/month and charges
              $249/month for graph memory — the kind of feature MemOS includes
              by default.
            </p>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th></th>
                    <th className="!text-right !text-emerald-400/90">MemOS</th>
                    <th className="!text-right">Mem0 platform</th>
                  </tr>
                </thead>
                <tbody>
                  {pricingRows.map((r) => (
                    <tr key={r.label}>
                      <td className="text-zinc-500">{r.label}</td>
                      <td className="!text-right text-zinc-100 font-medium">
                        <span className="inline-flex items-center gap-1.5 justify-end">
                          <Check size={13} className="text-emerald-500 shrink-0" />
                          {r.memos}
                        </span>
                      </td>
                      <td className="!text-right text-zinc-500">
                        <span className="inline-flex items-center gap-1.5 justify-end">
                          <X size={13} className="text-zinc-600 shrink-0" />
                          {r.mem0}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-xs text-zinc-600">
              Mem0 pricing as published on mem0.ai/pricing (Hobby free with
              request caps, Starter $19/mo, Pro $249/mo, Enterprise custom).
              Mem0&apos;s open-source library exists too — but the platform most
              people use is the paid one, and your memories live in their cloud.
            </p>
          </div>
        </Reveal>

        <Reveal delay={200}>
          <div className="flex flex-wrap gap-3">
            <a href="/docs" className="btn btn-primary">
              Read the docs
              <ArrowRight size={15} />
            </a>
            <StarButton repo="Markgatcha/memos" label="Star on GitHub" />
          </div>
        </Reveal>
      </div>
    </main>
  );
}
