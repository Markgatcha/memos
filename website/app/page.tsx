export default function Home() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      {/* Hero */}
      <header className="border-b border-gray-800">
        <div className="max-w-4xl mx-auto px-6 py-16">
          <h1 className="text-4xl md:text-5xl font-bold mb-4">
            ContextCore — The Local-First AI Trio
          </h1>
          <p className="text-xl text-gray-300 mb-8 max-w-2xl">
            Memory, tools, and cost control for AI agents — 100% local, zero
            cloud dependencies, built for production.
          </p>
          <div className="flex flex-col sm:flex-row gap-4">
            <a
              href="/memos"
              className="px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition"
            >
              MemOS — Persistent Memory
            </a>
            <a
              href="/umt"
              className="px-6 py-3 bg-purple-600 hover:bg-purple-700 rounded-lg font-medium transition"
            >
              UMT — MCP Toolkit
            </a>
            <a
              href="/guardian"
              className="px-6 py-3 bg-green-600 hover:bg-green-700 rounded-lg font-medium transition"
            >
              Guardian — Token Optimization
            </a>
          </div>
        </div>
      </header>

      {/* Key Stats */}
      <section className="py-12 border-b border-gray-800">
        <div className="max-w-4xl mx-auto px-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 text-center">
            <div>
              <div className="text-3xl font-bold text-blue-400">95.9%</div>
              <div className="text-gray-400">BEAM-1M recall (vs Mem0: 64.1%)</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-green-400">77.6%</div>
              <div className="text-gray-400">Token savings (compact TOON)</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-purple-400">100%</div>
              <div className="text-gray-400">Local-first, zero cloud</div>
            </div>
          </div>
        </div>
      </section>

      {/* Three Projects */}
      <section className="py-16">
        <div className="max-w-4xl mx-auto px-6">
          <h2 className="text-2xl font-bold mb-8">The AI Trio</h2>
          <div className="space-y-8">
            <div className="border border-gray-800 rounded-xl p-6 hover:border-gray-700 transition">
              <h3 className="text-xl font-semibold mb-2 text-blue-400">MemOS</h3>
              <p className="text-gray-300 mb-3">
                Universal, local-first, persistent memory layer for AI agents.
                Graph-native SQLite storage with temporal validity, trust
                scoring, and compact TOON format.
              </p>
              <a
                href="/memos"
                className="text-blue-400 hover:underline"
              >
                Learn more →
              </a>
            </div>
            <div className="border border-gray-800 rounded-xl p-6 hover:border-gray-700 transition">
              <h3 className="text-xl font-semibold mb-2 text-purple-400">
                Universal MCP Toolkit (UMT)
              </h3>
              <p className="text-gray-300 mb-3">
                MCP transport, server registry, and tool routing. Works with
                Ollama, LangChain, CrewAI, and any MCP-compatible client.
              </p>
              <a href="/umt" className="text-purple-400 hover:underline">
                Learn more →
              </a>
            </div>
            <div className="border border-gray-800 rounded-xl p-6 hover:border-gray-700 transition">
              <h3 className="text-xl font-semibold mb-2 text-green-400">
                LLM Guardian
              </h3>
              <p className="text-gray-300 mb-3">
                Token-cost guardian for LLM inference. Compresses prompts,
                injects MemOS context packs, and optimizes token budgets.
              </p>
              <a
                href="/guardian"
                className="text-green-400 hover:underline"
              >
                Learn more →
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-800 py-8">
        <div className="max-w-4xl mx-auto px-6 flex justify-between items-center">
          <p className="text-gray-500">© 2026 ContextCore</p>
          <div className="flex gap-6">
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
            <a
              href="/support"
              className="text-gray-400 hover:text-white transition"
            >
              Support
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
