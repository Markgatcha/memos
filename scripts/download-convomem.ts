#!/usr/bin/env node
/**
 * Download a small, deterministic ConvoMem sample for `bench-convomem.ts`.
 *
 * ConvoMem (Salesforce/ConvoMem, CC-BY-NC-4.0) is 40k filler conversations
 * and 75k QA pairs. The full corpus is not vendored. This script pulls a
 * fixed number of JSON files per evidence category from the Hugging Face
 * repo so the benchmark is reproducible without a 100MB checkout.
 *
 * Usage:
 *   npx tsx scripts/download-convomem.ts --files-per-category=2
 *
 * Output: scripts/dataset/convomem/<category>.json (gitignored).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "Salesforce/ConvoMem";
const REVISION = "main";
const OUT_DIR = "scripts/dataset/convomem";

const CATEGORIES: Array<{ name: string; dir: string }> = [
  { name: "user_evidence", dir: "user_evidence/1_evidence" },
  {
    name: "assistant_facts_evidence",
    dir: "assistant_facts_evidence/1_evidence",
  },
  { name: "changing_evidence", dir: "changing_evidence/2_evidence" },
  { name: "abstention_evidence", dir: "abstention_evidence/1_evidence" },
  { name: "preference_evidence", dir: "preference_evidence/1_evidence" },
  {
    name: "implicit_connection_evidence",
    dir: "implicit_connection_evidence/1_evidence",
  },
];

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<void> {
  const filesPerCategory = Math.max(
    1,
    parseInt(arg("files-per-category") ?? "1", 10) || 1,
  );
  mkdirSync(OUT_DIR, { recursive: true });
  let total = 0;
  for (const category of CATEGORIES) {
    const treeUrl =
      `https://huggingface.co/api/datasets/${REPO}/tree/${REVISION}/` +
      `core_benchmark/evidence_questions/${category.dir}?limit=100`;
    const tree = (await (
      await fetch(treeUrl, { headers: { "User-Agent": "memos-bench" } })
    ).json()) as Array<{ path: string }>;
    if (!Array.isArray(tree) || tree.length === 0) {
      throw new Error(`No files listed for ${category.dir}`);
    }
    const files = tree
      .filter((row) => row.path.endsWith(".json"))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, filesPerCategory);
    const merged: unknown[] = [];
    for (const file of files) {
      const url = `https://huggingface.co/datasets/${REPO}/resolve/${REVISION}/${file.path}`;
      const parsed = (await (await fetch(url)).json()) as {
        evidence_items?: unknown[];
      };
      if (Array.isArray(parsed.evidence_items)) {
        merged.push(...parsed.evidence_items);
      }
    }
    writeFileSync(
      join(OUT_DIR, `${category.name}.json`),
      JSON.stringify(merged, null, 1),
    );
    total += merged.length;
    console.log(`${category.name}: ${merged.length} questions`);
  }
  console.log(`wrote ${total} questions to ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
