"use client";

import { useMemo, useState } from "react";
import { foldText } from "../../lib/guardian/folding-engine";

const SAMPLE = `We need to refactor the VCM sharder module because the current implementation loads the entire knowledge graph into memory on every request. The refactor should introduce lazy loading with an LRU cache, add unit tests for the eviction path, and benchmark the change against the 10k-memory haystack fixture. Please also update the docs and bump the minor version when we ship it.`;

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="card px-4 py-3">
      <div className={`font-mono text-xl tabular-nums ${accent ? "text-emerald-400" : "text-zinc-100"}`}>
        {value}
      </div>
      <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-500">
        {label}
      </div>
    </div>
  );
}

export default function Playground() {
  const [text, setText] = useState(SAMPLE);
  const [maxTokens, setMaxTokens] = useState(120);

  const result = useMemo(() => {
    if (!text.trim()) return null;
    try {
      return foldText(text, { maxTokens });
    } catch {
      return null;
    }
  }, [text, maxTokens]);

  const savedPct = result
    ? Math.max(0, Math.round((1 - result.foldedTokens / Math.max(1, result.metadata.originalTokens)) * 100))
    : 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Input */}
      <div className="window">
        <div className="window-bar">
          <span className="window-dot" />
          <span className="window-dot" />
          <span className="window-dot" />
          <span className="window-title">input prompt</span>
        </div>
        <div className="p-4">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={12}
            spellCheck={false}
            className="w-full resize-none bg-transparent font-mono text-[13px] leading-6 text-zinc-300 outline-none placeholder:text-zinc-600"
            placeholder="Paste a long prompt…"
          />
          <div className="mt-3 pt-3 border-t border-white/[0.06] flex items-center justify-between gap-4">
            <label className="font-mono text-[11px] text-zinc-500 flex items-center gap-3">
              max tokens
              <input
                type="range"
                min={30}
                max={400}
                step={10}
                value={maxTokens}
                onChange={(e) => setMaxTokens(Number(e.target.value))}
                className="w-32 accent-emerald-500"
              />
              <span className="text-zinc-300 tabular-nums">{maxTokens}</span>
            </label>
            <button
              onClick={() => setText(SAMPLE)}
              className="font-mono text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              reset sample
            </button>
          </div>
        </div>
      </div>

      {/* Output */}
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="original tok" value={result ? String(result.metadata.originalTokens) : "—"} />
          <Stat label="folded tok" value={result ? String(result.foldedTokens) : "—"} />
          <Stat label="smaller" value={result ? `${savedPct}%` : "—"} accent />
          <Stat label="fold time" value={result ? `${result.foldingTimeMs.toFixed(1)} ms` : "—"} />
        </div>

        <div className="window flex-1">
          <div className="window-bar">
            <span className="window-dot" />
            <span className="window-dot" />
            <span className="window-dot" />
            <span className="window-title">folded prompt</span>
          </div>
          <div className="p-4 font-mono text-[13px] leading-6 whitespace-pre-wrap text-emerald-300/90 min-h-[220px]">
            {result ? result.foldedPrompt : "Type something to see the fold…"}
          </div>
        </div>

        {result && (
          <div className="font-mono text-[11px] text-zinc-600 leading-relaxed">
            entities preserved: {result.metadata.entities.length} · actions:
            {" "}{result.metadata.actions.join(", ") || "—"} · semantic density:
            {" "}{result.metadata.semanticDensity.toFixed(2)} · est. savings:
            {" "}${result.estimatedSavingsUsd.toFixed(4)}/request
          </div>
        )}
      </div>
    </div>
  );
}
