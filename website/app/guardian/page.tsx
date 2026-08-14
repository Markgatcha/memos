import Reveal from "../_components/Reveal";

export default function Guardian() {
  return (
    <main className="min-h-screen">
      <div className="max-w-4xl mx-auto px-6 py-16">
        <Reveal>
          <div className="text-xs font-semibold uppercase tracking-widest text-green-400 mb-3">
            Token Optimization
          </div>
          <h1 className="text-4xl md:text-5xl font-bold mb-4">
            LLM <span className="text-gradient">Guardian</span>
          </h1>
          <p className="text-xl text-gray-400 mb-8 max-w-2xl">
            Token-cost guardian for LLM inference. Compresses prompts, injects
            MemOS context packs, and optimizes token budgets. (Coming soon —
            this repo is in the AI Trio but docs are being written.)
          </p>
        </Reveal>
        <Reveal delay={120}>
          <div className="flex gap-4">
            <a
              href="https://github.com/Markgatcha/llm-guardian"
              className="btn-ghost px-6 py-3 rounded-xl border border-white/10 text-gray-200 font-medium"
            >
              View on GitHub →
            </a>
          </div>
        </Reveal>
      </div>
    </main>
  );
}
