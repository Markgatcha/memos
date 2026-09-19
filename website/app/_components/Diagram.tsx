import type { ReactNode } from "react";

export const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

type FigureProps = {
  kicker: string;
  viewBox: string;
  label: string;
  children: ReactNode;
};

/** Card-wrapped figure matching the blog's Callout/kicker styling. */
export function Figure({ kicker, viewBox, label, children }: FigureProps) {
  return (
    <figure className="card p-5 md:p-6 my-8">
      <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-zinc-500 mb-4">
        {kicker}
      </div>
      <svg
        viewBox={viewBox}
        className="w-full h-auto"
        role="img"
        aria-label={label}
      >
        {children}
      </svg>
    </figure>
  );
}

/** Arrowhead marker defs. `id` must be unique per diagram on the page. */
export function ArrowDefs({ id }: { id: string }) {
  return (
    <defs>
      <marker
        id={id}
        viewBox="0 0 10 10"
        refX="8"
        refY="5"
        markerWidth="7"
        markerHeight="7"
        orient="auto-start-reverse"
      >
        <path
          d="M 0 1 L 9 5 L 0 9"
          fill="none"
          stroke="#52525b"
          strokeWidth="1.6"
        />
      </marker>
    </defs>
  );
}

export function HArrow({
  x1,
  x2,
  y,
  marker,
}: {
  x1: number;
  x2: number;
  y: number;
  marker: string;
}) {
  return (
    <line
      x1={x1}
      y1={y}
      x2={x2}
      y2={y}
      stroke="#52525b"
      strokeWidth={1.5}
      markerEnd={`url(#${marker})`}
    />
  );
}

export function VArrow({
  x,
  y1,
  y2,
  marker,
}: {
  x: number;
  y1: number;
  y2: number;
  marker: string;
}) {
  return (
    <line
      x1={x}
      y1={y1}
      x2={x}
      y2={y2}
      stroke="#52525b"
      strokeWidth={1.5}
      markerEnd={`url(#${marker})`}
    />
  );
}

type Tone = "zinc" | "amber" | "emerald" | "ghost";

const TONES: Record<Tone, { fill: string; stroke: string; text: string }> = {
  zinc: { fill: "#141417", stroke: "rgba(255,255,255,0.12)", text: "#d4d4d8" },
  amber: {
    fill: "rgba(251,191,36,0.07)",
    stroke: "rgba(251,191,36,0.45)",
    text: "#fcd34d",
  },
  emerald: {
    fill: "rgba(16,185,129,0.08)",
    stroke: "rgba(16,185,129,0.45)",
    text: "#6ee7b7",
  },
  ghost: {
    fill: "rgba(255,255,255,0.02)",
    stroke: "rgba(255,255,255,0.14)",
    text: "#71717a",
  },
};

export function DBox({
  x,
  y,
  w,
  h = 56,
  lines,
  tone = "zinc",
}: {
  x: number;
  y: number;
  w: number;
  h?: number;
  lines: string[];
  tone?: Tone;
}) {
  const t = TONES[tone];
  const midY = y + h / 2;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={10}
        fill={t.fill}
        stroke={t.stroke}
        strokeWidth={1}
        strokeDasharray={tone === "ghost" ? "6 5" : undefined}
      />
      <text
        x={x + w / 2}
        y={midY}
        textAnchor="middle"
        dominantBaseline="central"
        fill={t.text}
        fontSize={12}
        fontFamily={MONO}
      >
        {lines.map((line, i) => (
          <tspan
            key={i}
            x={x + w / 2}
            dy={i === 0 ? -(lines.length - 1) * 8 : 16}
          >
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
}

/** Small mono section caption, e.g. "game 1 · retrieval-only". */
export function DCaption({
  x,
  y,
  children,
  anchor = "start",
}: {
  x: number;
  y: number;
  children: string;
  anchor?: "start" | "middle" | "end";
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      fill="#71717a"
      fontSize={11}
      fontFamily={MONO}
      letterSpacing={1}
    >
      {children}
    </text>
  );
}

/** Plain annotation text under a diagram row. */
export function DNote({
  x,
  y,
  children,
  anchor = "start",
  fill = "#a1a1aa",
}: {
  x: number;
  y: number;
  children: string;
  anchor?: "start" | "middle" | "end";
  fill?: string;
}) {
  return (
    <text x={x} y={y} textAnchor={anchor} fill={fill} fontSize={12}>
      {children}
    </text>
  );
}
