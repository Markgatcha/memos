/**
 * Download script for BEAM benchmark datasets.
 *
 * Downloads BEAM-100K and BEAM-1M from HuggingFace and converts Parquet → JSON.
 * Usage: npx tsx scripts/download-beam.ts
 */
import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import path from "path";

async function main() {
  const dataDir = "scripts/dataset/beam/data";
  mkdirSync(dataDir, { recursive: true });

  const datasets = [
    {
      name: "beam_100k",
      url: "https://huggingface.co/datasets/Mohammadta/BEAM/resolve/main/data/100K-00000-of-00001.parquet",
    },
    {
      name: "beam_1m",
      url: "https://huggingface.co/datasets/Mohammadta/BEAM/resolve/main/data/1M-00000-of-00001.parquet",
    },
  ];

  for (const ds of datasets) {
    const parquetPath = path.join(dataDir, `${ds.name}.parquet`);
    const jsonPath = path.join(dataDir, `${ds.name}.json`);

    if (existsSync(jsonPath)) {
      console.log(`✓ ${ds.name}.json already exists, skipping`);
      continue;
    }

    console.log(`Downloading ${ds.name}...`);
    execSync(`curl -L -o ${parquetPath} "${ds.url}"`, { stdio: "inherit" });

    console.log(`Converting ${ds.name} to JSON...`);
    execSync(`python scripts/_convert-beam.py ${parquetPath} ${jsonPath}`, {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    execSync(`rm -f ${parquetPath}`);
  }

  console.log(
    "\n✅ All BEAM datasets ready. Run: npx tsx scripts/bench-beam.ts --topk=15 --convs=35 --scale=1m --max-turns=200",
  );
}

main().catch((err) => {
  console.error("Download failed:", err);
  process.exit(1);
});
