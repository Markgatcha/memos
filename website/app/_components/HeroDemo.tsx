"use client";

import { useEffect, useState } from "react";

/**
 * Looping "memory survives restarts" demo. Plays a short terminal scene:
 * store a memory → kill the process → restart → recall. Then loops.
 * This is the hero story of MemOS told in ~12 seconds of animation.
 */

type Scene = {
  lines: { text: string; tone: "cmd" | "ok" | "dim" | "out" }[];
  hold: number; // ms to hold this scene before advancing
};

const scenes: Scene[] = [
  {
    hold: 3400,
    lines: [
      { text: "$ memos add \"user prefers dark mode, deploys on Fridays\"", tone: "cmd" },
      { text: "✓ stored · memory #848 · trust 0.92 · valid from now", tone: "ok" },
    ],
  },
  {
    hold: 2600,
    lines: [
      { text: "$ kill -9 $AGENT_PID", tone: "cmd" },
      { text: "process terminated. conversation gone.", tone: "dim" },
    ],
  },
  {
    hold: 2600,
    lines: [
      { text: "$ agent start   # fresh process, empty context", tone: "cmd" },
      { text: "agent online · 0 messages in context", tone: "dim" },
    ],
  },
  {
    hold: 4200,
    lines: [
      { text: "$ memos recall \"what does the user prefer?\"", tone: "cmd" },
      { text: "→ \"user prefers dark mode, deploys on Fridays\"", tone: "out" },
      { text: "✓ recalled in 14ms · sqlite · 0 cloud calls", tone: "ok" },
    ],
  },
];

const toneClass: Record<string, string> = {
  cmd: "text-zinc-100",
  ok: "text-emerald-500/90",
  dim: "text-zinc-500",
  out: "text-blue-300/90",
};

export default function HeroDemo() {
  const [scene, setScene] = useState(0);
  const [cycle, setCycle] = useState(0); // bump to retrigger line animations

  useEffect(() => {
    const t = setTimeout(() => {
      const next = (scene + 1) % scenes.length;
      if (next === 0) setCycle((c) => c + 1);
      setScene(next);
    }, scenes[scene].hold);
    return () => clearTimeout(t);
  }, [scene]);

  const current = scenes[scene];

  return (
    <div className="window max-w-2xl mx-auto text-left">
      <div className="window-bar">
        <span className="window-dot" />
        <span className="window-dot" />
        <span className="window-dot" />
        <span className="window-title">memory survives restarts — live demo</span>
        <span className="ml-auto window-title text-emerald-500/70">● local</span>
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
    </div>
  );
}
