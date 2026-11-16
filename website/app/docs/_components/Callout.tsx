import type { ReactNode } from "react";

const tones = {
  note: "border-white/10 bg-white/[0.03]",
  tip: "border-emerald-400/20 bg-emerald-400/[0.06]",
  warn: "border-amber-400/25 bg-amber-400/[0.07]",
  danger: "border-red-400/25 bg-red-400/[0.07]",
} as const;

const labels = {
  note: "Note",
  tip: "Tip",
  warn: "Watch out",
  danger: "Breaking",
} as const;

export function Callout({
  type = "note",
  title,
  children,
}: {
  type?: keyof typeof tones;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={`my-6 rounded-lg border px-4 py-3.5 ${tones[type]}`}>
      <p className="mono-label mb-1.5 !text-[10px] text-zinc-400">
        {title ?? labels[type]}
      </p>
      <div className="docs-callout text-[14px] leading-6 text-zinc-300">
        {children}
      </div>
    </div>
  );
}
