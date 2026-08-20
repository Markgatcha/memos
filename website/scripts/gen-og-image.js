// One-shot generator: renders the site's OpenGraph images (1200x630) to
// public/*.png via sharp (SVG rasterization). Re-run after design changes:
// node scripts/gen-og-image.js
//
// Generates: og-image.png (home), og-memos.png, og-umt.png,
// og-benchmarks.png, og-compare-memory.png, og-compare-mcp.png
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function buildSvg({ kicker, line1, line2, sub, pills }) {
  const pillRects = pills
    .map((p, i) => {
      const w = p.length * 11.5 + 44;
      return { w, text: p };
    });
  const totalW = pillRects.reduce((a, p) => a + p.w, 0) + 16 * (pillRects.length - 1);
  let x = (1200 - totalW) / 2;
  const pillSvg = pillRects
    .map((p) => {
      const rect = `<rect x="${x}" y="478" width="${p.w}" height="48" rx="10" fill="none" stroke="rgba(255,255,255,0.14)"/>
    <text x="${x + p.w / 2}" y="509" text-anchor="middle">${esc(p.text)}</text>`;
      x += p.w + 16;
      return rect;
    })
    .join("\n    ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="glow" cx="50%" cy="0%" r="75%">
      <stop offset="0%" stop-color="rgba(96,165,250,0.18)"/>
      <stop offset="100%" stop-color="rgba(96,165,250,0)"/>
    </radialGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="30%" stop-color="#fafafa"/>
      <stop offset="100%" stop-color="#71717a"/>
    </linearGradient>
  </defs>

  <rect width="1200" height="630" fill="#09090b"/>
  <ellipse cx="600" cy="-60" rx="560" ry="330" fill="url(#glow)"/>

  <!-- brand row -->
  <g transform="translate(433, 76)">
    <rect width="54" height="54" rx="12" fill="#fafafa"/>
    <g transform="translate(12, 12)" fill="none" stroke="#09090b" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 4 L27 11 L15 18 L3 11 Z"/>
      <path d="M3 17 L15 24 L27 17" opacity="0.55"/>
      <path d="M3 23 L15 30 L27 23" opacity="0.3"/>
    </g>
    <text x="72" y="38" font-family="Segoe UI, system-ui, sans-serif" font-size="34" font-weight="600" fill="#fafafa" letter-spacing="-1">ContextCore</text>
  </g>

  <!-- kicker -->
  <text x="600" y="208" text-anchor="middle" font-family="Consolas, monospace" font-size="20" letter-spacing="6" fill="#71717a">${esc(kicker.toUpperCase())}</text>

  <!-- headline -->
  <text x="600" y="298" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="62" font-weight="700" fill="#fafafa" letter-spacing="-2.5">${esc(line1)}</text>
  <text x="600" y="372" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="62" font-weight="700" fill="url(#fade)" letter-spacing="-2.5">${esc(line2)}</text>

  <!-- sub -->
  <text x="600" y="432" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="25" fill="#a1a1aa">${esc(sub)}</text>

  <!-- pills -->
  <g font-family="Consolas, monospace" font-size="20" fill="#a1a1aa">
    ${pillSvg}
  </g>
</svg>`;
}

const images = [
  {
    file: "og-image.png",
    kicker: "the local-first ai trio",
    line1: "The local-first stack",
    line2: "for AI agents.",
    sub: "MemOS  ·  Universal MCP Toolkit  ·  LLM Guardian",
    pills: ["100% local", "no API keys", "open source"],
  },
  {
    file: "og-memos.png",
    kicker: "persistent memory",
    line1: "Memory that survives",
    line2: "restarts.",
    sub: "MemOS — 95.9% recall on BEAM-1M · free & open source",
    pills: ["local SQLite", "no subscription", "MIT license"],
  },
  {
    file: "og-umt.png",
    kicker: "mcp toolkit",
    line1: "28 MCP servers.",
    line2: "One CLI.",
    sub: "Universal MCP Toolkit — transport, registry, and routing",
    pills: ["stdio", "http + sse", "claude desktop"],
  },
  {
    file: "og-benchmarks.png",
    kicker: "benchmarks",
    line1: "95.9% vs 64.1%",
    line2: "recall on BEAM-1M.",
    sub: "MemOS vs Mem0 — reproducible, local, honest about ties",
    pills: ["BEAM-1M", "LoCoMo", "LongMemEval"],
  },
  {
    file: "og-compare-memory.png",
    kicker: "comparison",
    line1: "MemOS vs Mem0",
    line2: "vs Zep vs Letta.",
    sub: "Agent memory layers — architecture, pricing, benchmarks",
    pills: ["local-first", "pricing", "self-hosting"],
  },
  {
    file: "og-compare-mcp.png",
    kicker: "comparison",
    line1: "UMT vs mcp-get",
    line2: "vs supergateway.",
    sub: "MCP tooling compared — what each does, when to use which",
    pills: ["monorepo", "registry", "transport"],
  },
];

(async () => {
  const outDir = path.join(__dirname, "..", "public");
  fs.mkdirSync(outDir, { recursive: true });
  for (const img of images) {
    const out = path.join(outDir, img.file);
    const info = await sharp(Buffer.from(buildSvg(img))).png().toFile(out);
    console.log(`wrote ${out} (${info.width}x${info.height}, ${info.size} bytes)`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
