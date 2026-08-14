import Reveal from "../_components/Reveal";

const sections = [
  {
    title: "MemOS",
    accent: "text-blue-400",
    links: [
      { label: "→ MemOS Overview & Quick Start", href: "/memos" },
      {
        label: "→ API Reference (GitHub README)",
        href: "https://github.com/Markgatcha/memos#readme",
      },
      {
        label: "→ Architecture Guide",
        href: "https://github.com/Markgatcha/memos/blob/main/ARCHITECTURE.md",
      },
    ],
  },
  {
    title: "Universal MCP Toolkit",
    accent: "text-purple-400",
    links: [
      { label: "→ UMT Overview & Quick Start", href: "/umt" },
      {
        label: "→ API Reference (GitHub README)",
        href: "https://github.com/Markgatcha/universal-mcp-toolkit#readme",
      },
    ],
  },
  {
    title: "LLM Guardian",
    accent: "text-green-400",
    links: [
      { label: "→ Guardian Overview & Quick Start", href: "/guardian" },
      {
        label: "→ API Reference (GitHub README)",
        href: "https://github.com/Markgatcha/llm-guardian#readme",
      },
    ],
  },
  {
    title: "AI Trio Integration",
    accent: "",
    links: [
      {
        label: "→ AI Trio Documentation",
        href: "https://github.com/Markgatcha/memos/blob/main/docs/benchmark-comparison.md",
      },
      {
        label: "→ Context Pack Format Spec",
        href: "https://github.com/Markgatcha/memos/blob/main/docs/benchmark-quality.md",
      },
    ],
  },
];

export default function Docs() {
  return (
    <main className="min-h-screen">
      <div className="max-w-4xl mx-auto px-6 py-16">
        <Reveal>
          <h1 className="text-4xl md:text-5xl font-bold mb-10">
            Documen<span className="text-gradient">tation</span>
          </h1>
        </Reveal>
        <div className="space-y-6">
          {sections.map((s, i) => (
            <Reveal key={s.title} delay={i * 80}>
              <div className="glass-card rounded-2xl p-7">
                <h2 className={`text-2xl font-semibold mb-4 ${s.accent}`}>{s.title}</h2>
                <ul className="space-y-2 text-gray-300">
                  {s.links.map((l) => (
                    <li key={l.href}>
                      <a href={l.href} className="link-underline hover:text-white transition">
                        {l.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </main>
  );
}
