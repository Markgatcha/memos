// One-shot generator: renders the site's OpenGraph image (1200x630) to
// public/og-image.png via sharp (SVG rasterization). Re-run after design
// changes: node scripts/gen-og-image.js
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
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
  <g transform="translate(433, 96)">
    <rect width="54" height="54" rx="12" fill="#fafafa"/>
    <g transform="translate(12, 12)" fill="none" stroke="#09090b" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 4 L27 11 L15 18 L3 11 Z"/>
      <path d="M3 17 L15 24 L27 17" opacity="0.55"/>
      <path d="M3 23 L15 30 L27 23" opacity="0.3"/>
    </g>
    <text x="72" y="38" font-family="Segoe UI, system-ui, sans-serif" font-size="34" font-weight="600" fill="#fafafa" letter-spacing="-1">ContextCore</text>
  </g>

  <!-- headline -->
  <text x="600" y="290" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="66" font-weight="700" fill="#fafafa" letter-spacing="-2.5">The local-first stack</text>
  <text x="600" y="368" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="66" font-weight="700" fill="url(#fade)" letter-spacing="-2.5">for AI agents.</text>

  <!-- sub -->
  <text x="600" y="432" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="26" fill="#a1a1aa">MemOS&#160;&#160;·&#160;&#160;Universal MCP Toolkit&#160;&#160;·&#160;&#160;LLM Guardian</text>

  <!-- pills -->
  <g font-family="Consolas, monospace" font-size="20" fill="#a1a1aa">
    <rect x="368" y="478" width="140" height="48" rx="10" fill="none" stroke="rgba(255,255,255,0.14)"/>
    <text x="438" y="509" text-anchor="middle">100% local</text>
    <rect x="524" y="478" width="152" height="48" rx="10" fill="none" stroke="rgba(255,255,255,0.14)"/>
    <text x="600" y="509" text-anchor="middle">no API keys</text>
    <rect x="692" y="478" width="140" height="48" rx="10" fill="none" stroke="rgba(255,255,255,0.14)"/>
    <text x="762" y="509" text-anchor="middle">open source</text>
  </g>
</svg>`;

const out = path.join(__dirname, "..", "public", "og-image.png");
fs.mkdirSync(path.dirname(out), { recursive: true });

sharp(Buffer.from(svg))
  .png()
  .toFile(out)
  .then((info) => console.log(`wrote ${out} (${info.width}x${info.height}, ${info.size} bytes)`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
