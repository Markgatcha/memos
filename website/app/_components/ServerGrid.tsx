"use client";

import { useMemo, useState } from "react";
import { Search, Copy, Check } from "lucide-react";

export type ServerEntry = {
  id: string;
  title: string;
  category: string;
  description: string;
  transports: string[];
};

type ServerGridProps = {
  servers: ServerEntry[];
};

export default function ServerGrid({ servers }: ServerGridProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("All");
  const [copied, setCopied] = useState<string | null>(null);

  const categories = useMemo(
    () => ["All", ...Array.from(new Set(servers.map((s) => s.category))).sort()],
    [servers]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return servers.filter((s) => {
      const matchesCategory = category === "All" || s.category === category;
      const matchesQuery =
        !q ||
        s.title.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q);
      return matchesCategory && matchesQuery;
    });
  }, [servers, query, category]);

  const copyConfig = (s: ServerEntry) => {
    const snippet = JSON.stringify(
      {
        mcpServers: {
          [s.id]: {
            command: "npx",
            args: ["-y", "universal-mcp-toolkit", "run", s.id, "--transport", "stdio"],
          },
        },
      },
      null,
      2
    );
    navigator.clipboard?.writeText(snippet).then(() => {
      setCopied(s.id);
      setTimeout(() => setCopied((c) => (c === s.id ? null : c)), 1800);
    });
  };

  return (
    <div>
      {/* Search + filter row */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="relative flex-1">
          <Search
            size={14}
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-600"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search servers… (github, postgres, slack)"
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] pl-9 pr-4 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-white/25 transition-colors"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              className={`rounded-lg px-3 py-2 font-mono text-[11px] uppercase tracking-wide transition-colors border ${
                category === c
                  ? "border-white/25 bg-white/[0.08] text-zinc-100"
                  : "border-white/[0.07] bg-transparent text-zinc-500 hover:text-zinc-300 hover:border-white/15"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="font-mono text-[11px] text-zinc-600 mb-3">
        {filtered.length} of {servers.length} servers
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {filtered.map((s) => (
          <div key={s.id} className="card p-5 flex flex-col">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div>
                <div className="text-sm font-medium text-zinc-100">{s.title}</div>
                <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-zinc-600 mt-0.5">
                  {s.category}
                </div>
              </div>
              <button
                type="button"
                onClick={() => copyConfig(s)}
                title="Copy MCP config snippet"
                aria-label={`Copy config for ${s.title}`}
                className="shrink-0 w-8 h-8 grid place-items-center rounded-lg border border-white/10 text-zinc-500 hover:text-zinc-100 hover:border-white/25 transition-colors"
              >
                {copied === s.id ? (
                  <Check size={14} className="text-emerald-500" />
                ) : (
                  <Copy size={14} />
                )}
              </button>
            </div>
            <p className="text-[13px] text-zinc-500 leading-relaxed flex-1">
              {s.description}
            </p>
            <div className="mt-3 pt-3 border-t border-white/[0.06] flex gap-1.5">
              {s.transports.map((t) => (
                <span
                  key={t}
                  className="rounded-md border border-white/[0.08] bg-white/[0.02] px-1.5 py-0.5 font-mono text-[10px] text-zinc-500"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="card p-10 text-center text-sm text-zinc-500">
          No servers match “{query}” — try a different search or category.
        </div>
      )}
    </div>
  );
}
