import Reveal from "../_components/Reveal";

export default function Blog() {
  return (
    <main className="min-h-screen">
      <div className="max-w-4xl mx-auto px-6 py-16">
        <Reveal>
          <h1 className="text-4xl md:text-5xl font-bold mb-4">
            Bl<span className="text-gradient">og</span>
          </h1>
          <p className="text-gray-400 mb-10 max-w-2xl">
            Engineering posts about the AI Trio, benchmarks, and local-first
            AI infrastructure.
          </p>
        </Reveal>
        <Reveal delay={120}>
          <div className="glass-card rounded-2xl p-7">
            <div className="card-accent accent-blue" />
            <h2 className="text-xl font-semibold mb-2 text-blue-400">
              We Beat Mem0 on BEAM-1M: 95.9% vs 64.1% Recall
            </h2>
            <p className="text-gray-400 mb-3">
              How MemOS achieves superior benchmark performance with local
              SQLite + Gemma-300M embeddings.
            </p>
            <span className="text-sm text-gray-500">August 12, 2026</span>
          </div>
        </Reveal>
      </div>
    </main>
  );
}
