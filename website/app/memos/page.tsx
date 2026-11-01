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
    "Universal, local-first, persistent memory layer for AI agents. Graph-native SQLite storage, temporal validity, trust scoring, and hybrid recall. Free and open source — no subscription, ever.",
  openGraph: {
    title: "MemOS — Persistent Memory for AI Agents",
    description:
      "99.4% LongMemEval Hit@20 on 500 questions. 100% local. Free and open source — no subscription, ever.",
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
  "Confidence score state machine",
  "Compact TOON context packs",
  "MCP adapter (stdio + Streamable HTTP, 2026-07-28)",
  "40 MCP tools · session-start overview · task triggers",
  "Review queue for inferred memories",
  "Source-scoped deletion with proof-of-forgetting",
  "Framework-agnostic (Ollama, LangChain, CrewAI)",
];

const benchmarks = [
  {
    name: "LongMemEval-S · Hit@20",
    memos: "99.4%",
    note: "500 questions · nomic 768d · saturated",
  },
  {
    name: "LoCoMo · Hit@10",
    memos: "65.0%",
    note: "1,986 questions · bge-small · repeatable",
  },
  {
    name: "ConvoMem · Hit@10",
    memos: "91.0%",
    note: "387 questions · all-MiniLM",
  },
  {
    name: "LoCoMo same-protocol · Hit@10",
    memos: "65.6%",
    note: "304 questions · vs Mem0 65.6%",
  },
  {
    name: "End-to-end QA",
    memos: "78.0%",
    note: "50 questions · independent GLM judge",
  },
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
          <h2 className="section-title">Quick start</h2>
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
          <h2 className="section-title">Key features</h2>
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
          <h2 className="section-title">
            Benchmarks — long-horizon recall
          </h2>
          <BenchmarkChart
            title="LoCoMo · adversarial recall @10 · higher is better"
            bars={[
              {
                label: "MemOS",
                value: 62.0,
                display: "62.0%",
                accent: true,
                note: "hybrid recall + trust/provenance filters",
              },
              {
                label: "Mem0",
                value: 45.1,
                display: "45.1%",
                note: "same embedder, same protocol, infer=false",
              },
            ]}
            footnote="Same-protocol run: 304 LoCoMo questions, 2 conversations, identical embedder (nomic-embed-text), no reranker on either side. Overall Hit@10 was a 65.6%–65.6% tie; MemOS leads on adversarial memories by 16.9 points, where trust and provenance filtering matter. One slice, so treat it as a signal with caveats."
          />
          <div className="card overflow-x-auto mt-4">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Benchmark</th>
                  <th className="!text-right">MemOS</th>
                  <th>Protocol</th>
                </tr>
              </thead>
              <tbody>
                {benchmarks.map((b) => (
                  <tr key={b.name}>
                    <td>{b.name}</td>
                    <td className="!text-right text-zinc-100 font-medium tabular-nums">
                      {b.memos}
                    </td>
                    <td className="text-zinc-500 text-xs">{b.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-zinc-600 leading-relaxed">
            Every row traces to a committed artifact or a documented run.
            LongMemEval retrieval is saturated at k=20 (BM25 reaches 99.6%), so
            we do not treat it as a differentiator. The honest comparison is the
            same-protocol LoCoMo slice, where the systems tie overall and
            separate on adversarial cases. See{" "}
            <a
              href="/benchmarks#methodology"
              className="text-zinc-400 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-200"
            >
              the methodology
            </a>
            .
          </p>
        </Reveal>

        <Reveal className="mb-12" delay={160}>
          <h2 className="section-title">
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
                    <th className="!text-right !text-zinc-300">MemOS</th>
                    <th className="!text-right">Mem0 platform</th>
                  </tr>
                </thead>
                <tbody>
                  {pricingRows.map((r) => (
                    <tr key={r.label}>
                      <td className="text-zinc-500">{r.label}</td>
                      <td className="!text-right text-zinc-100 font-medium">
                        <span className="inline-flex items-center gap-1.5 justify-end">
                          <Check size={13} className="text-zinc-100 shrink-0" />
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
