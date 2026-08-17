import { ArrowRight, ArrowUpRight } from "lucide-react";
import type { Metadata } from "next";
import Reveal from "../../_components/Reveal";
import PageHeader from "../../_components/PageHeader";

export const metadata: Metadata = {
  title: "Architecture",
  description:
    "How MemOS works: layered architecture, hybrid retrieval with RRF fusion, token-budgeted context packs, and the confidence state machine.",
};

/* ---------- Layer diagram (SVG, replaces the ASCII diagram in the repo) ---------- */

function LayerDiagram() {
  return (
    <svg
      viewBox="0 0 720 460"
      className="w-full h-auto"
      role="img"
      aria-label="MemOS layered architecture diagram"
    >
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#52525b" />
        </marker>
      </defs>

      {/* Application layer */}
      <g>
        <rect x="20" y="16" width="680" height="72" rx="10" fill="#0c0c0e" stroke="rgba(255,255,255,0.10)" />
        <text x="40" y="40" fill="#71717a" fontSize="11" fontFamily="monospace" letterSpacing="2">
          APPLICATION LAYER
        </text>
        {["OpenAI adapter", "Anthropic adapter", "Custom agents / LLMs"].map((t, i) => (
          <g key={t}>
            <rect x={40 + i * 222} y="50" width="200" height="28" rx="6" fill="#101013" stroke="rgba(255,255,255,0.08)" />
            <text x={140 + i * 222} y="68" fill="#a1a1aa" fontSize="12" textAnchor="middle" fontFamily="monospace">
              {t}
            </text>
          </g>
        ))}
      </g>

      {/* arrows app -> transport */}
      <line x1="360" y1="88" x2="360" y2="112" stroke="#52525b" strokeWidth="1.5" markerEnd="url(#arrow)" />

      {/* Transport layer */}
      <g>
        <rect x="20" y="116" width="680" height="72" rx="10" fill="#0c0c0e" stroke="rgba(255,255,255,0.10)" />
        <text x="40" y="140" fill="#71717a" fontSize="11" fontFamily="monospace" letterSpacing="2">
          TRANSPORT LAYER
        </text>
        {[
          "Python HTTP server (FastAPI)",
          "MCP server (stdio + HTTP/SSE)",
          "TypeScript SDK (direct)",
        ].map((t, i) => (
          <g key={t}>
            <rect x={40 + i * 222} y="150" width="200" height="28" rx="6" fill="#101013" stroke="rgba(255,255,255,0.08)" />
            <text x={140 + i * 222} y="168" fill="#a1a1aa" fontSize="11" textAnchor="middle" fontFamily="monospace">
              {t}
            </text>
          </g>
        ))}
      </g>

      {/* arrows transport -> core */}
      <line x1="360" y1="188" x2="360" y2="212" stroke="#52525b" strokeWidth="1.5" markerEnd="url(#arrow)" />

      {/* Core engine */}
      <g>
        <rect x="20" y="216" width="680" height="130" rx="10" fill="#0c0c0e" stroke="rgba(255,255,255,0.10)" />
        <text x="40" y="240" fill="#71717a" fontSize="11" fontFamily="monospace" letterSpacing="2">
          CORE ENGINE (TYPESCRIPT)
        </text>
        <rect x="40" y="250" width="640" height="30" rx="6" fill="#101013" stroke="rgba(255,255,255,0.12)" />
        <text x="360" y="269" fill="#e4e4e7" fontSize="12" textAnchor="middle" fontFamily="monospace">
          MemOS — public API + orchestration (src/memory.ts)
        </text>
        {[
          "Retrieval pipeline (FTS5 + semantic + RRF)",
          "Graph engine",
          "Context packs (TOON)",
          "Confidence machine",
        ].map((t, i) => (
          <g key={t}>
            <rect x={40 + i * 163} y="296" width="151" height="36" rx="6" fill="#101013" stroke="rgba(255,255,255,0.08)" />
            <text x={115 + i * 163} y="311" fill="#a1a1aa" fontSize="9.5" textAnchor="middle" fontFamily="monospace">
              {t.split(" (")[0]}
            </text>
            {t.includes("(") && (
              <text x={115 + i * 163} y="324" fill="#52525b" fontSize="8.5" textAnchor="middle" fontFamily="monospace">
                ({t.split(" (")[1].replace(")", "")})
              </text>
            )}
          </g>
        ))}
      </g>

      {/* arrows core -> storage */}
      <line x1="360" y1="346" x2="360" y2="370" stroke="#52525b" strokeWidth="1.5" markerEnd="url(#arrow)" />

      {/* Storage layer */}
      <g>
        <rect x="20" y="374" width="680" height="72" rx="10" fill="#0c0c0e" stroke="rgba(255,255,255,0.10)" />
        <text x="40" y="398" fill="#71717a" fontSize="11" fontFamily="monospace" letterSpacing="2">
          STORAGE LAYER
        </text>
        <rect x="40" y="408" width="310" height="28" rx="6" fill="#101013" stroke="rgba(255,255,255,0.08)" />
        <text x="195" y="426" fill="#a1a1aa" fontSize="11" textAnchor="middle" fontFamily="monospace">
          SQLite — WAL · FTS5 · embeddings table
        </text>
        <rect x="370" y="408" width="310" height="28" rx="6" fill="#101013" stroke="rgba(255,255,255,0.06)" strokeDasharray="4 4" />
        <text x="525" y="426" fill="#52525b" fontSize="11" textAnchor="middle" fontFamily="monospace">
          future: Postgres, Redis, Qdrant…
        </text>
      </g>
    </svg>
  );
}

/* ---------- Page ---------- */

const retrievalSteps = [
  {
    step: "01",
    name: "Keyword leg",
    text: "SQLite FTS5 with BM25 ranking — exact terms, names, and identifiers.",
  },
  {
    step: "02",
    name: "Semantic leg",
    text: "Cosine similarity over the embeddings table. Vectors come from the local embedding provider — no network calls.",
  },
  {
    step: "03",
    name: "RRF fusion",
    text: "Reciprocal Rank Fusion (K=60) merges both legs, weighted, then trust-weighted and filtered by temporal validity.",
  },
];

const packSteps = [
  {
    step: "01",
    name: "Hybrid search",
    text: "The retrieval pipeline above returns ranked candidates for the query.",
  },
  {
    step: "02",
    name: "Debloat",
    text: "Filler is stripped from each candidate before it can spend tokens.",
  },
  {
    step: "03",
    name: "Budget cut",
    text: "Candidates are ranked by relevance × trust and cut at the token budget.",
  },
  {
    step: "04",
    name: "Serialize",
    text: "JSON, TOON, or TOON-compact — compact TOON is ~77.6% smaller than JSON for a 20-entry pack. Envelope: ai-trio.memos.context-pack.v1.",
  },
];

const modules = [
  { name: "memory.ts", role: "Public API (MemOS), orchestration, hybrid search + RRF" },
  { name: "storage/sqlite.ts", role: "Persistence via better-sqlite3 — WAL, FTS5, embeddings table" },
  { name: "graph.ts", role: "Graph operations, text similarity, clustering" },
  { name: "context-pack.ts", role: "Context pack builder, TOON / TOON-compact serialization" },
  { name: "confidence-machine.ts", role: "Confidence score state machine (floor 0.3, cap 1.0)" },
  { name: "embedding-queue.ts", role: "Batched async embedding writes" },
  { name: "importance.ts", role: "Effective importance — recency decay + access reinforcement" },
  { name: "mcp.ts", role: "MCP server exposing MemOS tools (stdio + HTTP/SSE)" },
];

export default function Architecture() {
  return (
    <main className="min-h-screen">
      <div className="max-w-4xl mx-auto px-6 py-16 md:py-20">
        <PageHeader
          kicker="architecture"
          title="How MemOS works"
          subtitle="A layered, local-first memory engine. Everything runs against a single SQLite file on your disk — no vector database, no cloud, no API keys."
        />

        <Reveal className="mb-14">
          <h2 className="text-sm font-medium text-zinc-200 mb-4">Layered architecture</h2>
          <div className="card p-4 sm:p-6 overflow-x-auto">
            <LayerDiagram />
          </div>
        </Reveal>

        <Reveal className="mb-14" delay={60}>
          <h2 className="text-sm font-medium text-zinc-200 mb-4">
            Retrieval pipeline — hybrid search
          </h2>
          <p className="text-sm text-zinc-400 leading-relaxed mb-5 max-w-2xl">
            Every <code className="font-mono text-[13px] text-zinc-300">search()</code>{" "}
            runs two legs in parallel against the same SQLite database, then
            fuses the rankings.
          </p>
          <div className="card overflow-hidden">
            <div className="divide-y divide-white/[0.05]">
              {retrievalSteps.map((s) => (
                <div key={s.step} className="flex gap-5 px-6 py-4">
                  <span className="font-mono text-[13px] text-zinc-600 tabular-nums shrink-0">
                    {s.step}
                  </span>
                  <div>
                    <div className="text-sm font-medium text-zinc-200 mb-1">{s.name}</div>
                    <p className="text-[13px] text-zinc-500 leading-relaxed">{s.text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        <Reveal className="mb-14" delay={100}>
          <h2 className="text-sm font-medium text-zinc-200 mb-4">
            Context packs — feeding LLMs on a token budget
          </h2>
          <p className="text-sm text-zinc-400 leading-relaxed mb-5 max-w-2xl">
            <code className="font-mono text-[13px] text-zinc-300">contextPack()</code>{" "}
            builds a token-budgeted slice of memory for prompt injection. LLM
            Guardian consumes the envelope directly as a high-relevance shard.
          </p>
          <div className="card overflow-hidden">
            <div className="divide-y divide-white/[0.05]">
              {packSteps.map((s) => (
                <div key={s.step} className="flex gap-5 px-6 py-4">
                  <span className="font-mono text-[13px] text-zinc-600 tabular-nums shrink-0">
                    {s.step}
                  </span>
                  <div>
                    <div className="text-sm font-medium text-zinc-200 mb-1">{s.name}</div>
                    <p className="text-[13px] text-zinc-500 leading-relaxed">{s.text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        <Reveal className="mb-14" delay={140}>
          <h2 className="text-sm font-medium text-zinc-200 mb-4">Module map</h2>
          <div className="card overflow-hidden">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Module</th>
                  <th>Responsibility</th>
                </tr>
              </thead>
              <tbody>
                {modules.map((m) => (
                  <tr key={m.name}>
                    <td className="font-mono !text-[13px] text-zinc-300 whitespace-nowrap">
                      {m.name}
                    </td>
                    <td>{m.role}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>

        <Reveal delay={180}>
          <div className="flex flex-wrap gap-3">
            <a
              href="https://github.com/Markgatcha/memos/blob/main/ARCHITECTURE.md"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary"
            >
              Full ARCHITECTURE.md on GitHub
              <ArrowUpRight size={15} />
            </a>
            <a href="/memos" className="btn btn-secondary">
              MemOS overview
              <ArrowRight size={15} />
            </a>
          </div>
        </Reveal>
      </div>
    </main>
  );
}
