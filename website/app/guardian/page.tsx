export default function Guardian() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      <div className="max-w-4xl mx-auto px-6 py-16">
        <h1 className="text-4xl font-bold mb-4">LLM Guardian</h1>
        <p className="text-xl text-gray-400 mb-8">
          Token-cost guardian for LLM inference. Compresses prompts, injects
          MemOS context packs, and optimizes token budgets. (Coming soon —
          this repo is in the AI Trio but docs are being written.)
        </p>
        <div className="flex gap-4">
          <a
            href="https://github.com/Markgatcha/llm-guardian"
            className="px-6 py-3 bg-gray-800 hover:bg-gray-700 rounded-lg transition"
          >
            View on GitHub →
          </a>
        </div>
      </div>
    </div>
  );
}
