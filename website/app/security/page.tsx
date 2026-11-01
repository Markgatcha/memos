import type { Metadata } from "next";
import { ShieldCheck } from "lucide-react";
import Reveal from "../_components/Reveal";
import PageHeader from "../_components/PageHeader";

export const metadata: Metadata = {
  title: "Security",
  description:
    "Security policy for MemOS: private vulnerability reporting, response targets, and the local-first design that keeps memory on your machine.",
};

const design = [
  {
    title: "Local by default",
    body: "The SDK, CLI, and MCP server read and write a SQLite file on your machine. Core memory operations make no network calls and require no API key.",
  },
  {
    title: "Loopback HTTP",
    body: "The optional HTTP surface binds 127.0.0.1 unless you explicitly pass another host. Setting MEMOS_API_KEY enforces a bearer token on every route except /health, /docs, /redoc, and /openapi.json.",
  },
  {
    title: "No telemetry",
    body: "There is no phone-home path. Token-savings counters are in-process and reset when the process exits.",
  },
  {
    title: "Auditable storage",
    body: "Memories, supersede history, and provenance links live in an ordinary SQLite database you can inspect with any client. The full source is MIT licensed.",
  },
];

const timeline = [
  ["Acknowledgement", "Within 48 hours"],
  ["Initial assessment", "Within 5 business days"],
  ["Fix or mitigation", "Within 30 days, depending on severity"],
];

export default function Security() {
  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
        <PageHeader
          kicker="security"
          title="Security"
          subtitle="How to report a vulnerability, what we support, and why the default deployment keeps data local."
        />

        <Reveal className="mb-12">
          <div className="card p-6">
            <div className="flex items-center gap-2.5 mb-3">
              <ShieldCheck size={16} className="text-zinc-400" />
              <h2 className="text-sm font-medium text-zinc-100">
                Report privately
              </h2>
            </div>
            <p className="text-[14px] leading-relaxed text-zinc-400">
              Please do not open a public issue for a security problem. Use
              GitHub&apos;s private vulnerability reporting on the MemOS
              repository, or email the maintainer through the address on their
              GitHub profile. Include reproduction steps, affected versions, and
              impact.
            </p>
            <a
              href="https://github.com/Markgatcha/memos/security/advisories/new"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary mt-5"
            >
              Open a private advisory
            </a>
          </div>
        </Reveal>

        <div className="space-y-10">
          <Reveal>
            <section>
              <h2 className="text-lg font-medium tracking-[-0.01em] text-zinc-100">
                Supported versions
              </h2>
              <div className="card mt-4 overflow-hidden">
                <table className="w-full text-left text-[13px]">
                  <thead className="border-b border-white/[0.06] text-zinc-500">
                    <tr>
                      <th className="px-5 py-3 font-medium">Version</th>
                      <th className="px-5 py-3 font-medium">Supported</th>
                    </tr>
                  </thead>
                  <tbody className="text-zinc-400">
                    <tr className="border-b border-white/[0.04]">
                      <td className="px-5 py-3 font-mono">1.x (latest)</td>
                      <td className="px-5 py-3">Yes</td>
                    </tr>
                    <tr>
                      <td className="px-5 py-3 font-mono">&lt; 1.0.0</td>
                      <td className="px-5 py-3">No</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          </Reveal>

          <Reveal>
            <section>
              <h2 className="text-lg font-medium tracking-[-0.01em] text-zinc-100">
                Response targets
              </h2>
              <div className="mt-4 space-y-3">
                {timeline.map(([stage, target]) => (
                  <div
                    key={stage}
                    className="flex flex-col gap-1 border-b border-white/[0.05] pb-3 sm:flex-row sm:items-baseline sm:justify-between"
                  >
                    <span className="text-[14px] text-zinc-300">{stage}</span>
                    <span className="font-mono text-[12px] text-zinc-500">
                      {target}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </Reveal>

          <Reveal>
            <section>
              <h2 className="text-lg font-medium tracking-[-0.01em] text-zinc-100">
                Security design
              </h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                {design.map((item) => (
                  <div key={item.title} className="card p-5">
                    <h3 className="text-[14px] font-medium text-zinc-200">
                      {item.title}
                    </h3>
                    <p className="mt-2 text-[13px] leading-relaxed text-zinc-500">
                      {item.body}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          </Reveal>

          <Reveal>
            <section>
              <h2 className="text-lg font-medium tracking-[-0.01em] text-zinc-100">
                Scope
              </h2>
              <p className="mt-3 text-[14px] leading-relaxed text-zinc-400">
                In scope: the MemOS SDK, CLI, MCP server, Python HTTP server,
                plugin hooks, and the Universal MCP Toolkit. Out of scope:
                issues that require an already-compromised machine or
                unsupported versions, and reports produced solely by automated
                scanners without a demonstrated impact.
              </p>
              <p className="mt-3 text-[14px] leading-relaxed text-zinc-400">
                We will not pursue legal action against researchers who act in
                good faith, avoid privacy violations and data destruction, and
                give us reasonable time to fix the issue before disclosure.
              </p>
            </section>
          </Reveal>
        </div>
      </div>
    </main>
  );
}
