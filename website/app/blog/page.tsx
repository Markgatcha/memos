export default function Blog() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      <div className="max-w-4xl mx-auto px-6 py-16">
        <h1 className="text-4xl font-bold mb-4">Blog</h1>
        <p className="text-gray-300 mb-8">
          Engineering posts about the AI Trio, benchmarks, and local-first
          AI infrastructure.
        </p>
        <div className="space-y-6">
          <div className="border border-gray-800 rounded-lg p-6">
            <h2 className="text-xl font-semibold mb-2 text-blue-400">
              We Beat Mem0 on BEAM-1M: 95.9% vs 64.1% Recall
            </h2>
            <p className="text-gray-400 mb-2">
              How MemOS achieves superior benchmark performance with local
              SQLite + Gemma-300M embeddings.
            </p>
            <span className="text-sm text-gray-500">August 12, 2026</span>
          </div>
        </div>
      </div>
    </div>
  );
}
