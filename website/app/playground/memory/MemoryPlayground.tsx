"use client";

import { useEffect, useMemo, useState } from "react";
import { RotateCcw, Search, Trash2 } from "lucide-react";
import demo from "../../../data/memory-demo.json";

type Memory = {
  id: string;
  content: string;
  type: string;
  tags: string[];
  source: string;
  trustScore: number;
  custom?: boolean;
};

type DemoQuery = {
  query: string;
  results: Array<{ id: string; score: number }>;
  pack: {
    items: Array<{
      id: string;
      content: string;
      citation: string;
      tokens: number;
    }>;
    totalTokens: number;
    tokensSaved: number;
    markdown: string;
  };
};

type Result = { memory: Memory; score: number };

const STORAGE_KEY = "memos-playground-v1";

const quickAdds = [
  {
    content: "User prefers pnpm over npm for new projects.",
    type: "preference",
    tags: ["tooling", "pnpm"],
  },
  {
    content: "Deploys freeze during the last two weeks of December.",
    type: "fact",
    tags: ["deploy", "freeze"],
  },
  {
    content: "The design system uses Radix primitives and CSS variables.",
    type: "fact",
    tags: ["design", "radix"],
  },
];

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "what", "who", "how", "does",
  "did", "are", "was", "were", "from", "into", "our", "your", "their", "its",
  "about", "when", "where", "which", "will", "would", "can", "could", "should",
  "have", "has", "had", "not", "but", "they", "them", "you", "use", "using",
]);

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (token) => token.length > 2 && !STOPWORDS.has(token),
  );
}

function rank(memories: Memory[], query: string): Result[] {
  const q = [...new Set(tokens(query))];
  if (q.length === 0) return [];
  return memories
    .map((memory) => {
      const haystack = new Set(
        tokens(`${memory.content} ${memory.tags.join(" ")} ${memory.type}`),
      );
      const overlap = q.filter((token) => haystack.has(token)).length;
      const relevance = overlap / q.length;
      const score = relevance * 0.75 + memory.trustScore * 0.2 + 0.05;
      return { memory, score: Math.round(score * 1000) / 1000 };
    })
    .filter((result) => result.score > 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

function shortId(id: string): string {
  return `[mem:${id.slice(0, 8)}]`;
}

export default function MemoryPlayground() {
  const [custom, setCustom] = useState<Memory[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [pack, setPack] = useState<DemoQuery["pack"] | null>(null);
  const [mode, setMode] = useState<"recorded" | "local" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Memory[];
        if (Array.isArray(parsed)) setCustom(parsed);
      }
    } catch {
      // A corrupt demo blob should not break the page.
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(custom));
    } catch {
      // Storage can be full or blocked; the demo still works in memory.
    }
  }, [custom, ready]);

  const memories = useMemo<Memory[]>(
    () => [
      ...(demo.memories as Memory[]),
      ...custom.map((memory) => ({ ...memory, custom: true })),
    ],
    [custom],
  );
  const byId = useMemo(
    () => new Map(memories.map((memory) => [memory.id, memory])),
    [memories],
  );

  const runPreset = (preset: DemoQuery) => {
    setQuery(preset.query);
    setMode("recorded");
    setPack(preset.pack);
    setResults(
      preset.results
        .map((hit) => {
          const memory = byId.get(hit.id);
          return memory ? { memory, score: hit.score } : null;
        })
        .filter((hit): hit is Result => hit !== null),
    );
  };

  const runCustom = () => {
    if (!query.trim()) return;
    const preset = (demo.queries as DemoQuery[]).find(
      (entry) => entry.query.toLowerCase() === query.trim().toLowerCase(),
    );
    if (preset) {
      runPreset(preset);
      return;
    }
    const ranked = rank(memories, query);
    setMode("local");
    setResults(ranked);
    const items = ranked.slice(0, 3).map((result) => ({
      id: result.memory.id,
      content: result.memory.content,
      citation: shortId(result.memory.id),
      tokens: Math.max(1, Math.ceil(result.memory.content.length / 4)),
    }));
    setPack({
      items,
      totalTokens: items.reduce((sum, item) => sum + item.tokens, 0),
      tokensSaved: 0,
      markdown: [
        "## Memory context",
        "",
        ...items.map((item) => `- ${item.content} ${item.citation}`),
      ].join("\n"),
    });
  };

  const addMemory = (entry: (typeof quickAdds)[number]) => {
    if (custom.some((memory) => memory.content === entry.content)) {
      setMessage("That memory is already stored.");
      return;
    }
    const memory: Memory = {
      id: `demo-${Date.now()}-${custom.length}`,
      content: entry.content,
      type: entry.type,
      tags: entry.tags,
      source: "user_input",
      trustScore: 0.9,
      custom: true,
    };
    setCustom((current) => [...current, memory]);
    setMessage("Stored. It survives a restart in this browser.");
  };

  const removeMemory = (id: string) => {
    setCustom((current) => current.filter((memory) => memory.id !== id));
    setResults((current) => current.filter((result) => result.memory.id !== id));
    setMessage("Forgotten. Deletion is immediate.");
  };

  const restart = () => {
    setQuery("");
    setResults([]);
    setPack(null);
    setMode(null);
    setMessage(
      `Session restarted — ${memories.length} memories reloaded from storage.`,
    );
  };

  return (
    <div className="space-y-8">
      <div className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="card p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="mono-label">memory store</div>
              <div className="mt-1 font-mono text-sm text-zinc-200">
                {memories.length} memories · {custom.length} added here
              </div>
            </div>
            <button
              type="button"
              onClick={restart}
              className="btn btn-secondary !px-3 !py-2 text-[12px]"
            >
              <RotateCcw size={13} />
              Restart
            </button>
          </div>

          <div className="mt-4 max-h-[22rem] space-y-2 overflow-y-auto pr-1">
            {memories.map((memory) => (
              <div
                key={memory.id}
                className="border border-white/[0.06] bg-white/[0.015] px-3 py-2"
              >
                <div className="flex items-start gap-2">
                  <span className="mt-1 font-mono text-[9px] uppercase tracking-[0.08em] text-zinc-600">
                    {memory.type}
                  </span>
                  <p className="flex-1 text-[12px] leading-relaxed text-zinc-300">
                    {memory.content}
                  </p>
                  {memory.custom && (
                    <button
                      type="button"
                      onClick={() => removeMemory(memory.id)}
                      aria-label="Forget this memory"
                      className="text-zinc-600 transition-colors hover:text-zinc-300"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[9px] text-zinc-600">
                  <span>trust {memory.trustScore.toFixed(2)}</span>
                  <span>{memory.source}</span>
                  {memory.tags.slice(0, 3).map((tag) => (
                    <span key={tag}>#{tag}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 border-t border-white/[0.06] pt-4">
            <div className="mono-label mb-2">add a memory</div>
            <div className="flex flex-wrap gap-2">
              {quickAdds.map((entry) => (
                <button
                  key={entry.content}
                  type="button"
                  onClick={() => addMemory(entry)}
                  className="border border-white/[0.12] px-2.5 py-1.5 text-left text-[11px] text-zinc-400 transition-colors hover:border-white/25 hover:text-zinc-200"
                >
                  + {entry.content}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="card p-5">
            <div className="mono-label mb-2">recall</div>
            <div className="flex gap-2">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") runCustom();
                }}
                placeholder="Ask what the store knows…"
                className="min-w-0 flex-1 border border-white/[0.12] bg-transparent px-3 py-2 font-mono text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-white/30"
              />
              <button
                type="button"
                onClick={runCustom}
                className="btn btn-primary !px-3 !py-2 text-[12px]"
              >
                <Search size={13} />
                Recall
              </button>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {(demo.queries as DemoQuery[]).map((preset) => (
                <button
                  key={preset.query}
                  type="button"
                  onClick={() => runPreset(preset)}
                  className="border border-white/[0.12] px-2.5 py-1.5 text-[11px] text-zinc-400 transition-colors hover:border-white/25 hover:text-zinc-200"
                >
                  {preset.query}
                </button>
              ))}
            </div>

            {mode && (
              <div className="mt-3 font-mono text-[9px] uppercase tracking-[0.1em] text-zinc-600">
                {mode === "recorded"
                  ? `recorded from ${demo.engine}`
                  : "browser lexical demo · the SDK uses hybrid retrieval"}
              </div>
            )}

            <div className="mt-4 space-y-2">
              {results.map((result) => (
                <div
                  key={result.memory.id}
                  className="border border-white/[0.06] px-3 py-2"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-[12px] leading-relaxed text-zinc-300">
                      {result.memory.content}
                    </p>
                    <span className="font-mono text-[11px] tabular-nums text-zinc-400">
                      {result.score.toFixed(3)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="h-[2px] flex-1 bg-white/[0.06]">
                      <div
                        className="h-full bg-zinc-300"
                        style={{
                          width: `${Math.max(4, Math.min(100, result.score * 100))}%`,
                        }}
                      />
                    </div>
                    <span className="font-mono text-[9px] text-zinc-600">
                      {shortId(result.memory.id)}
                    </span>
                  </div>
                </div>
              ))}
              {mode && results.length === 0 && (
                <p className="text-[12px] text-zinc-500">
                  Nothing relevant stored. The real SDK abstains rather than
                  inventing an answer.
                </p>
              )}
            </div>
          </div>

          {pack && (
            <div className="card p-5">
              <div className="flex items-baseline justify-between gap-3">
                <div className="mono-label">context pack</div>
                <span className="font-mono text-[10px] text-zinc-500">
                  {pack.totalTokens} tok · {pack.items.length} citations
                </span>
              </div>
              <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-6 text-zinc-400">
                {pack.markdown}
              </pre>
            </div>
          )}
        </div>
      </div>

      {message && (
        <p className="font-mono text-[11px] text-zinc-400">{message}</p>
      )}

      <p className="text-[11px] leading-relaxed text-zinc-600">
        Preset queries and packs are recorded from the real SDK. Additions and
        forgets made here persist in this browser&apos;s localStorage so a
        restart is visible; the real MemOS persists to SQLite at{" "}
        <code className="text-zinc-400">~/.memos/memos.db</code>. Arbitrary
        queries use a small lexical scorer in the browser, not the SDK&apos;s
        hybrid retrieval.
      </p>
    </div>
  );
}
