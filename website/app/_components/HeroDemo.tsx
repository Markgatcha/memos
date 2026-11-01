const memories = [
  {
    id: "848",
    text: "Prefers dark mode in editors and terminals.",
    meta: "preference · trust 0.92",
  },
  {
    id: "847",
    text: "Deploys on Fridays at 14:00 UTC.",
    meta: "fact · trust 0.88",
  },
  {
    id: "812",
    text: "Uses pnpm, not npm.",
    meta: "fact · trust 0.81",
  },
  {
    id: "794",
    text: "Based in Berlin.",
    meta: "fact · superseded",
    historical: true,
  },
];

const toneClass: Record<string, string> = {
  cmd: "text-zinc-100",
  ok: "text-zinc-100",
  dim: "text-zinc-500",
  out: "text-zinc-300",
};

/**
 * The hero artifact: a paper index of what the agent knows, with the
 * recalled pack beside it. Deliberately not a terminal, a dashboard, or
 * a floating glass card.
 */
export default function HeroDemo() {
  return (
    <div className="window max-w-2xl mx-auto text-left">
      <div className="window-bar">
        <span className="window-dot" />
        <span className="window-dot" />
        <span className="window-dot" />
        <span className="window-title">memory survives restarts — live demo</span>
        <span className="ml-auto window-title text-zinc-100/80">● local</span>
      </div>
      <div className="p-5 font-mono text-[13px] leading-7 min-h-[172px]">
        {current.lines.map((l, i) => (
          <div
            key={`${cycle}-${scene}-${i}`}
            className="term-line whitespace-pre-wrap"
            style={{ animationDelay: `${0.15 + i * 0.55}s` }}
          >
            {l.tone === "cmd" ? (
              <>
                <span className="text-zinc-600 select-none">$ </span>
                <span className={toneClass[l.tone]}>{l.text.slice(2)}</span>
              </>
            ) : (
              <span className={toneClass[l.tone]}>{l.text}</span>
            )}
          </div>
        ))}
        <div
          className="term-line"
          style={{ animationDelay: `${0.15 + current.lines.length * 0.55}s` }}
        >
          <span className="text-zinc-600 select-none">$ </span>
          <span className="term-caret" />
        </div>
      </div>
      <div className="px-5 pb-4 flex items-center gap-2">
        {scenes.map((_, i) => (
          <span
            key={i}
            className={`h-1 rounded-full transition-all duration-300 ${
              i === scene ? "w-6 bg-zinc-400" : "w-1.5 bg-zinc-700"
            }`}
          />
        ))}
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-600">
          loops forever · no cloud
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[0.9fr_1.1fr]">
        <div className="border-b border-white/[0.09] p-4 sm:border-b-0 sm:border-r">
          <div className="mb-3 flex items-baseline justify-between">
            <span className="mono-label">stored</span>
            <span className="font-mono text-[10px] tabular-nums text-zinc-500">
              newest first
            </span>
          </div>

          <ul className="space-y-2">
            {memories.map((memory) => (
              <li
                key={memory.id}
                className={`border-l pl-2.5 ${
                  memory.historical
                    ? "border-white/[0.08]"
                    : "border-accent/60"
                }`}
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[9px] text-zinc-500">
                    #{memory.id}
                  </span>
                  <span
                    className={`font-serif text-[13px] leading-snug ${
                      memory.historical
                        ? "text-zinc-500 line-through decoration-zinc-600"
                        : "text-zinc-200"
                    }`}
                  >
                    {memory.text}
                  </span>
                </div>
                <div className="mt-0.5 font-mono text-[9px] text-zinc-500">
                  {memory.meta}
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-4 border-t border-white/[0.09] pt-2.5 font-mono text-[9px] text-zinc-500">
            ~/memos/memos.db
          </div>
        </div>

        <div className="p-4">
          <div className="mono-label">recalled for</div>
          <p className="mt-1.5 font-serif text-[17px] italic leading-snug text-zinc-100">
            “What does the user prefer for editing?”
          </p>

          <div className="mt-4 space-y-2.5">
            {recalled.map((item) => (
              <div
                key={item.id}
                className="grid grid-cols-[1fr_auto] items-baseline gap-3 border-b border-white/[0.07] pb-2 last:border-b-0"
              >
                <div>
                  <div className="font-serif text-[13px] leading-snug text-zinc-300">
                    {item.text}
                  </div>
                  <div className="mt-0.5 font-mono text-[9px] text-zinc-500">
                    [mem:#{item.id}]
                  </div>
                </div>
                <span className="font-mono text-[10px] tabular-nums text-zinc-500">
                  {item.score}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/[0.09] pt-2.5 font-mono text-[9px] text-zinc-500">
            <span>pack: 118 tokens</span>
            <span className="text-zinc-500">3 of 847</span>
          </div>
        </div>
      </div>
    </div>
  );
}
