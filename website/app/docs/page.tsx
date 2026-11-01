import { ArrowUpRight, FileText } from "lucide-react";
import type { Metadata } from "next";
import Reveal from "../_components/Reveal";
import PageHeader from "../_components/PageHeader";

export const metadata: Metadata = {
  title: "Documentation",
  description:
    "Docs for the AI Trio: MemOS, Universal MCP Toolkit, and LLM Guardian — quick starts, API references, and integration guides.",
};

const sections = [
  {
    title: "Start here",
    links: [
      {
        label: "Memory model: nodes, trust, time, packs",
        href: "https://github.com/Markgatcha/memos/blob/main/docs/concepts.md",
        internal: false,
      },
      {
        label: "Harness matrix: Claude Code, Hermes, Kilo, pi, Codex",
        href: "https://github.com/Markgatcha/memos/blob/main/docs/harness-matrix.md",
        internal: false,
      },
      {
        label: "CLI reference (all 60 commands)",
        href: "https://github.com/Markgatcha/memos/blob/main/docs/reference/cli.md",
        internal: false,
      },
      {
        label: "MCP tools (all 40)",
        href: "https://github.com/Markgatcha/memos/blob/main/docs/reference/mcp-tools.md",
        internal: false,
      },
      {
        label: "HTTP API (all 35 paths)",
        href: "https://github.com/Markgatcha/memos/blob/main/docs/reference/http-api.md",
        internal: false,
      },
      {
        label: "Website and harness research notes",
        href: "https://github.com/Markgatcha/memos/blob/main/docs/research/2026-11-website-harness-audit.md",
        internal: false,
      },
    ],
  },
  {
    title: "MemOS",
    links: [
      { label: "MemOS Overview & Quick Start", href: "/memos", internal: true },
      {
        label: "Install per harness",
        href: "/docs/install",
        internal: true,
      },
      {
        label: "Architecture Guide",
        href: "/docs/architecture",
        internal: true,
      },
      {
        label: "MCP compatibility policy",
        href: "https://github.com/Markgatcha/memos/blob/main/docs/mcp-compatibility.md",
        internal: false,
      },
      {
        label: "API Reference (GitHub README)",
        href: "https://github.com/Markgatcha/memos#readme",
        internal: false,
      },
    ],
  },
  {
    title: "Universal MCP Toolkit",
    links: [
      { label: "UMT Overview & Quick Start", href: "/umt", internal: true },
      {
        label: "API Reference (GitHub README)",
        href: "https://github.com/Markgatcha/universal-mcp-toolkit#readme",
        internal: false,
      },
    ],
  },
  {
    title: "LLM Guardian",
    links: [
      { label: "Guardian Overview & Quick Start", href: "/guardian", internal: true },
      {
        label: "Semantic Folding Playground (in-browser)",
        href: "/playground",
        internal: true,
      },
      {
        label: "API Reference (GitHub README)",
        href: "https://github.com/Markgatcha/llm-guardian#readme",
        internal: false,
      },
    ],
  },
  {
    title: "AI Trio Integration",
    links: [
      { label: "Benchmarks & methodology", href: "/benchmarks", internal: true },
      { label: "Architecture Guide", href: "/docs/architecture", internal: true },
      {
        label: "Memory Operations Guide",
        href: "https://github.com/Markgatcha/memos/blob/main/docs/memory-guide.md",
        internal: false,
      },
      {
        label: "UMT Integration Contract",
        href: "https://github.com/Markgatcha/universal-mcp-toolkit/blob/main/docs/integration-contract.md",
        internal: false,
      },
      {
        label: "UMT × MemOS shared config",
        href: "https://github.com/Markgatcha/memos/blob/main/docs/umt-integration.md",
        internal: false,
      },
      {
        label: "Guardian folded memory packs",
        href: "https://github.com/Markgatcha/memos/blob/main/docs/guardian-integration.md",
        internal: false,
      },
      {
        label: "Remote MCP and OAuth",
        href: "https://github.com/Markgatcha/memos/blob/main/docs/remote-mcp.md",
        internal: false,
      },
      {
        label: "Security model",
        href: "https://github.com/Markgatcha/memos/blob/main/docs/security-model.md",
        internal: false,
      },
      {
        label: "Operations runbook",
        href: "https://github.com/Markgatcha/memos/blob/main/docs/operations.md",
        internal: false,
      },
      {
        label: "Documentation coverage",
        href: "https://github.com/Markgatcha/memos/blob/main/docs/coverage.md",
        internal: false,
      },
      {
        label: "Context Pack Format Spec",
        href: "https://github.com/Markgatcha/memos/blob/main/docs/benchmark-quality.md",
        internal: false,
      },
    ],
  },
  {
    title: "Comparisons",
    links: [
      {
        label: "MemOS vs Mem0 vs Zep vs Letta",
        href: "/compare/memos-vs-mem0",
        internal: true,
      },
      {
        label: "UMT vs mcp-get vs supergateway",
        href: "/compare/umt-vs-mcp-get-supergateway",
        internal: true,
      },
    ],
  },
];

export default function Docs() {
  return (
    <main className="min-h-screen">
      <div className="max-w-4xl mx-auto px-6 py-16 md:py-20">
        <PageHeader
          kicker="docs"
          title="Documentation"
          subtitle="Install MemOS, wire it into a harness, look up an exact command, or run a store over time."
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {sections.map((s, i) => (
            <Reveal key={s.title} delay={i * 70}>
              <div className="card p-6 h-full">
                <h2 className="flex items-center gap-2.5 text-sm font-medium text-zinc-100 mb-4">
                  <FileText size={15} className="text-zinc-500" />
                  {s.title}
                </h2>
                <ul className="space-y-2.5">
                  {s.links.map((l) => (
                    <li key={l.href}>
                      <a
                        href={l.href}
                        {...(l.internal ? {} : { target: "_blank", rel: "noopener noreferrer" })}
                        className="arrow-link !text-[13px] !font-normal !text-zinc-400"
                      >
                        {l.label}
                        {!l.internal && <ArrowUpRight size={13} />}
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
