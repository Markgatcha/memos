import { ArrowRight, ArrowUpRight } from "lucide-react";
import type { Metadata } from "next";
import Reveal from "../_components/Reveal";
import PageHeader from "../_components/PageHeader";
import { posts } from "../../lib/posts";

export const metadata: Metadata = {
  title: "Blog",
  description:
    "Engineering notes on agent memory, benchmarks, retrieval, and local-first AI infrastructure.",
};

const posts = [
  {
    date: "Oct 21, 2026",
    tag: "benchmarks",
    title:
      "How we raised LongMemEval Recall@20 to 99.4% — and the experiments that didn't work",
    excerpt:
      "Supermemory's public bar is 97% Recall@20. We rebuilt the harness to measure the same K and retrieval unit, ran all 500 LongMemEval-S questions, and documented the changes that mattered — plus the chunking, OR-BM25, key-expansion and LLM-query experiments that didn't.",
    href: "/blogs/beating-supermemory-longmemeval",
    internal: true,
  },
  {
    date: "Sep 18, 2026",
    tag: "benchmarks",
    title:
      "We read every memory benchmark so you don't have to: LoCoMo and LongMemEval, honestly explained",
    excerpt:
      "What the two standard benchmarks actually measure, why retrieval-only recall and LLM-judge accuracy are two different games, and the five methodology traps — judge generosity, top-k gaming, category exclusions — that make memory leaderboards untrustworthy.",
    href: "/blogs/benchmarks-honestly-explained",
    internal: true,
  },
  {
    date: "Sep 18, 2026",
    tag: "architecture",
    title: "The frontier stopped deleting: ADD-only memory and the end of overwrite",
    excerpt:
      "In 2026 the best memory systems converged on the same design: never update, never delete — append and invalidate. Why overwrite was a mistake, how Mem0 and Graphiti got there, and what it looks like in a local SQLite file.",
    href: "/blogs/add-only-memory",
    internal: true,
  },
  {
    date: "Sep 18, 2026",
    tag: "retrieval",
    title: "RAG is not memory: what the leaderboards teach about hybrid retrieval",
    excerpt:
      "BM25+vector beats either alone, reranking is the cheapest +3.4pp in the field, and entity linking is the underused signal. Why memory retrieval is evidence assembly, not ranking — and the local stack that does it with no API key.",
    href: "/blogs/rag-is-not-memory",
    internal: true,
  },
  {
    date: "Sep 12, 2026",
    tag: "research",
    title:
      "The 2026 agent-memory landscape: what we learned, and what MemOS will adopt",
    excerpt:
      "We read the 2025–2026 memory wave end to end — Letta's sleep-time compute, HippoRAG 2, A-Mem, MIRIX, Mem0's industry report, LongMemEval-V2, and the compression literature. Five paradigms, a benchmark crisis, and eight concrete upgrades coming to MemOS.",
    href: "/blogs/ai-memory-landscape-2026",
    internal: true,
  },
  {
    date: "Aug 19, 2026",
    tag: "open source",
    title: "Why agent memory shouldn't cost $249 a month",
    excerpt:
      "Mem0's platform charges $19–$249/month and keeps your memories in their cloud. MemOS is MIT-licensed, runs on a SQLite file on your disk, and includes graph memory for free. Here's the full breakdown — pricing, features, and what 'open source' actually means for each.",
    href: "/compare/memos-vs-mem0",
    internal: true,
  },
  {
    date: "Aug 12, 2026",
    tag: "benchmarks",
    title:
      "BEAM-1M results: 95.9% recall with local SQLite and Gemma-300M embeddings",
    excerpt:
      "How MemOS approaches long-context memory benchmarks with a fully local stack — hybrid retrieval, temporal validity, and trust scoring.",
    href: "https://github.com/Markgatcha/memos/blob/main/docs/benchmark-comparison.md",
    internal: false,
  },
];

export default function Blog() {
  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-4xl px-6 py-16 md:py-20">
        <PageHeader
          kicker="writing"
          title="Engineering notes."
          subtitle="Benchmarks, architecture, and the occasional post-mortem — written while building the local-first stack."
        />

        <div className="border-t border-white/[0.08]">
          {posts.map((p, i) => (
            <Reveal key={p.href} delay={i * 55}>
              <a
                href={p.href}
                {...(p.internal
                  ? {}
                  : { target: "_blank", rel: "noopener noreferrer" })}
                className="group grid gap-3 border-b border-white/[0.08] py-7 transition-colors hover:bg-white/[0.015] md:grid-cols-[132px_1fr_24px] md:items-start md:gap-8"
              >
                <div className="pt-1 font-mono text-[10px] tracking-[0.02em] text-zinc-500">
                  <div>{p.date}</div>
                  <div className="mt-1 text-zinc-500">{p.tag}</div>
                </div>
                <div>
                  <h2 className="max-w-2xl text-balance text-xl font-medium leading-snug tracking-[-0.025em] text-zinc-100 transition-colors group-hover:text-white">
                    {p.title}
                  </h2>
                  <p className="mt-2.5 max-w-2xl text-[13px] leading-relaxed text-zinc-500">
                    {p.excerpt}
                  </p>
                  <span className="mt-4 inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.02em] text-zinc-500 transition-colors group-hover:text-zinc-200">
                    Read the post
                    <ArrowRight size={12} />
                  </span>
                </div>
                <ArrowUpRight
                  size={16}
                  aria-hidden
                  className="hidden text-zinc-500 transition-colors group-hover:text-zinc-200 md:mt-1 md:block"
                />
              </a>
            </Reveal>
          ))}
        </div>
      </div>
    </main>
  );
}
