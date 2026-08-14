import Reveal from "../_components/Reveal";

const beamRows = [
  { category: "Overall (recall@10)", memos: "95.9%", mem0: "64.1%" },
  { category: "Temporal Reasoning", memos: "97.1%", mem0: "16.3%" },
  { category: "Contradiction Resolution", memos: "88.6%", mem0: "35.7%" },
];

const tokenRows = [
  { format: "JSON (full objects)", tokens: "5,479", savings: "—" },
  { format: "Verbose TOON", tokens: "1,522", savings: "72.2%", highlight: false },
  { format: "Compact TOON (new)", tokens: "1,229", savings: "77.6%", highlight: true },
];

export default function Benchmarks() {
  return (
    <main className="min-h-screen">
      <div className="max-w-5xl mx-auto px-6 py-16">
        <Reveal>
          <h1 className="text-4xl md:text-5xl font-bold mb-4">
            Bench<span className="text-gradient">marks</span>
          </h1>
          <p className="text-gray-400 mb-10 max-w-2xl">
            Live benchmark results comparing MemOS against Mem0 and other
            memory systems.
          </p>
        </Reveal>

        <Reveal delay={100}>
          <div className="mb-10">
            <h2 className="text-2xl font-semibold mb-4">BEAM-1M (Production Scale)</h2>
            <div className="glass-card rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-gray-400">
                    <th className="text-left p-4 font-medium">Category</th>
                    <th className="text-right p-4 font-medium text-green-400">MemOS</th>
                    <th className="text-right p-4 font-medium">Mem0</th>
                  </tr>
                </thead>
                <tbody>
                  {beamRows.map((r) => (
                    <tr key={r.category} className="border-b border-white/5 last:border-0">
                      <td className="p-4 text-gray-300">{r.category}</td>
                      <td className="text-right p-4 text-green-400 font-semibold">{r.memos}</td>
                      <td className="text-right p-4 text-gray-500">{r.mem0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Reveal>

        <Reveal delay={160}>
          <div>
            <h2 className="text-2xl font-semibold mb-4">Token Efficiency</h2>
            <div className="glass-card rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-gray-400">
                    <th className="text-left p-4 font-medium">Format</th>
                    <th className="text-right p-4 font-medium">Tokens (20 entries)</th>
                    <th className="text-right p-4 font-medium">Savings vs JSON</th>
                  </tr>
                </thead>
                <tbody>
                  {tokenRows.map((r) => (
                    <tr key={r.format} className="border-b border-white/5 last:border-0">
                      <td className="p-4 text-gray-300">{r.format}</td>
                      <td className="text-right p-4 text-gray-300">{r.tokens}</td>
                      <td
                        className={`text-right p-4 font-semibold ${
                          r.highlight
                            ? "text-green-400"
                            : r.savings !== "—"
                              ? "text-blue-400"
                              : "text-gray-500"
                        }`}
                      >
                        {r.savings}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Reveal>
      </div>
    </main>
  );
}
