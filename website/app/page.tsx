import {
  ArrowRight,
  ArrowUpRight,
  Brain,
  Cable,
  Code2,
  Database,
  Gauge,
  ShieldCheck,
} from "lucide-react";
import Reveal from "./_components/Reveal";
import Terminal from "./_components/Terminal";
import HeroDemo from "./_components/HeroDemo";
import StackDiagram from "./_components/StackDiagram";
import InstallCommand from "./_components/InstallCommand";
import StarButton from "./_components/StarButton";
import { posts } from "../lib/posts";

const integrations = [
  "Hermes Agent",
  "Claude Code",
  "Kilo Code",
  "Codex",
  "Cline",
  "Cursor",
  "Zed",
  "MCP",
];

const stats = [
  {
    value: 99.4,
    decimals: 1,
    suffix: "%",
    label: "LongMemEval Hit@20",
    note: "500 questions · retrieval-only · nomic 768d",
  },
  {
    value: 65.0,
    decimals: 1,
    suffix: "%",
    label: "LoCoMo Hit@10",
    note: "1,986 questions · local bge-small",
  },
  {
    value: 78.0,
    decimals: 1,
    suffix: "%",
    label: "QA accuracy",
    note: "50 questions · independent GLM judge",
  },
];

const principles = [
  {
    icon: Database,
    title: "One SQLite file",
    text: "Back it up with cp. Delete it with rm. No export tool, no lock-in, no hosted copy.",
  },
  {
    icon: ShieldCheck,
    title: "No network calls",
    text: "Retrieval, reranking, and compression run on your hardware. Zero API keys required.",
  },
  {
    icon: Code2,
    title: "MIT, all the way down",
    text: "Fork it, audit it, ship it. No paid tier hiding the good features behind a plan.",
  },
];

const products = [
  {
    index: "01",
    name: "MemOS",
    role: "persistent memory",
    icon: Brain,
    copy: "Graph-native memory on local SQLite with temporal validity, trust scoring, and a compact context format.",
    meta: "99.4% LongMemEval Hit@20",
    href: "/memos",
    visual: (
      <div className="space-y-[1px] border border-white/[0.08] bg-white/[0.015] font-mono text-[10px]">
        {[
          ["#848", "prefers dark mode", "0.92"],
          ["#847", "deploys on Fridays", "0.88"],
          ["#812", "package manager: pnpm", "0.81"],
        ].map(([id, text, trust]) => (
          <div
            key={id}
            className="flex items-center gap-2 border-b border-white/[0.05] px-2.5 py-1.5 last:border-b-0"
          >
            <span className="text-zinc-500">{id}</span>
            <span className="truncate text-zinc-400">{text}</span>
            <span className="ml-auto text-zinc-500">{trust}</span>
          </div>
        ))}
      </div>
    ),
  },
  {
    index: "02",
    name: "Universal MCP Toolkit",
    role: "tool transport",
    icon: Cable,
    copy: "Registry, transport, and routing for MCP servers across every major client — one config, no glue scripts.",
    meta: "28 servers · stdio + HTTP/SSE",
    href: "/umt",
    visual: (
      <div className="space-y-1.5 border border-white/[0.08] bg-white/[0.015] px-2.5 py-2 font-mono text-[10px]">
        {[
          ["ollama", "connected"],
          ["github", "ready"],
          ["postgres", "ready"],
        ].map(([name, state]) => (
          <div key={name} className="flex items-center justify-between">
            <span className="text-zinc-500">{name}</span>
            <span className="flex items-center gap-1.5 text-zinc-400">
              <span className="h-1 w-1 rounded-full bg-zinc-300" />
              {state}
            </span>
          </div>
        ))}
      </div>
    ),
  },
  {
    index: "03",
    name: "LLM Guardian",
    role: "token control",
    icon: Gauge,
    copy: "Sits between your app and the provider: folds prompts, injects a token-budgeted memory pack, and enforces limits.",
    meta: "80–95% prompt compression",
    href: "/guardian",
    visual: (
      <div className="space-y-2 border border-white/[0.08] bg-white/[0.015] px-2.5 py-2.5 font-mono text-[10px]">
        <div>
          <div className="mb-1 flex justify-between text-zinc-500">
            <span>raw</span>
            <span>12,408</span>
          </div>
          <div className="h-[3px] w-full bg-zinc-700">
            <div className="h-full w-full bg-zinc-600" />
          </div>
        </div>
        <div>
          <div className="mb-1 flex justify-between text-zinc-400">
            <span>compressed</span>
            <span>2,767</span>
          </div>
          <div className="h-[3px] w-full bg-zinc-800">
            <div className="h-full w-[22%] bg-zinc-200" />
          </div>
        </div>
      </div>
    ),
  },
];

const evidence = [
  {
    metric: "LongMemEval-S · Hit@20",
    value: "99.4%",
    note: "500 questions · retrieval-only · nomic 768d",
  },
  {
    metric: "LoCoMo · Hit@10",
    value: "65.0%",
    note: "1,986 questions · local bge-small · repeatable",
  },
  {
    metric: "ConvoMem · Hit@10",
    value: "91.0%",
    note: "387 questions · all-MiniLM · local",
  },
  {
    metric: "End-to-end QA · 50q",
    value: "78.0%",
    note: "independent GLM-5.3 judge · 95% CI 66–88%",
  },
];

export default function Home() {
  return (
    <main className="min-h-screen">
      {/* ---------------- Hero ---------------- */}
      <section className="relative overflow-hidden border-b border-white/[0.07]">
        <div className="relative mx-auto max-w-6xl px-6 pb-14 pt-14 md:pb-20 md:pt-24">
          <div className="grid items-center gap-12 lg:grid-cols-[1.02fr_1fr] lg:gap-10">
            <div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-[10px] tracking-[0.02em] text-zinc-500">
                <span className="flex items-center gap-2 text-zinc-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                  open source
                </span>
                <span className="text-zinc-600">·</span>
                <span>local-first</span>
                <span className="text-zinc-600">·</span>
                <span>MIT</span>
              </div>

              <h1 className="display mt-6 text-[3rem] text-zinc-50 sm:text-6xl xl:text-[4.6rem]">
                Your agents run
                <br />
                on your machine.
                <br />
                Their memory should too.
              </h1>

              <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-zinc-400 md:text-base">
                MemOS keeps what an agent learns in a SQLite file. UMT connects
                the tools. Guardian keeps the prompt small. No account, no
                cloud, and no API key in the critical path.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-3">
                <a href="/docs" className="btn btn-primary">
                  Read the field guide
                  <ArrowRight size={14} />
                </a>
                <StarButton repo="Markgatcha/memos" label="Star on GitHub" />
              </div>

              <div className="mt-6">
                <InstallCommand
                  command="npm install @mem-os/sdk"
                  note="quick start"
                />
              </div>

              <div className="mt-8 hidden flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[10px] tracking-[0.02em] text-zinc-500 sm:flex">
                <span>MIT licensed</span>
                <span aria-hidden className="h-3 w-px bg-white/10" />
                <span>runs on a laptop</span>
                <span aria-hidden className="h-3 w-px bg-white/10" />
                <span>zero telemetry</span>
              </div>
            </div>

            <div>
              <HeroDemo />
              <div className="mt-3 flex items-center justify-between font-mono text-[10px] tracking-[0.02em] text-zinc-500">
                <span>the memory index, not a mockup</span>
                <span className="hidden sm:inline">nothing leaves the panel</span>
              </div>
            </div>
          </div>
        </div>

        <div className="border-t border-white/[0.07]">
          <div className="mx-auto flex max-w-6xl flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:gap-6">
            <span className="mono-label shrink-0">Works with</span>
            <div className="flex flex-wrap items-center gap-x-7 gap-y-2 font-mono text-[10px] tracking-[0.02em] text-zinc-500">
              {integrations.map((name) => (
                <span
                  key={name}
                  className="transition-colors hover:text-zinc-200"
                >
                  {name}
                </span>
              ))}
            </div>
            <a
              href="/docs/install"
              className="mono-label hidden transition-colors hover:text-zinc-200 sm:ml-auto sm:inline"
            >
              all harnesses →
            </a>
          </div>
        </div>
      </section>

      {/* ---------------- Stats ---------------- */}
      <section className="border-b border-white/[0.07]">
        <div className="mx-auto max-w-6xl px-6">
          <div className="grid grid-cols-3 divide-x divide-white/[0.07]">
            {stats.map((s, i) => (
              <Reveal
                key={s.label}
                delay={i * 80}
                className="px-3 first:pl-0 last:pr-0 sm:px-8"
              >
                <a
                  href="/benchmarks#methodology"
                  className="group block py-6 sm:py-8"
                >
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="mono-label">0{i + 1}</span>
                    <span className="hidden font-mono text-[10px] tracking-[0.02em] text-zinc-500 transition-colors group-hover:text-zinc-300 sm:inline">
                      source ↗
                    </span>
                  </div>
                  <div className="mt-4 font-serif text-[1.8rem] tabular-nums tracking-[-0.03em] text-zinc-50 sm:mt-5 sm:text-4xl md:text-5xl">
                    {s.value.toFixed(s.decimals)}
                    {s.suffix}
                  </div>
                  <div className="mt-2 text-[10px] leading-snug text-zinc-400 transition-colors group-hover:text-zinc-200 sm:text-[12px]">
                    {s.label}
                  </div>
                  <div className="mt-1 hidden font-mono text-[10px] tracking-[0.02em] text-zinc-500 sm:block">
                    {s.note}
                  </div>
                </a>
              </Reveal>
            ))}
          </div>
          <div className="flex justify-end pb-4">
            <a
              href="/benchmarks#methodology"
              className="mono-label transition-colors hover:text-zinc-300"
            >
              how we measure →
            </a>
          </div>
        </div>
      </section>

      {/* ---------------- The stack ---------------- */}
      <section id="stack" className="scroll-mt-16">
        <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
          <Reveal className="mb-10 grid gap-5 md:grid-cols-2 md:items-end">
            <div>
              <div className="kicker mb-5">the stack</div>
              <h2 className="display text-4xl text-zinc-50 md:text-5xl">
                Three layers.
                <br />
                One machine.
              </h2>
            </div>
            <p className="max-w-md text-sm leading-relaxed text-zinc-400 md:justify-self-end md:text-[15px]">
              Each tool works on its own. Together they close the loop between
              what your agent remembers, what it can do, and what it costs.
            </p>
          </Reveal>

          <Reveal>
            <StackDiagram />
          </Reveal>

          <div className="mt-10 border-t border-white/[0.08]">
            {products.map((p, i) => (
              <Reveal key={p.name} delay={i * 70}>
                <div className="product-row grid gap-5 border-b border-white/[0.08] py-7 md:grid-cols-[40px_1.15fr_0.85fr_auto] md:items-center md:gap-8">
                  <span className="hidden font-mono text-[10px] text-zinc-500 md:block md:self-start md:pt-1">
                    {p.index}
                  </span>
                  <div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <p.icon
                        size={15}
                        strokeWidth={1.7}
                        className="text-zinc-400"
                      />
                      <h3 className="text-lg font-medium tracking-[-0.02em] text-zinc-100">
                        {p.name}
                      </h3>
                      <span className="mono-label">{p.role}</span>
                    </div>
                    <p className="mt-2.5 max-w-sm text-[13px] leading-relaxed text-zinc-500">
                      {p.copy}
                    </p>
                  </div>
                  <div className="max-w-[260px]">{p.visual}</div>
                  <div className="flex items-center justify-between gap-6 md:flex-col md:items-end md:gap-3">
                    <span className="font-mono text-[10px] tracking-[0.02em] text-zinc-500">
                      {p.meta}
                    </span>
                    <a
                      href={p.href}
                      className="arrow-link"
                      aria-label={`Explore ${p.name}`}
                    >
                      Explore
                      <ArrowRight size={14} />
                    </a>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- Guarantee ---------------- */}
      <section className="invert-focus bg-zinc-100 text-zinc-950">
        <div className="mx-auto max-w-6xl px-6 py-20 md:py-24">
          <div className="flex items-center justify-between border-b border-black/15 pb-3 font-mono text-[10px] tracking-[0.02em] text-black/55">
            <span>the guarantee</span>
            <span className="hidden sm:inline">context-core.dev</span>
          </div>

          <div className="mt-10 grid gap-8 md:grid-cols-[1.2fr_1fr] md:items-end">
            <h2 className="display text-4xl text-zinc-950 md:text-6xl">
              Nothing leaves
              <br />
              this machine.
            </h2>
            <p className="max-w-sm text-sm leading-relaxed text-black/60 md:justify-self-end md:text-[15px]">
              No sync daemon, no telemetry, no account. The database is a file,
              the models run locally, and the source is MIT.
            </p>
          </div>

          <div className="mt-14 grid border-t border-black/20 sm:grid-cols-3">
            {principles.map((p, i) => (
              <div
                key={p.title}
                className="border-b border-black/15 py-6 sm:border-b-0 sm:border-r sm:px-7 sm:first:pl-0 sm:last:border-r-0 sm:last:pr-0"
              >
                <div className="flex items-center justify-between font-mono text-[10px] tracking-[0.02em] text-black/55">
                  <span>0{i + 1}</span>
                  <p.icon size={14} strokeWidth={1.6} />
                </div>
                <h3 className="mt-6 text-[15px] font-medium">{p.title}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-black/60">
                  {p.text}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-10 flex flex-col gap-3 font-mono text-[10px] tracking-[0.02em] text-black/55 sm:flex-row sm:items-center sm:justify-between">
            <span>0 bytes egress · 0 accounts · 0 API keys</span>
            <a
              href="/docs/architecture"
              className="link-underline w-fit text-black/70 hover:text-black"
            >
              read the architecture →
            </a>
          </div>
        </div>
      </section>

      {/* ---------------- Evidence ---------------- */}
      <section className="border-b border-white/[0.07]">
        <div className="mx-auto max-w-6xl px-6 py-20 md:py-24">
          <Reveal className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:items-start">
            <div>
              <div className="kicker mb-5">evidence</div>
              <h2 className="display text-4xl text-zinc-50 md:text-5xl">
                Numbers,
                <br />
                with receipts.
              </h2>
              <p className="mt-5 max-w-sm text-sm leading-relaxed text-zinc-400">
                Retrieval runs use direct evidence matching; the QA row uses an
                independent judge. Ties are reported as ties, and every figure
                traces back to a committed result file.
              </p>
              <a href="/benchmarks#methodology" className="btn btn-secondary mt-7">
                All benchmarks &amp; methodology
                <ArrowRight size={14} />
              </a>
            </div>

            <div className="border border-white/[0.09] bg-[#070708]">
              {evidence.map((row, i) => (
                <div
                  key={row.metric}
                  className={`grid grid-cols-[1fr_auto] items-baseline gap-x-6 gap-y-1 px-5 py-4 ${
                    i !== evidence.length - 1
                      ? "border-b border-white/[0.07]"
                      : ""
                  }`}
                >
                  <div className="font-mono text-[10px] tracking-[0.02em] text-zinc-500">
                    {row.metric}
                  </div>
                  <div className="font-serif text-2xl tabular-nums tracking-[-0.02em] text-zinc-50">
                    {row.value}
                  </div>
                  <div className="col-span-2 font-mono text-[10px] text-zinc-500">
                    {row.note}
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-between border-t border-white/[0.07] px-5 py-3 font-mono text-[10px] tracking-[0.02em] text-zinc-500">
                <span>raw artifacts in repo</span>
                <span className="text-zinc-500">updated oct 2026</span>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---------------- Writing ---------------- */}
      <section>
        <div className="mx-auto max-w-6xl px-6 py-20 md:py-24">
          <Reveal className="mb-9 flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="kicker mb-5">writing</div>
              <h2 className="display text-4xl text-zinc-50 md:text-5xl">
                Notes from the
                <br />
                benchmark runs.
              </h2>
            </div>
            <a
              href="/blogs"
              className="arrow-link mb-1 font-mono !text-[10px] tracking-[0.02em]"
            >
              All posts
              <ArrowRight size={13} />
            </a>
          </Reveal>

          <div className="border-t border-white/[0.08]">
            {posts.slice(0, 3).map((p, i) => (
              <Reveal key={p.href} delay={i * 60}>
                <a
                  href={p.href}
                  {...(p.internal
                    ? {}
                    : { target: "_blank", rel: "noopener noreferrer" })}
                  className="group grid gap-3 border-b border-white/[0.08] py-6 transition-colors hover:bg-white/[0.015] md:grid-cols-[150px_1fr_24px] md:items-start md:gap-8"
                >
                  <div className="pt-0.5 font-mono text-[10px] tracking-[0.02em] text-zinc-500">
                    <div>{p.date}</div>
                    <div className="mt-1 text-zinc-500">{p.tag}</div>
                  </div>
                  <div>
                    <h3 className="max-w-2xl text-balance text-lg font-medium leading-snug tracking-[-0.02em] text-zinc-100">
                      {p.title}
                    </h3>
                    <p className="mt-2 line-clamp-2 max-w-2xl text-[13px] leading-relaxed text-zinc-500">
                      {p.excerpt}
                    </p>
                  </div>
                  <ArrowUpRight
                    size={16}
                    aria-hidden
                    className="hidden text-zinc-500 transition-colors group-hover:text-zinc-200 md:mt-1 md:block"
                  />
                </a>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- Get started ---------------- */}
      <section className="border-t border-white/[0.07]">
        <div className="mx-auto max-w-6xl px-6 py-20 md:py-24">
          <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
            <Reveal className="min-w-0">
              <div className="kicker mb-5">get started</div>
              <h2 className="display text-4xl text-zinc-50 md:text-6xl">
                Read the code.
                <br />
                Run the demo.
                <br />
                <span className="text-fade">Keep the file.</span>
              </h2>
              <p className="mt-6 max-w-md text-sm leading-relaxed text-zinc-400 md:text-[15px]">
                No account, no trial, no usage meter. One command and a SQLite
                file that stays on your disk.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <a href="/docs" className="btn btn-primary">
                  Read the docs
                  <ArrowRight size={14} />
                </a>
                <StarButton repo="Markgatcha/memos" label="Star on GitHub" />
              </div>
              <div className="mt-5">
                <InstallCommand
                  command="npx -y @mem-os/sdk init --yes"
                  note="after install"
                />
              </div>
            </Reveal>

            <Reveal delay={100} className="min-w-0">
              <Terminal />
              <div className="mt-3 flex items-center justify-between font-mono text-[10px] tracking-[0.02em] text-zinc-500">
                <span>fig. 2 / first run</span>
                <span>local only</span>
              </div>
            </Reveal>
          </div>
        </div>
      </section>
    </main>
  );
}
