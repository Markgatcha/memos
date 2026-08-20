import { ArrowRight } from "lucide-react";
import type { Metadata } from "next";
import Reveal from "../../_components/Reveal";
import PageHeader from "../../_components/PageHeader";
import StarButton from "../../_components/StarButton";

export const metadata: Metadata = {
  title: "Universal MCP Toolkit vs mcp-get vs supergateway",
  description:
    "Comparing MCP tooling: Universal MCP Toolkit, mcp-get, and supergateway — what each does, when to use which, and how they compose.",
  openGraph: {
    title: "UMT vs mcp-get vs supergateway — MCP Tooling Compared",
    description:
      "One monorepo of 28 servers vs single-purpose MCP utilities. An honest breakdown.",
    images: [{ url: "/og-compare-mcp.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    images: [{ url: "/og-compare-mcp.png", width: 1200, height: 630 }],
  },
};

const rows = [
  {
    label: "What it is",
    umt: "Monorepo of 28 MCP servers + CLI + registry",
    mcpget: "CLI to search & install MCP servers from directories",
    supergateway: "Runs stdio MCP servers over SSE/WebSocket",
  },
  {
    label: "Ships servers itself",
    umt: "Yes — 28 production-focused servers",
    mcpget: "No — indexes other repos",
    supergateway: "No — transport bridge only",
  },
  {
    label: "Transports",
    umt: "stdio, SSE, MCP 2026-07-28 streamable HTTP",
    mcpget: "n/a (installs whatever the server supports)",
    supergateway: "stdio → SSE/WebSocket",
  },
  {
    label: "Config generation",
    umt: "Yes — Claude Desktop, Cursor, Cline targets",
    mcpget: "Partial — install + run hints",
    supergateway: "Manual flags",
  },
  {
    label: "Diagnostics",
    umt: "umt doctor — env checks per server",
    mcpget: "No",
    supergateway: "No",
  },
  {
    label: "Deterministic workflows",
    umt: "Yes — umt workflow validate",
    mcpget: "No",
    supergateway: "No",
  },
  {
    label: "License",
    umt: "MIT",
    mcpget: "Open source",
    supergateway: "Open source",
  },
];

export default function CompareMcp() {
  return (
    <main className="min-h-screen">
      <div className="max-w-5xl mx-auto px-6 py-16 md:py-20">
        <PageHeader
          kicker="comparison"
          title="UMT vs mcp-get vs supergateway"
          subtitle="These tools solve different problems and honestly compose well together. Here's the breakdown — written by the UMT team, so check the repos yourself."
        />

        <Reveal className="mb-12">
          <div className="card overflow-hidden overflow-x-auto">
            <table className="data-table min-w-[720px]">
              <thead>
                <tr>
                  <th></th>
                  <th className="!text-violet-400/90">UMT</th>
                  <th>mcp-get</th>
                  <th>supergateway</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.label}>
                    <td className="text-zinc-500 whitespace-nowrap">{r.label}</td>
                    <td className="text-zinc-100 font-medium">{r.umt}</td>
                    <td>{r.mcpget}</td>
                    <td>{r.supergateway}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>

        <Reveal className="mb-12" delay={80}>
          <h2 className="text-sm font-medium text-zinc-200 mb-4">
            When to pick what
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="card p-6">
              <h3 className="text-sm font-medium text-zinc-100 mb-2">UMT</h3>
              <p className="text-[13px] text-zinc-500 leading-relaxed">
                You want one maintained place for the servers themselves —
                install, config, run, and diagnostics in a single CLI.
              </p>
            </div>
            <div className="card p-6">
              <h3 className="text-sm font-medium text-zinc-100 mb-2">mcp-get</h3>
              <p className="text-[13px] text-zinc-500 leading-relaxed">
                You&apos;re browsing the wider ecosystem and want a search
                engine for community servers across many repos.
              </p>
            </div>
            <div className="card p-6">
              <h3 className="text-sm font-medium text-zinc-100 mb-2">supergateway</h3>
              <p className="text-[13px] text-zinc-500 leading-relaxed">
                You have one stdio-only server and need it on SSE/WebSocket
                right now, no monorepo required.
              </p>
            </div>
          </div>
        </Reveal>

        <Reveal delay={120}>
          <div className="flex flex-wrap gap-3">
            <a href="/umt" className="btn btn-primary">
              Explore UMT
              <ArrowRight size={15} />
            </a>
            <StarButton repo="Markgatcha/universal-mcp-toolkit" label="Star on GitHub" />
          </div>
        </Reveal>
      </div>
    </main>
  );
}
