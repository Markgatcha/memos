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

const recalled = [
  { id: "848", text: "dark mode in editors and terminals", score: "0.92" },
  { id: "812", text: "package manager: pnpm", score: "0.81" },
  { id: "847", text: "deploy window: Friday 14:00 UTC", score: "0.77" },
];

/**
 * The hero artifact: a paper index of what the agent knows, with the
 * recalled pack beside it. Deliberately not a terminal, a dashboard, or
 * a floating glass card.
 */
export default function HeroDemo() {
  return (
    <div className="border border-white/[0.16] bg-[#12160f] text-left">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.12] px-4 py-2.5">
        <span className="mono-label">memory index</span>
        <span className="font-mono text-[10px] text-zinc-500">
          847 cards · local
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
