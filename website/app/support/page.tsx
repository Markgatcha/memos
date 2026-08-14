import Reveal from "../_components/Reveal";

const issueLinks = [
  {
    label: "MemOS Issues",
    href: "https://github.com/Markgatcha/memos/issues",
    accent: "text-blue-400",
  },
  {
    label: "UMT Issues",
    href: "https://github.com/Markgatcha/universal-mcp-toolkit/issues",
    accent: "text-purple-400",
  },
  {
    label: "Guardian Issues",
    href: "https://github.com/Markgatcha/llm-guardian/issues",
    accent: "text-green-400",
  },
];

export default function Support() {
  return (
    <main className="min-h-screen">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <Reveal>
          <h1 className="text-4xl md:text-5xl font-bold mb-4">
            Sup<span className="text-gradient">port</span>
          </h1>
          <p className="text-gray-400 mb-10">
            Get help with MemOS, UMT, and LLM Guardian.
          </p>
        </Reveal>

        <Reveal delay={100}>
          <h2 className="text-2xl font-semibold mb-4">Discord</h2>
          <p className="text-gray-400 mb-6">
            Join our Discord server for real-time chat with developers and
            users:
          </p>
          <div className="glass-card rounded-2xl p-6 mb-10">
            <iframe
              src="https://discord.com/widget?id=YOUR_DISCORD_GUILD_ID&theme=dark"
              width="100%"
              height="500"
              frameBorder="0"
              allowFullScreen
              title="ContextCore Discord"
            />
          </div>
        </Reveal>

        <Reveal delay={160}>
          <h2 className="text-2xl font-semibold mb-4">GitHub Issues</h2>
          <ul className="space-y-3 mb-10">
            {issueLinks.map((l) => (
              <li key={l.href}>
                <a href={l.href} className={`${l.accent} link-underline`}>
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </Reveal>

        <Reveal delay={220}>
          <h2 className="text-2xl font-semibold mb-4">Documentation</h2>
          <p className="text-gray-400">
            Full docs at{" "}
            <a href="/docs" className="text-blue-400 link-underline">
              context-core.dev/docs
            </a>
          </p>
        </Reveal>
      </div>
    </main>
  );
}
