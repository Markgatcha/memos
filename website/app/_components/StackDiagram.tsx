import { ArrowDown, ArrowRight, Brain, Cable, Gauge } from "lucide-react";

const layers = [
  {
    icon: Brain,
    name: "MemOS",
    role: "memory",
    note: "recall · temporal validity · trust",
  },
  {
    icon: Cable,
    name: "UMT",
    role: "tools",
    note: "MCP transport · registry · routing",
  },
  {
    icon: Gauge,
    name: "Guardian",
    role: "budget",
    note: "fold · shard · enforce",
  },
];

function AgentCard() {
  return (
    <div className="flex h-full flex-col justify-between border border-white/[0.1] bg-white/[0.015] p-4">
      <div>
        <div className="mono-label">01 / caller</div>
        <div className="mt-2 text-sm font-medium text-zinc-100">
          Your agent
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-zinc-500">
          Claude Code, Cursor, a script — any harness that speaks MCP or HTTP.
        </p>
      </div>
      <div className="mt-5 border-t border-white/[0.07] pt-3 font-mono text-[10px] text-zinc-500">
        <span className="text-zinc-500">› </span>
        what do I know about this user?
      </div>
    </div>
  );
}

function ModelCard() {
  return (
    <div className="flex h-full flex-col justify-between border border-white/[0.1] bg-white/[0.015] p-4">
      <div>
        <div className="mono-label">03 / target</div>
        <div className="mt-2 text-sm font-medium text-zinc-100">Any LLM</div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-zinc-500">
          Local or hosted. It only sees the context you chose to send.
        </p>
      </div>
      <div className="mt-5 border-t border-white/[0.07] pt-3 font-mono text-[10px] text-zinc-500">
        <span className="text-zinc-500">← </span>
        2,767 tokens · not 12,408
      </div>
    </div>
  );
}

function FlowArrow({ vertical = false }: { vertical?: boolean }) {
  if (vertical) {
    return (
      <div className="flex items-center justify-center gap-2 py-2 md:hidden">
        <span className="h-8 w-px border-l border-dashed border-white/20" />
        <ArrowDown size={13} className="text-zinc-500" />
        <span className="h-8 w-px border-l border-dashed border-white/20" />
      </div>
    );
  }

  return (
    <div className="hidden flex-col items-center justify-center gap-1.5 md:flex">
      <span className="font-mono text-[10px] tracking-[0.02em] text-zinc-500">
        mcp
      </span>
      <div className="flex w-full items-center gap-1">
        <span className="h-px flex-1 border-t border-dashed border-white/20" />
        <ArrowRight size={13} className="shrink-0 text-zinc-500" />
      </div>
      <span className="font-mono text-[10px] tracking-[0.02em] text-zinc-500">
        local
      </span>
    </div>
  );
}

/**
 * Figure 1 on the homepage: the whole product in one request path.
 * Built with layout instead of an SVG so it stays legible and reflows
 * rather than shrinking to unreadable type on phones.
 */
export default function StackDiagram() {
  return (
    <figure className="border border-white/[0.12] bg-panel">
      <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-2 font-mono text-[10px] tracking-[0.02em] text-zinc-500">
        <span>figure 1 / one request path</span>
        <span className="text-zinc-500">0 cloud hops</span>
      </div>

      <div className="grid items-stretch gap-3 p-4 md:grid-cols-[1fr_54px_1.55fr_54px_1fr] md:gap-0 md:p-6">
        <AgentCard />

        <FlowArrow vertical />
        <FlowArrow />

        {/* Local boundary */}
        <div className="relative border border-dashed border-white/20 bg-white/[0.018] p-3">
          <div className="mb-3 flex items-center justify-between">
            <span className="font-mono text-[10px] tracking-[0.02em] text-zinc-400">
              your machine
            </span>
            <span className="font-mono text-[10px] tracking-[0.02em] text-zinc-500">
              no egress
            </span>
          </div>

          <div className="mono-label mb-2">02 / context core</div>

          <div className="divide-y divide-white/[0.08] border border-white/[0.1] bg-[#12160f]">
            {layers.map((l) => (
              <div
                key={l.name}
                className="flex items-center gap-3 px-3 py-2.5"
              >
                <l.icon
                  size={14}
                  strokeWidth={1.7}
                  className="shrink-0 text-zinc-400"
                />
                <span className="w-[70px] shrink-0 text-[13px] font-medium text-zinc-100">
                  {l.name}
                </span>
                <span className="shrink-0 font-mono text-[10px] tracking-[0.02em] text-zinc-500">
                  {l.role}
                </span>
                <span className="ml-auto hidden truncate font-mono text-[10px] text-zinc-500 sm:block">
                  {l.note}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-3 flex items-center justify-between gap-2 font-mono text-[10px]">
            <span className="flex items-center gap-1.5 text-zinc-500">
              <span className="h-1 w-1 rounded-full bg-zinc-300" />
              sqlite
            </span>
            <span className="truncate text-zinc-500">~/memos/memos.db</span>
          </div>
        </div>

        <FlowArrow vertical />
        <FlowArrow />

        <ModelCard />
      </div>

      <figcaption className="figure-caption border-t border-white/[0.07] px-4 py-3 md:px-6">
        Figure 1 — Your agent reads and writes through ContextCore. MemOS
        supplies memory, UMT supplies tools, Guardian trims the prompt. The
        model only ever sees the result.
      </figcaption>
    </figure>
  );
}
