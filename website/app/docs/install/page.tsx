import type { Metadata } from "next";
import Reveal from "../../_components/Reveal";
import PageHeader from "../../_components/PageHeader";

export const metadata: Metadata = {
  title: "Install",
  description:
    "Copy-paste MemOS MCP configuration for Claude Code, Cursor, Windsurf, Cline, OpenCode, Codex CLI, Gemini CLI, and any other harness.",
};

const server = `{
  "mcpServers": {
    "memos": {
      "command": "npx",
      "args": ["-y", "@mem-os/sdk", "mcp"]
    }
  }
}`;

const opencode = `{
  "mcp": {
    "memos": {
      "type": "local",
      "command": ["npx", "-y", "@mem-os/sdk", "mcp"]
    }
  }
}`;

const codex = `[mcp_servers.memos]
command = "npx"
args = ["-y", "@mem-os/sdk", "mcp"]`;

const harnesses = [
  {
    name: "Claude Code",
    where: "user scope, or ./.mcp.json for a project",
    command: "claude mcp add memos -s user -- npx -y @mem-os/sdk mcp",
    body: server,
  },
  {
    name: "Cursor",
    where: "~/.cursor/mcp.json",
    command: "npx -y @mem-os/sdk connect cursor --write",
    body: server,
  },
  {
    name: "Windsurf",
    where: "~/.codeium/windsurf/mcp_config.json",
    command: "npx -y @mem-os/sdk connect windsurf --write",
    body: server,
  },
  {
    name: "Cline",
    where: "VS Code globalStorage · cline_mcp_settings.json",
    command: "npx -y @mem-os/sdk connect cline --write",
    body: server,
  },
  {
    name: "OpenCode",
    where: "opencode.json (project or ~/.config/opencode)",
    command: "npx -y @mem-os/sdk connect opencode --write",
    body: opencode,
  },
  {
    name: "Codex CLI",
    where: "~/.codex/config.toml",
    command: "npx -y @mem-os/sdk connect codex --write",
    body: codex,
  },
  {
    name: "Gemini CLI",
    where: "~/.gemini/settings.json",
    command: "npx -y @mem-os/sdk connect gemini --write",
    body: server,
  },
  {
    name: "Anything else",
    where: "any stdio MCP client",
    command: "npx -y @mem-os/sdk connect generic",
    body: server,
  },
];

export default function Install() {
  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
        <PageHeader
          kicker="docs / install"
          title="Install"
          subtitle="One snippet per harness. The server is a plain stdio MCP process from npm — no account, no API key, and SQLite on your machine."
        />

        <Reveal className="mb-12">
          <div className="card p-6">
            <h2 className="text-sm font-medium text-zinc-100">
              Verify before wiring anything up
            </h2>
            <pre className="mt-4 overflow-x-auto font-mono text-[12px] leading-6 text-zinc-300">
              <code>{`npx -y @mem-os/sdk doctor
npx -y @mem-os/sdk store "The project uses pnpm workspaces"
npx -y @mem-os/sdk search "package manager"`}</code>
            </pre>
            <p className="mt-4 text-[13px] leading-relaxed text-zinc-500">
              <code className="text-zinc-300">doctor</code> should print
              &quot;no problems found&quot;, and{" "}
              <code className="text-zinc-300">search</code> should return the
              stored sentence. Data lives at{" "}
              <code className="text-zinc-300">~/.memos/memos.db</code> unless
              you set <code className="text-zinc-300">MEMOS_DB_PATH</code>.
            </p>
          </div>
        </Reveal>

        <div className="space-y-8">
          {harnesses.map((harness) => (
            <Reveal key={harness.name}>
              <section>
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-white/[0.07] pb-2">
                  <h2 className="text-lg font-medium tracking-[-0.01em] text-zinc-100">
                    {harness.name}
                  </h2>
                  <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-zinc-500">
                    {harness.where}
                  </span>
                </div>
                <p className="mt-3 font-mono text-[12px] text-zinc-400">
                  {harness.command}
                </p>
                <pre className="window mt-3 overflow-x-auto p-4 font-mono text-[12px] leading-6 text-zinc-300">
                  <code>{harness.body}</code>
                </pre>
              </section>
            </Reveal>
          ))}
        </div>

        <Reveal className="mt-12">
          <p className="text-[13px] leading-relaxed text-zinc-500">
            Full prerequisites, HTTP mode, and rollback steps live in{" "}
            <a
              href="https://github.com/Markgatcha/memos/blob/main/llms-install.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-300 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-100"
            >
              llms-install.md
            </a>
            . If you expose the Streamable HTTP transport beyond loopback, set{" "}
            <code className="text-zinc-300">MEMOS_API_KEY</code> and terminate
            TLS in front of it.
          </p>
        </Reveal>
      </div>
    </main>
  );
}
