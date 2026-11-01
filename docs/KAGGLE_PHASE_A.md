# Phase A on Kaggle — trustworthy measurement

Why Kaggle: the full LoCoMo run took ~80 min locally and the 500-question
LongMemEval ingestion alone was ~8 min for just 25 questions. Kaggle gives
you 2xT4 (~29 GiB) so the embedding and reranker models sit on GPU, which
removes the dominant cost.

**Budget:** 30 GPU-hours/week, 12 h max session, 60 min idle timeout,
phone verification required. A full Phase A fits comfortably in one
week's quota if you run it in two sessions.

---

## Step 0 — One-time: get the datasets onto Kaggle

`scripts/dataset/` is ~300 MB and re-uploading it every session is the
slowest part of the whole exercise. Do this **once**.

```bash
# On your machine
cd C:\Users\marki\memos\scripts
tar -czf memos-datasets.tgz dataset/
```

1. Kaggle → **Datasets** → **New Dataset**.
2. Upload `memos-datasets.tgz`, keep it **private**, title it
   `memos-bench-datasets`.
3. Note the slug, e.g. `markgatcha/memos-bench-datasets`.

From then on, attach it to any notebook with **+ Add data** instead of
uploading.

---

## Step 1 — Notebook settings

New Notebook, then in the right-hand panel:

- **Accelerator:** GPU T4 x2
- **Internet:** On (needed for `apt`, `npm`, and model downloads)
- **Persistence:** leave defaults; session auto-saves every 5 min

Sanity-check what you actually got — the accelerator varies:

```python
import subprocess

print(subprocess.run(["nvidia-smi"], shell=True, capture_output=True, text=True).stdout)
```

---

## Step 2 — Environment

**Node version matters.** `better-sqlite3` in this repo is compiled against
Node 26 (`NODE_MODULE_VERSION 147`). On Node 22 it fails with
`ERR_DLOPEN_FAILED`. Either install Node 26 (recommended) or run
`npm rebuild better-sqlite3`.

```bash
# Node 26 via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"
nvm install 26 && nvm use 26
node -v   # must be v26.x

git clone https://github.com/Markgatcha/memos.git
cd memos
npm install
npm run build
npm run typecheck   # should be clean
```

Attach the dataset and unpack it into the repo:

```bash
# /kaggle/input/memos-bench-datasets/memos-datasets.tgz
tar -xzf /kaggle/input/memos-bench-datasets/memos-datasets.tgz -C scripts/
ls scripts/dataset/          # beam hotpotqa locomo longmemeval ...
```

---

## Step 3 — Embeddings + reranker on GPU

The published LoCoMo numbers were produced with
`LFM2.5-Embedding-350M-BF16` and a reranker on `127.0.0.1:8081`. Serve both
with `llama-server` so they run on the T4s:

```bash
# llama.cpp binaries (Linux, CUDA) — use the LATEST release: the
# embeddinggemma-2 architecture is only in recent builds.
curl -sL https://api.github.com/repos/ggml-org/llama.cpp/releases/latest \
  | grep -oP '"browser_download_url": "\K[^"]*ubuntu-x64\.zip' | head -1
# then unzip and chmod +x llama/build/bin/*

# embedding server (original stack)
./llama/build/bin/llama-server -m LFM2.5-Embedding-350M-BF16.gguf \
  --embedding --port 8080 --host 127.0.0.1 -ngl 99 &

# cross-encoder reranker
./llama/build/bin/llama-server -m bge-reranker-v2-m3-f16.gguf \
  --rerank --port 8081 --host 127.0.0.1 -ngl 99 &

sleep 20 && curl -s http://127.0.0.1:8080/health && curl -s http://127.0.0.1:8081/health
```

### EmbeddingGemma-2 (released 2026-10-06) — the new stack

`google/embeddinggemma-2` is a 740M-parameter **multimodal** embedding model
(text + image + audio + video), 256K context, Matryoshka dims. It is **bigger
than LFM2.5-350M** — the "smaller/faster" sibling is the ORIGINAL
`google/embeddinggemma-300m` (308M, Gemma-3-based, Q8 ≈ 320 MB). Pick by what
you are measuring; if you want A/B against the published numbers, run both.

```bash
# EmbeddingGemma-2 (multimodal, 740M)
wget https://huggingface.co/unsloth/embeddinggemma-2-GGUF/resolve/main/embeddinggemma-2-Q8_0.gguf        # 310 MB
wget https://huggingface.co/unsloth/embeddinggemma-2-GGUF/resolve/main/embeddinggemma-2-UD-Q4_K_XL.gguf  # 176 MB
./llama/build/bin/llama-server -m embeddinggemma-2-Q8_0.gguf \
  --embedding --ctx-size 4096 -b 4096 -ub 2048 --parallel 4 -ngl 99 -fa on \
  --embd-normalize 2 --port 8080 --host 127.0.0.1 &

# EmbeddingGemma-300M (smaller/faster, text-only)
wget https://huggingface.co/sarav1n/embeddinggemma-300m-Q8_0-GGUF/resolve/main/embeddinggemma-300m-Q8_0.gguf
./llama/build/bin/llama-server -m embeddinggemma-300m-Q8_0.gguf \
  --embedding --ctx-size 4096 -b 4096 -ub 2048 --parallel 4 -ngl 99 -fa on \
  --embd-normalize 2 --port 8080 --host 127.0.0.1 &
```

Both Gemma embedding families take **asymmetric task prompts** through
`--query-prefix` / `--document-prefix` (same contract as LFM2.5 — the
prefixes are load-bearing, the models silently degrade without them):

| Family | `--query-prefix=` | `--document-prefix=` |
|---|---|---|
| EmbeddingGemma-2 / -300M | `task: search result \| query: ` | `title: none \| text: ` |
| LFM2.5-Embedding-350M | `query: ` | `document: ` |

EmbeddingGemma-2's Matryoshka dims mean the TRUNCATED dim is part of the
measurement — record `--dimensions` in the results JSON. Note the
**modular modes**: `embeddinggemma-2` loads 270M (text/code), 440M
(+vision), 570M (+audio) or 740M (all) from one checkpoint — the
Ollama tags ship the split (`embeddinggemma-2:270m` …). A GGUF via
llama-server carries all towers and needs a build with the
`gemma-embedding2` arch (v0.6.0 release predates it; b11433 does not
know it).

Point the benchmark at them:

```bash
export EMBEDDING_BASE_URL=http://127.0.0.1:8080/v1
```

…and pass `--rerank-url=http://127.0.0.1:8081` to the LoCoMo harness.

**Record the exact model + revision in the results JSON.** The whole point
of Phase A is that a score without a stated stack is not comparable.

---

## Step 4 — Full LongMemEval (500 questions, not 25)

The previous run scored 25 questions and reported 92%. It only exercised
`single-session-user` — the easiest category — and skipped multi-session
(133), temporal-reasoning (133) and knowledge-update (78).

```bash
npx tsx scripts/bench-longmemeval.ts --retrieve-only
```

No `--max-questions` — you want all 500. Expect ingestion to dominate;
run it in the background and poll:

```bash
npx tsx scripts/bench-longmemeval.ts --retrieve-only > longmemeval.log 2>&1 &
tail -f longmemeval.log
```

Check the per-category block afterwards. The numbers that matter are
knowledge-update and multi-session, not the headline.

---

## Step 5 — BEAM at a real scale

`bench-beam-results.json` currently holds a synthetic **BEAM-100K** run
scoring 99% on the fuzzy term-overlap metric — not the real benchmark.
Real BEAM-1M is where mem0 scores 64.1%, so expect a sobering number.

```bash
npx tsx scripts/bench-beam.ts --scale=1m
npx tsx scripts/bench-beam.ts --scale=10m   # if quota allows
```

---

## Step 6 — Baselines (the part everyone skips and reviewers look for)

A score with no baseline is unfalsifiable. Run each of these through the
**same harness** so the only variable is the configuration:

```bash
# Full pipeline (current default, expansions ON)
npx tsx scripts/bench-locomo-noapi.ts

# Expansion OFF — isolates the Phase C1 contribution
npx tsx scripts/bench-locomo-noapi.ts --no-session-expansion --no-graph-expansion

# Keyword leg only (pure FTS5/BM25)
npx tsx scripts/bench-locomo-noapi.ts --keyword-weight=1 --semantic-weight=0 --no-session-expansion --no-graph-expansion

# Semantic leg only
npx tsx scripts/bench-locomo-noapi.ts --keyword-weight=0 --semantic-weight=1 --no-session-expansion --no-graph-expansion

# No reranker — isolates the cross-encoder's contribution
npx tsx scripts/bench-locomo-noapi.ts   # with the :8081 server stopped
```

The `--no-session-expansion` / `--no-graph-expansion` flags are new; they
exist precisely because expansion now defaults **ON**, so the ablation
needs the off side too.

Also worth one run each:

```bash
npx tsx scripts/bench-locomo-noapi.ts --query-expansion   # Phase C4
```

Every flag above is recorded in the `retrieval:` block of the results JSON,
so a saved JSON always tells you which configuration produced it.

---

## Step 7 — Bootstrap confidence intervals

With 92 open-domain questions, a point estimate is noise: the 95% interval
is roughly ±10 points. Report intervals, not bare percentages.

`perQuestion` is stored in every results JSON, so this is an offline pass —
no GPU, no re-run:

```python
import json, random

d = json.load(open("scripts/bench-locomo-noapi-results.json"))
hits = [1 if q.get("hit") else 0 for q in d["perQuestion"]]


def ci(xs, n=2000):
    est = [sum(random.choices(xs, k=len(xs))) / len(xs) for _ in range(n)]
    est.sort()
    return est[int(0.025 * n)], est[int(0.975 * n)]


lo, hi = ci(hits)
print(f"hit@10 = {sum(hits) / len(hits):.3f}  95% CI [{lo:.3f}, {hi:.3f}]")
```

Do this per category too — that is what tells you whether a difference is
real.

---

## Step 8 — Collect results

Kaggle wipes the working directory when a session ends. Copy every
artifact into `/kaggle/working/` output (which persists as notebook
output) or download it:

```bash
mkdir -p /kaggle/working/results
cp scripts/bench-*-results.json /kaggle/working/results/
cp scripts/bench-quality.md /kaggle/working/results/
```

---

## Gotchas

- **Node 26 or bust.** `ERR_DLOPEN_FAILED` on `better_sqlite3.node` means
  you are on the wrong Node. This is the single most common failure.
- **`fuzzyOverlapRate` is not recall.** Every results JSON carries it as a
  labelled diagnostic. The file's own note says it must not be cited as
  evidence recall. It reads ~0.98 while true hit@10 is ~0.83.
- **Local judge ≠ GPT-4o judge.** If you later add answer generation, a
  14B local judge will not reproduce published numbers. Publish the
  **delta vs baseline under the same judge** instead of the absolute.
- **Datasets are gated.** LoCoMo and LongMemEval carry academic licences.
  Keep your Kaggle dataset **private**; do not publish it.
- **Internet toggle must be On** for `apt`/`npm`/model downloads, but the
  benchmark itself never needs it once models are local.
- **Session idle timeout is 60 min.** For multi-hour runs, keep the tab
  open or poll from a second cell.
