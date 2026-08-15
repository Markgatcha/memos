import { ArrowRight } from "lucide-react";
import Reveal from "../_components/Reveal";
import PageHeader from "../_components/PageHeader";

export default function Blog() {
  return (
    <main className="min-h-screen">
      <div className="max-w-4xl mx-auto px-6 py-16 md:py-20">
        <PageHeader
          kicker="blog"
          title="Writing"
          subtitle="Engineering posts about the AI Trio, benchmarks, and local-first AI infrastructure."
        />

        <Reveal>
          <a
            href="https://github.com/Markgatcha/memos/blob/main/docs/benchmark-comparison.md"
            target="_blank"
            rel="noopener noreferrer"
            className="card p-7 block group"
          >
            <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-zinc-500 mb-3">
              benchmarks · Aug 12, 2026
            </div>
            <h2 className="text-xl font-semibold text-zinc-50 mb-2.5 group-hover:text-white transition-colors text-balance">
              We beat Mem0 on BEAM-1M: 95.9% vs 64.1% recall
            </h2>
            <p className="text-sm text-zinc-400 leading-relaxed mb-5 max-w-xl">
              How MemOS achieves superior benchmark performance with local
              SQLite and Gemma-300M embeddings.
            </p>
            <span className="arrow-link">
              Read the post <ArrowRight size={14} />
            </span>
          </a>
        </Reveal>
      </div>
    </main>
  );
}
