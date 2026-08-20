"use client";

import { useEffect, useRef, useState } from "react";

type Bar = {
  label: string;
  value: number; // 0-100
  display: string; // formatted value shown at the end of the bar
  accent?: boolean; // highlight color (emerald) vs neutral
  note?: string;
};

type BenchmarkChartProps = {
  title?: string;
  bars: Bar[];
  footnote?: string;
};

/**
 * Pure-CSS horizontal bar chart. Renders as a static, screenshot-friendly
 * graphic — bars animate in once when scrolled into view.
 */
export default function BenchmarkChart({ title, bars, footnote }: BenchmarkChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.3 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className="card p-6 md:p-7">
      {title && (
        <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-zinc-500 mb-6">
          {title}
        </div>
      )}
      <div className="space-y-5">
        {bars.map((b) => (
          <div key={b.label}>
            <div className="flex justify-between items-baseline mb-2">
              <span className="text-sm text-zinc-300">{b.label}</span>
              <span
                className={`font-mono text-sm tabular-nums ${
                  b.accent ? "text-emerald-400 font-medium" : "text-zinc-500"
                }`}
              >
                {b.display}
              </span>
            </div>
            <div className="h-2.5 rounded-full bg-zinc-800/80 overflow-hidden">
              <div
                className={`h-full rounded-full transition-[width] duration-1000 ease-out ${
                  b.accent ? "bg-emerald-500/90" : "bg-zinc-600"
                }`}
                style={{ width: visible ? `${b.value}%` : "0%" }}
              />
            </div>
            {b.note && (
              <div className="mt-1.5 font-mono text-[11px] text-zinc-600">{b.note}</div>
            )}
          </div>
        ))}
      </div>
      {footnote && (
        <p className="mt-6 pt-4 border-t border-white/[0.06] text-xs text-zinc-600 leading-relaxed">
          {footnote}
        </p>
      )}
    </div>
  );
}
