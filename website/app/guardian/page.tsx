import Reveal from "../_components/Reveal";
import PageHeader from "../_components/PageHeader";
import GithubIcon from "../_components/GithubIcon";

export default function Guardian() {
  return (
    <main className="min-h-screen">
      <div className="max-w-4xl mx-auto px-6 py-16 md:py-20">
        <PageHeader
          kicker="token optimization"
          title="LLM Guardian"
          subtitle="Token-cost guardian for LLM inference. Compresses prompts, injects MemOS context packs, and optimizes token budgets."
        />

        <Reveal className="mb-12">
          <div className="card p-7">
            <div className="kicker mb-4">status</div>
            <p className="text-sm text-zinc-400 leading-relaxed mb-6">
              Coming soon — this repo is part of the AI Trio, and docs are
              being written. The compression engine is already powering
              MemOS context packs in production benchmarks.
            </p>
            <div className="space-y-3 max-w-sm">
              <div>
                <div className="flex justify-between font-mono text-[11px] text-zinc-500 mb-1.5">
                  <span>raw prompt</span>
                  <span className="tabular-nums">12,408 tok</span>
                </div>
                <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                  <div className="h-full w-full rounded-full bg-zinc-600" />
                </div>
              </div>
              <div>
                <div className="flex justify-between font-mono text-[11px] text-zinc-500 mb-1.5">
                  <span>guardian-compressed</span>
                  <span className="tabular-nums text-emerald-500/90">2,767 tok</span>
                </div>
                <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                  <div className="h-full w-[22%] rounded-full bg-emerald-500/80" />
                </div>
              </div>
            </div>
          </div>
        </Reveal>

        <Reveal delay={100}>
          <a
            href="https://github.com/Markgatcha/llm-guardian"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary"
          >
            <GithubIcon size={15} />
            View on GitHub
          </a>
        </Reveal>
      </div>
    </main>
  );
}
