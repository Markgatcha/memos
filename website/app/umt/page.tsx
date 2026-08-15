import { Check, ArrowRight } from "lucide-react";
import GithubIcon from "../_components/GithubIcon";
import Reveal from "../_components/Reveal";
import PageHeader from "../_components/PageHeader";

const features = [
  "MCP transport: stdio + HTTP/SSE",
  "Server registry with health checks",
  "Tool routing across providers",
  "Ollama, LangChain, and CrewAI adapters",
  "Works with any MCP-compatible client",
  "Zero-config local discovery",
];

export default function UMT() {
  return (
    <main className="min-h-screen">
      <div className="max-w-4xl mx-auto px-6 py-16 md:py-20">
        <PageHeader
          kicker="mcp toolkit"
          title="Universal MCP Toolkit"
          subtitle="MCP transport, server registry, and tool routing for AI agents. Works with MemOS, any MCP-compatible client, and local LLMs."
        />

        <Reveal className="mb-12">
          <h2 className="text-sm font-medium text-zinc-200 mb-4">Key features</h2>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
            {features.map((f) => (
              <li key={f} className="flex items-start gap-2.5 text-sm text-zinc-400">
                <Check size={15} className="text-zinc-500 mt-0.5 shrink-0" />
                {f}
              </li>
            ))}
          </ul>
        </Reveal>

        <Reveal className="mb-12" delay={80}>
          <h2 className="text-sm font-medium text-zinc-200 mb-4">Registry</h2>
          <div className="card p-6 font-mono text-[13px] space-y-2.5">
            <div className="flex justify-between">
              <span className="text-zinc-300">ollama</span>
              <span className="text-emerald-500/90">connected · 14 tools</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-300">memos</span>
              <span className="text-emerald-500/90">connected · stdio</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-300">filesystem</span>
              <span className="text-emerald-500/90">connected · http+sse</span>
            </div>
          </div>
        </Reveal>

        <Reveal delay={120}>
          <div className="flex flex-wrap gap-3">
            <a href="/docs" className="btn btn-primary">
              Read the docs
              <ArrowRight size={15} />
            </a>
            <a
              href="https://github.com/Markgatcha/universal-mcp-toolkit"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary"
            >
              <GithubIcon size={15} />
              View on GitHub
            </a>
          </div>
        </Reveal>
      </div>
    </main>
  );
}
