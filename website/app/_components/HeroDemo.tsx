const memories = [
  {
    id: "#848",
    text: "prefers dark mode",
    meta: "trust 0.92",
    active: true,
  },
  {
    id: "#847",
    text: "deploys on Fridays",
    meta: "trust 0.88",
    active: true,
  },
  {
    id: "#812",
    text: "uses pnpm, not npm",
    meta: "trust 0.81",
    active: true,
  },
  {
    id: "#794",
    text: "based in Berlin",
    meta: "trust 0.76",
    active: false,
  },
];

const recalled = [
  { id: "#848", text: "user prefers dark mode", trust: "0.92" },
  { id: "#847", text: "deploys on Fridays", trust: "0.88" },
  { id: "#812", text: "package manager: pnpm", trust: "0.81" },
];

/**
 * The hero artifact: a context inspector rather than a terminal.
 * It shows the actual product story in one glance — a durable memory
 * store on the left, the recalled context on the right, and a timeline
 * that survives a process restart.
 */
export default function HeroDemo() {
  return (
    <div className="relative border border-white/[0.11] bg-[#070708] text-left shadow-[0_40px_120px_-50px_rgba(0,0,0,0.9)]">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.08] px-4 py-2.5">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">
          <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-zinc-300 text-zinc-500" />
          context inspector
        </div>
        <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-500">
          <span className="hidden sm:inline">session 4f21</span>
          <span className="flex items-center gap-1.5 text-zinc-300">
            <span className="h-1 w-1 rounded-full bg-zinc-300" />
            local
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[0.82fr_1.35fr]">
        {/* Memory store */}
        <div className="hidden border-r border-white/[0.07] p-4 sm:block">
          <div className="mb-3 flex items-baseline justify-between">
            <span className="mono-label">memory store</span>
            <span className="font-mono text-[10px] tabular-nums text-zinc-500">
              847
            </span>
          </div>

          <ul className="space-y-3">
            {memories.map((m) => (
              <li
                key={m.id}
                className={`flex items-start gap-2 border-l pl-2.5 ${
                  m.active
                    ? "border-zinc-400/60"
                    : "border-white/[0.08]"
                }`}
              >
                <span
                  aria-hidden
                  className={`mt-[5px] h-1 w-1 shrink-0 ${
                    m.active ? "bg-zinc-300" : "bg-zinc-600"
                  }`}
                />
                <div className="min-w-0">
                  <div
                    className={`font-mono text-[10px] leading-tight ${
                      m.active ? "text-zinc-300" : "text-zinc-500"
                    }`}
                  >
                    <span className="text-zinc-500">{m.id}</span> {m.text}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-zinc-500">
                    {m.meta}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-5 border-t border-white/[0.07] pt-3">
            <div className="mono-label">storage</div>
            <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[10px] text-zinc-500">
              <span className="h-1 w-1 rounded-full bg-zinc-400" />
              ~/memos/memos.db
            </div>
          </div>
        </div>

        {/* Agent context */}
        <div className="relative overflow-hidden p-4">
          <div aria-hidden className="scan-line" />

          <div className="flex items-baseline justify-between gap-3">
            <span className="mono-label">agent context</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-zinc-500 sm:hidden">
              847 memories
            </span>
          </div>

          <div className="mt-2.5 flex items-start gap-2 font-mono text-[11.5px] leading-relaxed">
            <span aria-hidden className="select-none text-zinc-500">
              ›
            </span>
            <span className="text-zinc-100">plan the deploy for friday</span>
            <span className="term-caret" aria-hidden />
          </div>

          <div className="mt-5 flex items-baseline justify-between border-t border-white/[0.07] pt-3">
            <span className="mono-label">recalled 3 memories</span>
            <span className="font-mono text-[10px] tabular-nums text-zinc-300">
              14 ms
            </span>
          </div>

          <ul className="mt-2.5 space-y-[1px] border border-white/[0.07] bg-white/[0.015]">
            {recalled.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-3 border-b border-white/[0.05] px-2.5 py-2 last:border-b-0"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 font-mono text-[10px] text-zinc-500">
                    {r.id}
                  </span>
                  <span className="truncate font-mono text-[10.5px] text-zinc-300">
                    {r.text}
                  </span>
                </div>
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-zinc-500">
                  {r.trust}
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-4 flex items-center justify-between border-t border-white/[0.07] pt-3 font-mono text-[10px] uppercase tracking-[0.1em] text-zinc-500">
            <span>0 network calls</span>
            <span className="text-zinc-400">memories intact</span>
          </div>
        </div>
      </div>

      {/* Restart timeline */}
      <div className="hidden grid-cols-3 divide-x divide-white/[0.07] border-t border-white/[0.08] sm:grid">
        {[
          { step: "t+0s", label: "store", note: "#848 written" },
          { step: "t+2s", label: "restart", note: "process killed" },
          { step: "t+4s", label: "recall", note: "3 memories · 14ms" },
        ].map((s) => (
          <div key={s.label} className="px-3 py-2.5">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[10px] text-zinc-500">{s.step}</span>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-300">
                {s.label}
              </span>
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-zinc-500">
              {s.note}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
