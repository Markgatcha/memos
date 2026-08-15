import { ArrowUpRight, MessageSquare, Bug } from "lucide-react";
import Reveal from "../_components/Reveal";
import PageHeader from "../_components/PageHeader";

const issueLinks = [
  { label: "MemOS Issues", href: "https://github.com/Markgatcha/memos/issues" },
  {
    label: "UMT Issues",
    href: "https://github.com/Markgatcha/universal-mcp-toolkit/issues",
  },
  { label: "Guardian Issues", href: "https://github.com/Markgatcha/llm-guardian/issues" },
];

export default function Support() {
  return (
    <main className="min-h-screen">
      <div className="max-w-3xl mx-auto px-6 py-16 md:py-20">
        <PageHeader
          kicker="support"
          title="Support"
          subtitle="Get help with MemOS, UMT, and LLM Guardian."
        />

        <Reveal className="mb-12">
          <div className="card overflow-hidden">
            <div className="flex items-center gap-2.5 px-6 py-4 border-b border-white/[0.06]">
              <MessageSquare size={15} className="text-zinc-500" />
              <span className="text-sm font-medium text-zinc-100">Discord</span>
            </div>
            <div className="p-6">
              <p className="text-sm text-zinc-400 mb-5">
                Join our Discord server for real-time chat with developers and
                users.
              </p>
              <iframe
                src="https://discord.com/widget?id=YOUR_DISCORD_GUILD_ID&theme=dark"
                width="100%"
                height="400"
                frameBorder="0"
                allowFullScreen
                title="ContextCore Discord"
              />
            </div>
          </div>
        </Reveal>

        <Reveal className="mb-12" delay={80}>
          <h2 className="flex items-center gap-2.5 text-sm font-medium text-zinc-100 mb-4">
            <Bug size={15} className="text-zinc-500" />
            GitHub issues
          </h2>
          <ul className="space-y-2">
            {issueLinks.map((l) => (
              <li key={l.href}>
                <a
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="arrow-link !text-[13px] !font-normal !text-zinc-400"
                >
                  {l.label}
                  <ArrowUpRight size={13} />
                </a>
              </li>
            ))}
          </ul>
        </Reveal>

        <Reveal delay={140}>
          <h2 className="text-sm font-medium text-zinc-100 mb-3">Documentation</h2>
          <p className="text-sm text-zinc-400">
            Full docs at{" "}
            <a href="/docs" className="text-zinc-200 underline underline-offset-4 decoration-zinc-700 hover:decoration-zinc-400">
              context-core.dev/docs
            </a>
          </p>
        </Reveal>
      </div>
    </main>
  );
}
