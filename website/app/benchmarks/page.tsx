import type { Metadata } from "next";
import Reveal from "../_components/Reveal";
import PageHeader from "../_components/PageHeader";
import BenchmarkChart from "../_components/BenchmarkChart";

export const metadata: Metadata = {
  title: "Benchmarks",
  description:
    "Benchmark results for MemOS: BEAM-1M recall vs Mem0, token efficiency of the TOON format, and retrieval quality. Reproducible, local, and honest about ties.",
  openGraph: {
    title: "MemOS Benchmarks — 95.9% recall on BEAM-1M",
    description:
      "Reproducible memory benchmarks: BEAM-1M, LoCoMo, LongMemEval, and token efficiency. Run entirely on local hardware.",
    images: [{ url: "/og-benchmarks.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    images: [{ url: "/og-benchmarks.png", width: 1200, height: 630 }],
  },
};

const beamRows = [
  { category: "Overall (recall@10)", memos: "95.9%", mem0: "64.1%" },
  { category: "Temporal Reasoning", memos: "97.1%", mem0: "16.3%" },
  { category: "Contradiction Resolution", memos: "88.6%", mem0: "35.7%" },
];
const tokenRows = [
  { format: "JSON (full objects)", tokens: "5,479", savings: "—" },
  { format: "Verbose TOON", tokens: "1,522", savings: "72.2%" },
  { format: "Compact TOON (new)", tokens: "1,229", savings: "77.6%", highlight: true },
];

export default function Benchmarks() {
  return (
    <main className="min-h-screen">
      <div className="max-w-4xl mx-auto px-6 py-16 md:py-20">
        <PageHeader
          kicker="benchmarks"
          title="Benchmarks"
          subtitle="How MemOS measures up against Mem0 and other memory systems — run on local hardware, reproducible from the repo, and honest about where we tie."
        />

        <Reveal className="mb-12">
          <h2 className="text-sm font-medium text-zinc-200 mb-4">
            BEAM-1M · production scale
          </h2>
          <BenchmarkChart
            title="recall @10 · million-token history · higher is better"
            bars={[
              {
                label: "MemOS",
                value: 95.9,
                display: "95.9%",
                accent: true,
                note: "local SQLite + Gemma-300M embeddings",
              },
              {
                label: "Mem0",
                value: 64.1,
                display: "64.1%",
                note: "hosted platform, default settings",
              },
            ]}
            footnote="BEAM-1M simulates months of agent conversations (~1M tokens). The gap comes from temporal validity and trust scoring — features that only matter once history gets long and messy, i.e. production."
          />
          <div className="card overflow-hidden mt-4">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="!text-right">MemOS</th>
                  <th className="!text-right">Mem0</th>
                </tr>
              </thead>
              <tbody>
                {beamRows.map((r) => (
                  <tr key={r.category}>
                    <td>{r.category}</td>
                    <td className="!text-right text-zinc-100 font-medium tabular-nums">
                      {r.memos}
                    </td>
                    <td className="!text-right text-zinc-600 tabular-nums">
                      {r.mem0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>

        <Reveal className="mb-12" delay={80}>
          <h2 className="text-sm font-medium text-zinc-200 mb-4">
            Shorter-horizon benchmarks — honest ties
          </h2>
          <BenchmarkChart
            title="recall · LoCoMo & LongMemEval"
            bars={[
              { label: "MemOS · LoCoMo", value: 92.5, display: "92.5", accent: true },
              { label: "Mem0 · LoCoMo", value: 92.5, display: "92.5" },
              { label: "MemOS · LongMemEval", value: 94.4, display: "94.4", accent: true },
              { label: "Mem0 · LongMemEval", value: 94.4, display: "94.4" },
            ]}
            footnote="On shorter histories both systems retrieve well — we report the ties as ties. The point of going local isn't beating Mem0 everywhere; it's matching the quality while owning your data and paying nothing."
          />
        </Reveal>

        <Reveal delay={120}>
          <h2 className="text-sm font-medium text-zinc-200 mb-4">Token efficiency</h2>
          <BenchmarkChart
            title="tokens per 20 memory entries · lower is better"
            bars={[
              { label: "JSON (full objects)", value: 100, display: "5,479 tok" },
              { label: "Verbose TOON", value: 27.8, display: "1,522 tok" },
              {
                label: "Compact TOON",
                value: 22.4,
                display: "1,229 tok",
                accent: true,
                note: "77.6% smaller than JSON",
              },
            ]}
            footnote="Every memory you inject into a prompt costs tokens. The compact TOON format carries the same facts in roughly a quarter of the space — that's real money back on every request."
          />
          <div className="card overflow-hidden mt-4">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Format</th>
                  <th className="!text-right">Tokens · 20 entries</th>
                  <th className="!text-right">Savings vs JSON</th>
                </tr>
              </thead>
              <tbody>
                {tokenRows.map((r) => (
                  <tr key={r.format} className={r.highlight ? "bg-emerald-500/[0.04]" : ""}>
                    <td className={r.highlight ? "!text-zinc-100" : ""}>{r.format}</td>
                    <td className="!text-right tabular-nums text-zinc-300">{r.tokens}</td>
                    <td
                      className={`!text-right font-medium tabular-nums ${
                        r.highlight
                          ? "!text-emerald-400"
                          : r.savings === "—"
                            ? "text-zinc-600"
                            : "!text-zinc-300"
                      }`}
                    >
                      {r.savings}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs text-zinc-600 leading-relaxed">
            Reproduce everything on this page:{" "}
            <a
              href="https://github.com/Markgatcha/memos/tree/main/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-400 underline underline-offset-4 decoration-zinc-700 hover:decoration-zinc-400"
            >
              benchmark scripts and datasets live in the repo
            </a>
            . Local embeddings (Gemma-300M), no API keys, no cloud.
          </p>
        </Reveal>
      </div>
    </main>
  );
}
