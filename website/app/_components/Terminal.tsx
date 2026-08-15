const lines = [
  { prompt: true, cmd: "npm install @mem-os/sdk", note: "" },
  { prompt: true, cmd: "npx memos init --local", note: "" },
  {
    check: true,
    product: "memos",
    text: "memory layer ready",
    meta: "sqlite · 847 memories",
  },
  {
    check: true,
    product: "umt",
    text: "14 MCP tools registered",
    meta: "stdio + http/sse",
  },
  {
    check: true,
    product: "guardian",
    text: "budget 12,408 → 2,767 tok",
    meta: "-77.6%",
  },
  { done: true, text: "ready — 0 cloud calls, 0 api keys" },
];

export default function Terminal() {
  return (
    <div className="window max-w-2xl mx-auto text-left">
      <div className="window-bar">
        <span className="window-dot" />
        <span className="window-dot" />
        <span className="window-dot" />
        <span className="window-title">~/agent — zsh</span>
        <span className="ml-auto window-title text-emerald-500/70">● local</span>
      </div>
      <div className="p-5 font-mono text-[13px] leading-7">
        {lines.map((l, i) => (
          <div
            key={i}
            className="term-line whitespace-pre"
            style={{ animationDelay: `${0.5 + i * 0.35}s` }}
          >
            {l.prompt && (
              <>
                <span className="text-zinc-600 select-none">$ </span>
                <span className="text-zinc-100">{l.cmd}</span>
              </>
            )}
            {l.check && (
              <>
                <span className="text-emerald-500 select-none">✓ </span>
                <span className="text-zinc-100">{l.product}</span>
                <span className="text-zinc-500"> {l.text}</span>
                <span className="text-zinc-600"> {l.meta}</span>
              </>
            )}
            {l.done && (
              <>
                <span className="text-emerald-500 select-none">● </span>
                <span className="text-emerald-500/90">{l.text}</span>
              </>
            )}
          </div>
        ))}
        <div
          className="term-line"
          style={{ animationDelay: `${0.5 + lines.length * 0.35}s` }}
        >
          <span className="text-zinc-600 select-none">$ </span>
          <span className="term-caret" />
        </div>
      </div>
    </div>
  );
}
