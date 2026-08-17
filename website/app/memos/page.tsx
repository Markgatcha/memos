import { Check, ArrowRight } from "lucide-react";
import type { Metadata } from "next";
import GithubIcon from "../_components/GithubIcon";
import Reveal from "../_components/Reveal";
import PageHeader from "../_components/PageHeader";

export const metadata: Metadata = {
  title: "MemOS — Persistent Memory",
  description:
    "Universal, local-first, persistent memory layer for AI agents. Graph-native SQLite storage, temporal validity, trust scoring, and 77.6% token savings with compact TOON.",
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
  { name: "BEAM-1M (recall)", memos: "95.9%", mem0: "64.1%" },
  { name: "LoCoMo", memos: "92.5", mem0: "92.5" },
  { name: "LongMemEval", memos: "94.4", mem0: "94.4" },
];

export default function MemOSPage() {
  return (
    <main className="min-h-screen">
      <div className="max-w-4xl mx-auto px-6 py-16 md:py-20">
        <PageHeader
          kicker="persistent memory"
          title="MemOS"
          subtitle="Universal, local-first, persistent memory layer for AI agents. Give any LLM a memory that survives restarts — no cloud, no API keys, no vendor lock-in."
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
          <h2 className="text-sm font-medium text-zinc-200 mb-4">Benchmarks</h2>
          <div className="card overflow-hidden">
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
        </Reveal>

        <Reveal delay={160}>
          <div className="flex flex-wrap gap-3">
            <a href="/docs" className="btn btn-primary">
              Read the docs
              <ArrowRight size={15} />
            </a>
            <a
              href="https://github.com/Markgatcha/memos"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary"
            >
              <GithubIcon size={15} />
              View on GitHub
            </a>
          </div>
        </Reveal>
      </div>
    </main>
  );
}
