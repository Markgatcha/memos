export default function Benchmarks() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      <div className="max-w-5xl mx-auto px-6 py-16">
        <h1 className="text-4xl font-bold mb-4">Benchmarks</h1>
        <p className="text-gray-300 mb-8">
          Live benchmark results comparing MemOS against Mem0 and other
          memory systems.
        </p>

        <div className="mb-8">
          <h2 className="text-2xl font-semibold mb-3">BEAM-1M (Production Scale)</h2>
          <div className="overflow-x-auto">
            <table className="w-full border border-gray-800 rounded-lg overflow-hidden">
              <thead className="bg-gray-900">
                <tr>
                  <th className="text-left p-3">Category</th>
                  <th className="text-right p-3 text-green-400">MemOS</th>
                  <th className="text-right p-3 text-gray-400">Mem0</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-gray-800">
                  <td className="p-3">Overall (recall@10)</td>
                  <td className="text-right p-3">95.9%</td>
                  <td className="text-right p-3">64.1%</td>
                </tr>
                <tr className="border-t border-gray-800">
                  <td className="p-3">Temporal Reasoning</td>
                  <td className="text-right p-3">97.1%</td>
                  <td className="text-right p-3">16.3%</td>
                </tr>
                <tr className="border-t border-gray-800">
                  <td className="p-3">Contradiction Resolution</td>
                  <td className="text-right p-3">88.6%</td>
                  <td className="text-right p-3">35.7%</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h2 className="text-2xl font-semibold mb-3">Token Efficiency</h2>
          <div className="overflow-x-auto">
            <table className="w-full border border-gray-800 rounded-lg overflow-hidden">
              <thead className="bg-gray-900">
                <tr>
                  <th className="text-left p-3">Format</th>
                  <th className="text-right p-3">Tokens (20 entries)</th>
                  <th className="text-right p-3">Savings vs JSON</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-gray-800">
                  <td className="p-3">JSON (full objects)</td>
                  <td className="text-right p-3">5,479</td>
                  <td className="text-right p-3">—</td>
                </tr>
                <tr className="border-t border-gray-800">
                  <td className="p-3">Verbose TOON</td>
                  <td className="text-right p-3">1,522</td>
                  <td className="text-right p-3 text-blue-400">72.2%</td>
                </tr>
                <tr className="border-t border-gray-800">
                  <td className="p-3">Compact TOON (new)</td>
                  <td className="text-right p-3 text-green-400">1,229</td>
                  <td className="text-right p-3 text-green-400">77.6%</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
