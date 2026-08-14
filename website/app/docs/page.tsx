export default function Docs() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      <div className="max-w-4xl mx-auto px-6 py-16">
        <h1 className="text-4xl font-bold mb-4">Documentation</h1>

        <div className="space-y-6">
          <div>
            <h2 className="text-2xl font-semibold mb-2 text-blue-400">MemOS</h2>
            <ul className="space-y-2 text-gray-300">
              <li>
                <a href="/memos" className="hover:underline">
                  → MemOS Overview & Quick Start
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/Markgatcha/memos#readme"
                  className="hover:underline"
                >
                  → API Reference (GitHub README)
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/Markgatcha/memos/blob/main/ARCHITECTURE.md"
                  className="hover:underline"
                >
                  → Architecture Guide
                </a>
              </li>
            </ul>
          </div>

          <div>
            <h2 className="text-2xl font-semibold mb-2 text-purple-400">
              Universal MCP Toolkit
            </h2>
            <ul className="space-y-2 text-gray-300">
              <li>
                <a href="/umt" className="hover:underline">
                  → UMT Overview & Quick Start
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/Markgatcha/universal-mcp-toolkit#readme"
                  className="hover:underline"
                >
                  → API Reference (GitHub README)
                </a>
              </li>
            </ul>
          </div>

          <div>
            <h2 className="text-2xl font-semibold mb-2 text-green-400">
              LLM Guardian
            </h2>
            <ul className="space-y-2 text-gray-300">
              <li>
                <a href="/guardian" className="hover:underline">
                  → Guardian Overview & Quick Start
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/Markgatcha/llm-guardian#readme"
                  className="hover:underline"
                >
                  → API Reference (GitHub README)
                </a>
              </li>
            </ul>
          </div>

          <div>
            <h2 className="text-2xl font-semibold mb-2">AI Trio Integration</h2>
            <ul className="space-y-2 text-gray-300">
              <li>
                <a
                  href="https://github.com/Markgatcha/memos/blob/main/docs/benchmark-comparison.md"
                  className="hover:underline"
                >
                  → AI Trio Documentation
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/Markgatcha/memos/blob/main/docs/benchmark-quality.md"
                  className="hover:underline"
                >
                  → Context Pack Format Spec
                </a>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
