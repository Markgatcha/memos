import {
  ArrowRight,
  ArrowUpRight,
  Brain,
  Cable,
  Gauge,
  HardDrive,
  KeyRound,
  Lock,
} from "lucide-react";
import GithubIcon from "./_components/GithubIcon";
import Reveal from "./_components/Reveal";
import Counter from "./_components/Counter";
import Terminal from "./_components/Terminal";
import SpotlightCard from "./_components/SpotlightCard";

const stats = [
  { value: 95.9, decimals: 1, suffix: "%", label: "BEAM-1M recall @10" },
  { value: 77.6, decimals: 1, suffix: "%", label: "token savings vs JSON" },
  { value: 100, decimals: 0, suffix: "%", label: "local — zero cloud calls" },
];

const integrations = ["OLLAMA", "LANGCHAIN", "CREWAI", "OPENAI", "MCP", "ANY LLM"];

const principles = [
  {
    icon: HardDrive,
    title: "Your data never leaves",
    text: "SQLite on your disk. No sync, no telemetry, no accounts.",
  },
  {
    icon: KeyRound,
    title: "No API keys required",
    text: "Runs against local models out of the box. Bring keys only if you want to.",
  },
  {
    icon: Lock,
    title: "Auditable by design",
    text: "Open source, deterministic, and inspectable down to the storage layer.",
  },
];

export default function Home() {
  return (
    <main className="min-h-screen">
      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 pt-20 pb-16 md:pt-28">
        <div className="text-center max-w-3xl mx-auto">
          <div className="animate-fade-up inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 font-mono text-xs text-zinc-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            open source · runs entirely on your machine
          </div>

          <h1
            className="animate-fade-up mt-7 text-5xl md:text-[4.25rem] font-semibold leading-[1.04] tracking-[-0.045em] text-zinc-50 text-balance"
            style={{ animationDelay: "0.1s" }}
          >
            The local-first stack
            <br />
            for <span className="text-fade">AI agents.</span>
          </h1>

          <p
            className="animate-fade-up mt-6 text-lg text-zinc-400 leading-relaxed max-w-xl mx-auto"
            style={{ animationDelay: "0.2s" }}
          >
            Persistent memory, MCP tooling, and token-cost control — three
            tools that give any LLM a memory that survives restarts, without a
            cloud in sight.
          </p>

          <div
            className="animate-fade-up mt-9 flex flex-col sm:flex-row items-center justify-center gap-3"
            style={{ animationDelay: "0.3s" }}
          >
            <a href="#stack" className="btn btn-primary">
              Explore the stack
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
        </div>

        <div className="animate-fade-up mt-16" style={{ animationDelay: "0.45s" }}>
          <Terminal />
        </div>

        <div className="mt-14 text-center">
          <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-zinc-600 mb-4">
            works with your stack
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-2 font-mono text-[13px] text-zinc-500">
            {integrations.map((name) => (
              <span key={name} className="hover:text-zinc-300 transition-colors">
                {name}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* Stats */}
      <section className="border-y border-white/[0.06]">
        <div className="max-w-6xl mx-auto px-6 grid grid-cols-1 sm:grid-cols-3 sm:divide-x divide-white/[0.06]">
          {stats.map((s, i) => (
            <Reveal key={s.label} delay={i * 100}>
              <div className="py-10 sm:px-10 text-center sm:text-left">
                <div className="font-mono text-3xl md:text-4xl text-zinc-50 tabular-nums tracking-tight">
                  <Counter value={s.value} decimals={s.decimals} suffix={s.suffix} />
                </div>
                <div className="mt-2 font-mono text-[11px] uppercase tracking-[0.12em] text-zinc-500">
                  {s.label}
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* Bento: the stack */}
      <section id="stack" className="max-w-6xl mx-auto px-6 py-20 md:py-28">
        <Reveal className="mb-12">
          <div className="kicker mb-4">the stack</div>
          <h2 className="text-3xl md:text-4xl font-semibold tracking-[-0.03em] text-zinc-50 text-balance">
            Three tools. One machine.
          </h2>
          <p className="mt-3 text-zinc-400 max-w-xl">
            Each works on its own — they&apos;re better together.
          </p>
        </Reveal>

        <div className="grid grid-cols-1 lg:grid-cols-6 gap-4">
          {/* MemOS — large card with graph viz */}
          <Reveal className="lg:col-span-4">
            <SpotlightCard className="h-full p-7 md:p-8 block">
              <a href="/memos" className="block h-full">
                <div className="flex items-start justify-between gap-6">
                  <div className="max-w-sm">
                    <div className="w-10 h-10 rounded-lg border border-white/10 bg-zinc-900 grid place-items-center text-blue-400 mb-5">
                      <Brain size={18} strokeWidth={1.8} />
                    </div>
                    <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-blue-400/90 mb-2">
                      persistent memory
                    </div>
                    <h3 className="text-xl font-semibold text-zinc-50 mb-3">
                      MemOS
                    </h3>
                    <p className="text-sm text-zinc-400 leading-relaxed">
                      Graph-native memory on local SQLite. Temporal validity,
                      trust scoring, and a compact format that cuts context
                      tokens by 77.6%.
                    </p>
                  </div>
                  <svg
                    viewBox="0 0 190 150"
                    className="hidden md:block w-[190px] shrink-0"
                    aria-hidden
                  >
                    <g stroke="#27272a" strokeWidth="1">
                      <line x1="95" y1="75" x2="40" y2="30" />
                      <line x1="95" y1="75" x2="150" y2="32" />
                      <line x1="95" y1="75" x2="38" y2="118" />
                      <line x1="95" y1="75" x2="152" y2="116" />
                      <line x1="40" y1="30" x2="150" y2="32" />
                      <line x1="40" y1="30" x2="38" y2="118" />
                      <line x1="150" y1="32" x2="152" y2="116" />
                      <line x1="38" y1="118" x2="152" y2="116" />
                    </g>
                    <circle cx="95" cy="75" r="9" fill="#101013" stroke="#3f3f46" />
                    <circle cx="95" cy="75" r="9" fill="none" stroke="#34d399" strokeOpacity="0.5">
                      <animate attributeName="r" values="9;16;9" dur="3s" repeatCount="indefinite" />
                      <animate attributeName="stroke-opacity" values="0.5;0;0.5" dur="3s" repeatCount="indefinite" />
                    </circle>
                    <circle cx="40" cy="30" r="6" fill="#101013" stroke="#3f3f46" />
                    <circle cx="150" cy="32" r="6" fill="#101013" stroke="#3f3f46" />
                    <circle cx="38" cy="118" r="6" fill="#101013" stroke="#3f3f46" />
                    <circle cx="152" cy="116" r="6" fill="#101013" stroke="#3f3f46" />
                  </svg>
                </div>
                <div className="mt-8 pt-5 border-t border-white/[0.06] flex items-center justify-between">
                  <span className="font-mono text-xs text-zinc-500 tabular-nums">
                    95.9% recall · BEAM-1M
                  </span>
                  <span className="arrow-link">
                    Learn more <ArrowRight size={14} />
                  </span>
                </div>
              </a>
            </SpotlightCard>
          </Reveal>

          {/* UMT — tall card with status rows */}
          <Reveal className="lg:col-span-2" delay={100}>
            <SpotlightCard className="h-full p-7 block">
              <a href="/umt" className="block h-full">
                <div className="w-10 h-10 rounded-lg border border-white/10 bg-zinc-900 grid place-items-center text-violet-400 mb-5">
                  <Cable size={18} strokeWidth={1.8} />
                </div>
                <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-violet-400/90 mb-2">
                  mcp toolkit
                </div>
                <h3 className="text-xl font-semibold text-zinc-50 mb-3">
                  Universal MCP Toolkit
                </h3>
                <p className="text-sm text-zinc-400 leading-relaxed mb-6">
                  Transport, registry, and routing for MCP tools across every
                  major client.
                </p>
                <div className="font-mono text-xs space-y-2.5 mb-6">
                  <div className="flex justify-between">
                    <span className="text-zinc-400">ollama</span>
                    <span className="text-emerald-500/90">connected</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-400">stdio</span>
                    <span className="text-emerald-500/90">ready</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-400">http + sse</span>
                    <span className="text-emerald-500/90">ready</span>
                  </div>
                </div>
                <div className="mt-auto pt-5 border-t border-white/[0.06]">
                  <span className="arrow-link">
                    Learn more <ArrowRight size={14} />
                  </span>
                </div>
              </a>
            </SpotlightCard>
          </Reveal>

          {/* Guardian — card with compression bars */}
          <Reveal className="lg:col-span-2">
            <SpotlightCard className="h-full p-7 block">
              <a href="/guardian" className="block h-full">
                <div className="w-10 h-10 rounded-lg border border-white/10 bg-zinc-900 grid place-items-center text-emerald-400 mb-5">
                  <Gauge size={18} strokeWidth={1.8} />
                </div>
                <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-emerald-400/90 mb-2">
                  token optimization
                </div>
                <h3 className="text-xl font-semibold text-zinc-50 mb-3">
                  LLM Guardian
                </h3>
                <p className="text-sm text-zinc-400 leading-relaxed mb-6">
                  Compresses prompts and guards token budgets at inference
                  time.
                </p>
                <div className="space-y-3 mb-6">
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
                      <span>compressed</span>
                      <span className="tabular-nums text-emerald-500/90">2,767 tok</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                      <div className="h-full w-[22%] rounded-full bg-emerald-500/80" />
                    </div>
                  </div>
                </div>
                <div className="mt-auto pt-5 border-t border-white/[0.06]">
                  <span className="arrow-link">
                    Learn more <ArrowRight size={14} />
                  </span>
                </div>
              </a>
            </SpotlightCard>
          </Reveal>

          {/* Principles — wide card */}
          <Reveal className="lg:col-span-4" delay={100}>
            <SpotlightCard className="h-full p-7 md:p-8 block">
              <div className="grid sm:grid-cols-3 gap-7">
                {principles.map((p) => (
                  <div key={p.title}>
                    <p.icon size={18} strokeWidth={1.8} className="text-zinc-400 mb-4" />
                    <h4 className="text-sm font-medium text-zinc-200 mb-2">
                      {p.title}
                    </h4>
                    <p className="text-[13px] text-zinc-500 leading-relaxed">
                      {p.text}
                    </p>
                  </div>
                ))}
              </div>
            </SpotlightCard>
          </Reveal>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-white/[0.06]">
        <div className="max-w-6xl mx-auto px-6 py-20 md:py-24 text-center">
          <Reveal>
            <div className="kicker mb-4 justify-center">get started</div>
            <h2 className="text-3xl md:text-4xl font-semibold tracking-[-0.03em] text-zinc-50 text-balance">
              Run your agents like you own them.
            </h2>
            <p className="mt-4 text-zinc-400 max-w-md mx-auto">
              Because you do. Clone, install, and go — no account required.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
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
                Star on GitHub
                <ArrowUpRight size={15} />
              </a>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/[0.06]">
        <div className="max-w-6xl mx-auto px-6 py-14">
          <div className="flex flex-col md:flex-row justify-between gap-10">
            <div className="max-w-xs">
              <div className="font-semibold tracking-tight text-zinc-100">
                ContextCore
              </div>
              <p className="mt-3 text-sm text-zinc-500 leading-relaxed">
                Local-first memory, tooling, and cost control for AI agents.
              </p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-10 text-sm">
              <div>
                <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-zinc-500 mb-4">
                  Products
                </div>
                <ul className="space-y-2.5">
                  <li><a href="/memos" className="text-zinc-400 hover:text-zinc-100 transition-colors">MemOS</a></li>
                  <li><a href="/umt" className="text-zinc-400 hover:text-zinc-100 transition-colors">UMT</a></li>
                  <li><a href="/guardian" className="text-zinc-400 hover:text-zinc-100 transition-colors">Guardian</a></li>
                </ul>
              </div>
              <div>
                <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-zinc-500 mb-4">
                  Resources
                </div>
                <ul className="space-y-2.5">
                  <li><a href="/docs" className="text-zinc-400 hover:text-zinc-100 transition-colors">Docs</a></li>
                  <li><a href="/benchmarks" className="text-zinc-400 hover:text-zinc-100 transition-colors">Benchmarks</a></li>
                  <li><a href="/blog" className="text-zinc-400 hover:text-zinc-100 transition-colors">Blog</a></li>
                  <li><a href="/support" className="text-zinc-400 hover:text-zinc-100 transition-colors">Support</a></li>
                </ul>
              </div>
              <div>
                <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-zinc-500 mb-4">
                  Community
                </div>
                <ul className="space-y-2.5">
                  <li>
                    <a
                      href="https://github.com/Markgatcha/memos"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-zinc-400 hover:text-zinc-100 transition-colors"
                    >
                      GitHub
                    </a>
                  </li>
                  <li>
                    <a
                      href="https://discord.gg/DyQGgPuueu"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-zinc-400 hover:text-zinc-100 transition-colors"
                    >
                      Discord
                    </a>
                  </li>
                </ul>
              </div>
            </div>
          </div>
          <div className="mt-12 pt-6 border-t border-white/[0.06] flex flex-col sm:flex-row justify-between gap-3">
            <p className="font-mono text-xs text-zinc-600">© 2026 ContextCore</p>
            <p className="font-mono text-xs text-zinc-600">MIT license</p>
          </div>
        </div>
      </footer>
    </main>
  );
}
