import Reveal from "./_components/Reveal";
import Counter from "./_components/Counter";

const products = [
  {
    name: "MemOS",
    tagline: "Persistent Memory",
    description:
      "Universal, local-first, persistent memory layer for AI agents. Graph-native SQLite storage with temporal validity, trust scoring, and compact TOON format.",
    href: "/memos",
    icon: "🧠",
    accent: "text-blue-400",
    accentClass: "accent-blue",
    btn: "bg-blue-600 hover:bg-blue-500",
  },
  {
    name: "Universal MCP Toolkit",
    tagline: "MCP Toolkit",
    description:
      "MCP transport, server registry, and tool routing. Works with Ollama, LangChain, CrewAI, and any MCP-compatible client.",
    href: "/umt",
    icon: "🔌",
    accent: "text-purple-400",
    accentClass: "accent-purple",
    btn: "bg-purple-600 hover:bg-purple-500",
  },
  {
    name: "LLM Guardian",
    tagline: "Token Optimization",
    description:
      "Token-cost guardian for LLM inference. Compresses prompts, injects MemOS context packs, and optimizes token budgets.",
    href: "/guardian",
    icon: "🛡️",
    accent: "text-green-400",
    accentClass: "accent-green",
    btn: "bg-green-600 hover:bg-green-500",
  },
];

export default function Home() {
  return (
    <main className="min-h-screen">
      {/* Hero */}
      <section className="max-w-5xl mx-auto px-6 pt-24 pb-20 text-center">
        <div className="badge inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-white/10 bg-white/5 text-sm text-gray-300 backdrop-blur">
          <span className="badge-dot w-2 h-2 rounded-full bg-green-400" />
          100% local · zero cloud dependencies
        </div>

        <h1
          className="animate-fade-up text-5xl md:text-7xl font-bold tracking-tight mt-8 leading-[1.1]"
          style={{ animationDelay: "0.15s" }}
        >
          The <span className="text-gradient">Local-First</span>
          <br />
          AI Trio
        </h1>

        <p
          className="animate-fade-up text-xl text-gray-400 mt-6 max-w-2xl mx-auto"
          style={{ animationDelay: "0.3s" }}
        >
          Memory, tools, and cost control for AI agents — built for
          production, powered entirely by your own machine.
        </p>

        <div
          className="animate-fade-up flex flex-col sm:flex-row justify-center gap-4 mt-10"
          style={{ animationDelay: "0.45s" }}
        >
          <a
            href="#trio"
            className="btn-cta px-8 py-3.5 rounded-xl font-medium text-white bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600"
          >
            Explore the Trio
          </a>
          <a
            href="https://github.com/Markgatcha/memos"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-ghost px-8 py-3.5 rounded-xl font-medium border border-white/10 text-gray-200"
          >
            View on GitHub
          </a>
        </div>
      </section>

      {/* Key Stats */}
      <section className="max-w-5xl mx-auto px-6 pb-24">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Reveal delay={0}>
            <div className="glass-card rounded-2xl p-8 text-center">
              <div className="card-accent accent-blue" />
              <div className="text-4xl md:text-5xl font-bold text-blue-400">
                <Counter value={95.9} decimals={1} suffix="%" />
              </div>
              <div className="text-gray-400 mt-2 text-sm">
                BEAM-1M recall (vs Mem0: 64.1%)
              </div>
            </div>
          </Reveal>
          <Reveal delay={120}>
            <div className="glass-card rounded-2xl p-8 text-center">
              <div className="card-accent accent-green" />
              <div className="text-4xl md:text-5xl font-bold text-green-400">
                <Counter value={77.6} decimals={1} suffix="%" />
              </div>
              <div className="text-gray-400 mt-2 text-sm">
                Token savings (compact TOON)
              </div>
            </div>
          </Reveal>
          <Reveal delay={240}>
            <div className="glass-card rounded-2xl p-8 text-center">
              <div className="card-accent accent-purple" />
              <div className="text-4xl md:text-5xl font-bold text-purple-400">
                <Counter value={100} suffix="%" />
              </div>
              <div className="text-gray-400 mt-2 text-sm">
                Local-first, zero cloud
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Three Projects */}
      <section id="trio" className="max-w-5xl mx-auto px-6 pb-28">
        <Reveal>
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-4">
            Meet the <span className="text-gradient">Trio</span>
          </h2>
          <p className="text-gray-400 text-center mb-12 max-w-xl mx-auto">
            Three open-source tools that work independently — or better,
            together.
          </p>
        </Reveal>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {products.map((p, i) => (
            <Reveal key={p.name} delay={i * 130}>
              <a href={p.href} className="glass-card rounded-2xl p-7 block h-full">
                <div className={`card-accent ${p.accentClass}`} />
                <div className="animate-float text-4xl mb-5 inline-block">
                  {p.icon}
                </div>
                <div className={`text-xs font-semibold uppercase tracking-widest mb-2 ${p.accent}`}>
                  {p.tagline}
                </div>
                <h3 className="text-xl font-semibold mb-3">{p.name}</h3>
                <p className="text-gray-400 text-sm leading-relaxed mb-5">
                  {p.description}
                </p>
                <span className={`${p.accent} link-underline text-sm font-medium`}>
                  Learn more →
                </span>
              </a>
            </Reveal>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/5 py-10">
        <div className="max-w-5xl mx-auto px-6 flex flex-col sm:flex-row justify-between items-center gap-4">
          <p className="text-gray-500 text-sm">© 2026 ContextCore</p>
          <div className="flex gap-8 text-sm">
            <a
              href="https://github.com/Markgatcha/memos"
              className="text-gray-400 hover:text-white transition"
            >
              GitHub
            </a>
            <a
              href="https://discord.gg/contextcore"
              className="text-gray-400 hover:text-white transition"
            >
              Discord
            </a>
            <a href="/support" className="text-gray-400 hover:text-white transition">
              Support
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}
