import type { Metadata } from "next";
import Reveal from "../_components/Reveal";
import PageHeader from "../_components/PageHeader";

export const metadata: Metadata = {
  title: "Benchmarks",
  description:
    "Benchmark results for MemOS: BEAM-1M recall, token efficiency of the TOON format, and retrieval quality.",
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
          subtitle="Benchmark results comparing MemOS against Mem0 and other memory systems."
        />

        <Reveal className="mb-12">
          <h2 className="text-sm font-medium text-zinc-200 mb-4">
            BEAM-1M · production scale
          </h2>
          <div className="card overflow-hidden">
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

        <Reveal delay={80}>
          <h2 className="text-sm font-medium text-zinc-200 mb-4">Token efficiency</h2>
          <div className="card overflow-hidden">
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
        </Reveal>
      </div>
    </main>
  );
}
