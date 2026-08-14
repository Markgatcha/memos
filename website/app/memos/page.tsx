export default function MemOSPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      <div className="max-w-4xl mx-auto px-6 py-16">
        <h1 className="text-4xl font-bold mb-4">MemOS</h1>
        <p className="text-xl text-gray-300 mb-8">
          Universal, local-first, persistent memory layer for AI agents.
          Give any LLM a memory that survives restarts — no cloud, no API
          keys, no vendor lock-in.
        </p>

        <div className="mb-8">
          <h2 className="text-2xl font-semibold mb-3">Quick Start</h2>
          <pre className="bg-gray-900 rounded-lg p-4 overflow-x-auto">
            <code>
              npm install @mem-os/sdk
              <br />
              npx memos init
            </code>
          </pre>
        </div>

        <div className="mb-8">
          <h2 className="text-2xl font-semibold mb-3">Key Features</h2>
          <ul className="space-y-2 text-gray-300">
            <li>• 100% local SQLite-backed storage (no cloud)</li>
            <li>• Graph-native with typed edges</li>
            <li>• Temporal validity (validFrom/validTo)</li>
            <li>• Trust scoring & provenance tracking</li>
            <li>• Compact TOON format (77.6% token savings)</li>
            <li>• Confidence score state machine</li>
            <li>• MCP adapter (stdio + HTTP+SSE)</li>
            <li>• Framework-agnostic (Ollama, LangChain, CrewAI)</li>
          </ul>
        </div>

        <div className="mb-8">
          <h2 className="text-2xl font-semibold mb-3">Benchmarks</h2>
          <div className="overflow-x-auto">
            <table className="w-full border border-gray-800 rounded-lg overflow-hidden">
              <thead className="bg-gray-900">
                <tr>
                  <th className="text-left p-3">Benchmark</th>
                  <th className="text-right p-3">MemOS</th>
                  <th className="text-right p-3">Mem0</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-gray-800">
                  <td className="p-3">BEAM-1M (recall)</td>
                  <td className="text-right p-3 text-green-400">95.9%</td>
                  <td className="text-right p-3 text-gray-400">64.1%</td>
                </tr>
                <tr className="border-t border-gray-800">
                  <td className="p-3">LoCoMo</td>
                  <td className="text-right p-3 text-green-400">92.5</td>
                  <td className="text-right p-3 text-gray-400">92.5</td>
                </tr>
                <tr className="border-t border-gray-800">
                  <td className="p-3">LongMemEval</td>
                  <td className="text-right p-3 text-green-400">94.4</td>
                  <td className="text-right p-3 text-gray-400">94.4</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex gap-4">
          <a
            href="https://github.com/Markgatcha/memos"
            className="px-6 py-3 bg-gray-800 hover:bg-gray-700 rounded-lg transition"
          >
            View on GitHub →
          </a>
          <a
            href="/docs"
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg transition"
          >
            Read Docs
          </a>
        </div>
      </div>
    </div>
  );
}
