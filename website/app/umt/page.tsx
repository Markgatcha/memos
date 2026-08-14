import Reveal from "../_components/Reveal";

export default function UMT() {
  return (
    <main className="min-h-screen">
      <div className="max-w-4xl mx-auto px-6 py-16">
        <Reveal>
          <div className="text-xs font-semibold uppercase tracking-widest text-purple-400 mb-3">
            MCP Toolkit
          </div>
          <h1 className="text-4xl md:text-5xl font-bold mb-4">
            Universal <span className="text-gradient">MCP Toolkit</span>
          </h1>
          <p className="text-xl text-gray-400 mb-8 max-w-2xl">
            MCP transport, server registry, and tool routing for AI agents.
            Works with MemOS, any MCP-compatible client, and local LLMs.
          </p>
        </Reveal>
        <Reveal delay={120}>
          <div className="flex flex-wrap gap-4">
            <a
              href="https://github.com/Markgatcha/universal-mcp-toolkit"
              className="btn-ghost px-6 py-3 rounded-xl border border-white/10 text-gray-200 font-medium"
            >
              View on GitHub →
            </a>
            <a
              href="/docs"
              className="btn-cta px-6 py-3 rounded-xl font-medium bg-purple-600 hover:bg-purple-500"
            >
              Read Docs
            </a>
          </div>
        </Reveal>
      </div>
    </main>
  );
}
