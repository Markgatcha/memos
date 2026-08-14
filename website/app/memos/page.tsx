import Reveal from "../_components/Reveal";

const features = [
  "100% local SQLite-backed storage (no cloud)",
  "Graph-native with typed edges",
  "Temporal validity (validFrom/validTo)",
  "Trust scoring & provenance tracking",
  "Compact TOON format (77.6% token savings)",
  "Confidence score state machine",
  "MCP adapter (stdio + HTTP+SSE)",
  "Framework-agnostic (Ollama, LangChain, CrewAI)",
];

const benchmarks = [
  { name: "BEAM-1M (recall)", memos: "95.9%", mem0: "64.1%" },
  { name: "LoCoMo", memos: "92.5", mem0: "92.5" },
  { name: "LongMemEval", memos: "94.4", mem0: "94.4" },
];

export default function MemOSPage() {
  return (
    <main className="min-h-screen">
      <div className="max-w-4xl mx-auto px-6 py-16">
        <Reveal>
          <div className="text-xs font-semibold uppercase tracking-widest text-blue-400 mb-3">
            Persistent Memory
          </div>
          <h1 className="text-4xl md:text-5xl font-bold mb-4">
            Mem<span className="text-gradient">OS</span>
          </h1>
          <p className="text-xl text-gray-400 mb-8 max-w-2xl">
            Universal, local-first, persistent memory layer for AI agents.
            Give any LLM a memory that survives restarts — no cloud, no API
            keys, no vendor lock-in.
          </p>
        </Reveal>

        <Reveal delay={100}>
          <div className="mb-10">
            <h2 className="text-2xl font-semibold mb-4">Quick Start</h2>
            <div className="glass-card rounded-xl p-5 font-mono text-sm text-gray-200 overflow-x-auto">
              <div className="text-gray-500">$ <span className="text-gray-200">npm install @mem-os/sdk</span></div>
              <div className="text-gray-500">$ <span className="text-gray-200">npx memos init</span></div>
            </div>
          </div>
        </Reveal>

        <Reveal delay={150}>
          <div className="mb-10">
            <h2 className="text-2xl font-semibold mb-4">Key Features</h2>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {features.map((f) => (
                <li key={f} className="flex items-start gap-3 text-gray-300">
                  <span className="text-blue-400 mt-0.5">✦</span>
                  {f}
                </li>
              ))}
            </ul>
          </div>
        </Reveal>

        <Reveal delay={200}>
          <div className="mb-10">
            <h2 className="text-2xl font-semibold mb-4">Benchmarks</h2>
            <div className="glass-card rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-gray-400">
                    <th className="text-left p-4 font-medium">Benchmark</th>
                    <th className="text-right p-4 font-medium">MemOS</th>
                    <th className="text-right p-4 font-medium">Mem0</th>
                  </tr>
                </thead>
                <tbody>
                  {benchmarks.map((b) => (
                    <tr key={b.name} className="border-b border-white/5 last:border-0">
                      <td className="p-4 text-gray-300">{b.name}</td>
                      <td className="text-right p-4 text-green-400 font-semibold">{b.memos}</td>
                      <td className="text-right p-4 text-gray-500">{b.mem0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Reveal>

        <Reveal delay={250}>
          <div className="flex flex-wrap gap-4">
            <a
              href="https://github.com/Markgatcha/memos"
              className="btn-ghost px-6 py-3 rounded-xl border border-white/10 text-gray-200 font-medium"
            >
              View on GitHub →
            </a>
            <a
              href="/docs"
              className="btn-cta px-6 py-3 rounded-xl font-medium bg-blue-600 hover:bg-blue-500"
            >
              Read Docs
            </a>
          </div>
        </Reveal>
      </div>
    </main>
  );
}
