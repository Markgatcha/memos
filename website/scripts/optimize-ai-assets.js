// One-shot: downscale + recompress the generated assets in public/ai/.
// The Qwen outputs are native 2K (1-2.5MB each); the site ships them to every
// visitor, so they get resized to web-appropriate widths and palette-quantized.
//
// Run from website/:  node scripts/optimize-ai-assets.js
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const AI_DIR = path.join(__dirname, "..", "public", "ai");

// Max width per asset id. Hero/backdrop get the most pixels; cards get less.
const TARGETS = {
  "hero-backdrop": 1600,
  "hero-layers": 1400,
  "stack-diagram": 1200,
  "principle-veil": 900,
  "cta-arch": 1200,
  "footer-strata": 1600,
};

(async () => {
  const manifestPath = path.join(AI_DIR, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error("manifest.json not found — run scripts/gen-assets.py first");
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  let before = 0;
  let after = 0;

  for (const asset of manifest.assets) {
    const target = TARGETS[asset.id];
    if (!target) continue;
    const src = path.join(AI_DIR, asset.file);
    if (!fs.existsSync(src)) continue;

    const origSize = fs.statSync(src).size;
    before += origSize;

    const meta = await sharp(src).metadata();
    const info = await sharp(src)
      .resize({ width: target, withoutEnlargement: true })
      .png({ compressionLevel: 9, palette: true, quality: 80 })
      .toFile(src + ".tmp");
    fs.renameSync(src + ".tmp", src);

    after += info.size;
    asset.width = info.width;
    asset.height = info.height;
    asset.bytes = info.size;
    console.log(
      `${asset.file.padEnd(22)} ${meta.width}x${meta.height} -> ${info.width}x${info.height}  ` +
        `${(origSize / 1024).toFixed(0)}KB -> ${(info.size / 1024).toFixed(0)}KB`
    );
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(
    `\ntotal: ${(before / 1024 / 1024).toFixed(1)}MB -> ${(after / 1024 / 1024).toFixed(1)}MB`
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
