export default function UMT() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      <div className="max-w-4xl mx-auto px-6 py-16">
        <h1 className="text-4xl font-bold mb-4">Universal MCP Toolkit</h1>
        <p className="text-xl text-gray-300 mb-8">
          MCP transport, server registry, and tool routing for AI agents.
          Works with MemOS, any MCP-compatible client, and local LLMs.
        </p>
        <div className="mb-8">
          <div className="flex gap-4">
            <a
              href="https://github.com/Markgatcha/universal-mcp-toolkit"
              className="px-6 py-3 bg-gray-800 hover:bg-gray-700 rounded-lg transition"
            >
              View on GitHub →
            </a>
            <a
              href="/docs"
              className="px-6 py-3 bg-purple-600 hover:bg-purple-700 rounded-lg transition"
            >
              Read Docs
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
