import type { Metadata } from "next";
import Reveal from "../_components/Reveal";
import PageHeader from "../_components/PageHeader";
import BenchmarkChart from "../_components/BenchmarkChart";

export const metadata: Metadata = {
  title: "Benchmarks",
  description:
    "Benchmark results for MemOS: full-dataset LoCoMo retrieval, HotPotQA multi-hop, BEAM-1M recall vs Mem0, a 10k-memory haystack, and token efficiency. Local LFM2.5 embeddings + two-stage rerank — reproducible and honest about protocols.",
  openGraph: {
    title: "MemOS Benchmarks — 83.2% Hit@10 on the full LoCoMo dataset",
    description:
      "Reproducible memory benchmarks: full LoCoMo (1,986 questions), HotPotQA multi-hop, BEAM-1M, memory haystack at 10k memories, and token efficiency. Local LFM2.5 embeddings + two-stage rerank on one laptop GPU.",
    images: [{ url: "/og-benchmarks.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    images: [{ url: "/og-benchmarks.png", width: 1200, height: 630 }],
  },
};

const locomoRows = [
  { metric: "Hit@10", at5: "78.3%", at10: "83.2%", highlight: true },
  { metric: "Evidence Recall", at5: "72.6%", at10: "77.9%" },
  { metric: "All-Evidence Recall", at5: "—", at10: "72.5%" },
  { metric: "MRR", at5: "—", at10: "0.642" },
  { metric: "nDCG@10", at5: "—", at10: "0.656" },
];
const hotpotRows = [
  { metric: "Hit@10", value: "100%" },
  { metric: "Evidence Recall@10", value: "96.3%" },
  { metric: "All-Evidence Recall@10", value: "92.6%" },
  { metric: "MRR@10", value: "0.977" },
  { metric: "nDCG@10", value: "0.934" },
];
const haystackRows = [
  { size: "1,000 memories", hit1: "100%", hit10: "100%", p50: "12 ms" },
  { size: "5,000 memories", hit1: "100%", hit10: "100%", p50: "43 ms" },
  { size: "10,000 memories", hit1: "100%", hit10: "100%", p50: "82 ms" },
];
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
          subtitle="Full-dataset LoCoMo, HotPotQA multi-hop, BEAM-1M at production scale, and a 10k-memory haystack — local LFM2.5 embeddings plus a two-stage cross-encoder rerank, reproducible from the repo."
        />

        <Reveal className="mb-12">
          <h2 className="text-sm font-medium text-zinc-200 mb-4">
            LoCoMo · full dataset · retrieval-only evidence matching
          </h2>
          <div className="card overflow-hidden">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th className="!text-right">Top-5</th>
                  <th className="!text-right">Top-10</th>
                </tr>
              </thead>
              <tbody>
                {locomoRows.map((r) => (
                  <tr key={r.metric} className={r.highlight ? "bg-emerald-500/[0.04]" : ""}>
                    <td className={r.highlight ? "!text-zinc-100" : ""}>{r.metric}</td>
                    <td className="!text-right tabular-nums text-zinc-300">{r.at5}</td>
                    <td className="!text-right font-medium tabular-nums text-zinc-100">{r.at10}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs text-zinc-600 leading-relaxed">
            All 10 conversations, 1,986 questions, scored by direct
            evidence-ID matching — no LLM judge, no fuzzy matching. Stack:
            LFM2.5-Embedding-350M served by llama.cpp plus a
            bge-reranker-v2-m3 cross-encoder, both on one RTX 5050 laptop
            GPU. Per category: single-hop 89.7% Hit@10, multi-hop 86.9%,
            temporal 85.4%, adversarial 73.3%, open-domain 53.3%. Full run:
            79.7 minutes end-to-end on that laptop.
          </p>
        </Reveal>

        <Reveal className="mb-12" delay={60}>
          <h2 className="text-sm font-medium text-zinc-200 mb-4">
            HotPotQA · multi-hop retrieval
          </h2>
          <div className="card overflow-hidden">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th className="!text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {hotpotRows.map((r) => (
                  <tr key={r.metric}>
                    <td>{r.metric}</td>
                    <td className="!text-right font-medium tabular-nums text-zinc-100">
                      {r.value}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs text-zinc-600 leading-relaxed">
            500 validation questions, ~4,900 deduplicated Wikipedia
            paragraphs ingested corpus-wide, scored by supporting-paragraph
            title matching. Comparison questions are perfect across every
            metric; bridge questions sit at 95.4% evidence recall. This is
            the dataset class Cognee uses in its published memory evals.
          </p>
        </Reveal>

        <Reveal className="mb-12" delay={100}>
          <h2 className="text-sm font-medium text-zinc-200 mb-4">
            Memory haystack · precision at scale
          </h2>
          <div className="card overflow-hidden">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Corpus size</th>
                  <th className="!text-right">Hit@1</th>
                  <th className="!text-right">Hit@10</th>
                  <th className="!text-right">p50 latency</th>
                </tr>
              </thead>
              <tbody>
                {haystackRows.map((r) => (
                  <tr key={r.size}>
                    <td>{r.size}</td>
                    <td className="!text-right font-medium tabular-nums text-emerald-400">
                      {r.hit1}
                    </td>
                    <td className="!text-right tabular-nums text-zinc-300">{r.hit10}</td>
                    <td className="!text-right tabular-nums text-zinc-300">{r.p50}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs text-zinc-600 leading-relaxed">
            The needle-in-a-haystack test adapted to memory: unique facts
            planted at random depths in a growing distractor corpus, one
            natural-language query per needle. Deterministic, CPU-only —
            precision holds at 10k memories with an honest near-linear
            latency curve.
          </p>
        </Reveal>

        <Reveal className="mb-12" delay={140}>
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

        <Reveal className="mb-12" delay={180}>
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

        <Reveal delay={220}>
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
            . Local embeddings (LFM2.5-Embedding-350M) and the reranker
            (bge-reranker-v2-m3) run on the same laptop via llama.cpp — no
            API keys, no cloud.
          </p>
        </Reveal>
      </div>
    </main>
  );
}
