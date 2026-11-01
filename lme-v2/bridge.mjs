#!/usr/bin/env node
/**
 * Persistent JSON-lines bridge between the LongMemEval-V2 Python harness and
 * the MemOS TypeScript SDK.
 *
 * One process owns one SQLite database. Python sends:
 *   {"op":"init","dbPath":..., "namespace":..., "embeddings":{...}}
 *   {"op":"insert","nodes":[{content,pool,type,metadata}, ...]}
 *   {"op":"query","query":"...", "tokenBudget":..., "topK":...}
 *   {"op":"save","path":"/abs/output/memos.db"}
 *   {"op":"close"}
 *
 * and receives one JSON object per line. Keeping the process alive matters:
 * spawning Node per trajectory would dominate LME-V2 latency.
 */

import readline from "node:readline";
import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";

const sdkSpec = process.env.MEMOS_SDK_PATH
  ? pathToFileURL(process.env.MEMOS_SDK_PATH).href
  : process.env.MEMOS_SDK_SPEC || "@mem-os/sdk";

const { MemOS } = await import(sdkSpec);

let memos = null;
let dbPath = null;
let namespace = "lme-v2";
let defaultTokenBudget = 120_000;
let defaultTopK = 20;

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function cite(id) {
  const compact = String(id || "").replace(/[^a-z0-9]/gi, "");
  return `[mem:${compact.slice(-4) || "????"}]`;
}

async function init(message) {
  if (memos) {
    await memos.close().catch(() => {});
    memos = null;
  }
  dbPath = message.dbPath;
  namespace = message.namespace || "lme-v2";
  defaultTokenBudget = Number(message.tokenBudget) || 120_000;
  defaultTopK = Number(message.topK) || 20;
  const embeddings = message.embeddings || { provider: "model2vec" };
  memos = new MemOS({
    dbPath,
    // LME-V2 corpora are trusted benchmark data. The write gate is for
    // agent output; it must not silently quarantine evidence here.
    autoLinkThreshold: 0,
    embeddingQueue: {
      concurrency: 4,
      batchSize: 16,
      maxQueueSize: 250_000,
    },
    embeddings,
  });
  await memos.init();
}

async function insert(message) {
  if (!memos) throw new Error("bridge not initialised");
  const nodes = Array.isArray(message.nodes) ? message.nodes : [];
  let inserted = 0;
  let skipped = 0;
  const concurrency = Math.max(1, Number(message.concurrency) || 8);
  for (let start = 0; start < nodes.length; start += concurrency) {
    const batch = nodes.slice(start, start + concurrency);
    await Promise.all(
      batch.map(async (node) => {
        const content = String(node.content ?? "");
        const common = {
          namespace: node.namespace || namespace,
          pool: node.pool || "event",
          type: node.type || "fact",
          // The benchmark corpus is trusted evidence, not untrusted web
          // output. external_data (the importRecord default) carries a
          // 0.5 trust score and a provenance multiplier that can demote
          // correct evidence during fusion.
          source: "user_input",
          ...(Array.isArray(node.tags) && node.tags.length > 0
            ? { tags: node.tags.map(String) }
            : {}),
          ...(node.metadata ? { metadata: node.metadata } : {}),
          contradictionScan: false,
          harness: "lme-v2",
        };
        try {
          if (node.id) {
            // Deterministic id + empty summary skips extractive work on a
            // 25M-token corpus while keeping the normal embedding queue.
            await memos.importRecord({
              id: String(node.id),
              content,
              summary: "",
              createdAt: Date.now(),
              updatedAt: Date.now(),
              ...common,
            });
          } else {
            await memos.store(content, {
              ...common,
              eventUpdate: false,
              quarantineScreen: false,
            });
          }
          inserted += 1;
        } catch (error) {
          // A resumed/retried run re-sends deterministic ids. Treat an
          // existing id as already indexed instead of aborting the run.
          if (node.id && isDuplicateId(error)) {
            skipped += 1;
            return;
          }
          throw error;
        }
      }),
    );
  }
  return { inserted, skipped };
}

function isDuplicateId(error) {
  const text = String(error?.message ?? error).toLowerCase();
  return (
    text.includes("unique constraint failed") ||
    text.includes("primary key") ||
    text.includes("already exists")
  );
}

async function query(message) {
  if (!memos) throw new Error("bridge not initialised");
  const rawQuery = String(message.query ?? "").trim();
  if (!rawQuery) return { items: [] };
  const queryText = message.stripPreamble
    ? stripQuestionPreamble(rawQuery)
    : rawQuery;
  const tokenBudget = Math.max(
    512,
    Number(message.tokenBudget) || defaultTokenBudget,
  );
  const topK = Math.max(1, Number(message.topK) || defaultTopK);
  const neighborRadius = Math.max(0, Number(message.neighborRadius) || 0);
  const usedTokens = { value: 0 };
  // One environment per question: the corpus mixes three web sites and one
  // enterprise portal, so unfiltered retrieval spends most of its budget on
  // pages the question is not about. The question text names the site
  // reliably, so the partition is deterministic rather than learned.
  // Detect on the raw question: the stripped preamble is exactly where the
  // site name lives.
  // One site per question: the web corpus mixes three WebArena sites (forum,
  // shop, admin) and unfiltered retrieval spends most of its budget on pages
  // the question is not about. The question text names the site reliably.
  const environment = message.envFilter ? detectSite(rawQuery) : null;
  const tagFilter = environment ? [`site:${environment}`] : [];

  let packItems = [];
  const buildPack = (tags, query) =>
    memos.contextPack({
      query,
      tokenBudget,
      // Without an explicit limit the pack derives up to 500 items from the
      // budget, which the adapter then threw away by slicing to topK. Here
      // topK means "seeds"; the budget is reserved for the seeds plus their
      // neighbouring steps.
      limit: topK,
      namespace,
      format: "json",
      citations: true,
      multiStream: true,
      // Semantic dedup pulls every stored embedding for the candidate set on
      // each query. That is a real latency cost, so it is switchable for
      // latency A/Bs; it stays on by default.
      semanticDedup: process.env.MEMOS_LME_DEDUP !== "0",
      ...(tags.length > 0 ? { tags } : {}),
      // LME-V2 scores the accuracy-latency frontier; rerank is opt-in and
      // only runs when a reranker is configured in the SDK. It degrades to
      // fused order when absent.
      rerank: process.env.MEMOS_LME_RERANK === "1",
    });
  try {
    // Multiple deterministic query variants, fused by reciprocal rank. The
    // official multi-query RAG variant gains several points by asking the
    // same question several ways; that does not require a generator model,
    // only a lexical variant and rank fusion.
    const controllerQueries = Array.isArray(message.queries)
      ? message.queries.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const variants =
      controllerQueries.length > 0
        ? uniqueQueries(controllerQueries.slice(0, 3))
        : message.multiQuery
          ? uniqueQueries([queryText, keywordQuery(rawQuery)])
          : message.queryMode === "keywords"
            ? uniqueQueries([keywordQuery(rawQuery), queryText]).slice(0, 1)
            : [queryText];
    const packs = await Promise.all(
      variants.map((variant) =>
        buildPack(tagFilter, variant).catch(() => null),
      ),
    );
    packItems = fuseByRank(packs);
    // A partition that matches nothing (a misread site name, or a corpus
    // without tags) must degrade to unpartitioned retrieval rather than
    // answer from an empty context.
    if (packItems.length === 0 && tagFilter.length > 0) {
      packItems = fuseByRank([await buildPack([], queryText)]);
    }
  } catch (error) {
    // Fall through to plain search; a pack failure must not lose evidence.
    packItems = [];
  }

  const items = [];
  const debug = [];
  const images = new Set();
  const seen = new Set();
  let topScore = 0;

  const pushText = (id, content, score) => {
    const text = String(content ?? "").trim();
    if (!text || seen.has(id)) return false;
    const tokens = Math.ceil(text.length / 4);
    if (usedTokens.value + tokens > tokenBudget) return false;
    seen.add(id);
    usedTokens.value += tokens;
    const citation = id ? cite(id) : "";
    items.push({
      type: "text",
      value: citation ? `${text} ${citation}` : text,
    });
    debug.push({
      id,
      type: "text",
      tokens,
      score: typeof score === "number" ? score : undefined,
    });
    return true;
  };

  const maybeAddImage = async (id) => {
    try {
      const node = await memos.retrieve(id);
      const screenshot = node?.metadata?.screenshot;
      if (typeof screenshot === "string" && existsSync(screenshot)) {
        images.add(screenshot);
      }
    } catch {
      // Image evidence is additive; text still counts.
    }
  };

  const seeds = packItems.slice(0, topK);
  for (const item of seeds) {
    const content = String(item.content ?? item.summary ?? "").trim();
    if (typeof item.score === "number" && item.score > topScore) {
      topScore = item.score;
    }
    pushText(item.id, content, item.score);
    await maybeAddImage(item.id);
  }

  // The dominant retrievable loss is not the wrong trajectory, it is the
  // wrong state inside the right trajectory (16% of scorable questions on the
  // small tier). Once a trajectory is a top seed, its other states are cheap
  // primary-key reads, so score them lexically against the question and add
  // the best few. No model, no extra embedding work.
  if (message.withinTrajectoryRescue) {
    await rescueWithinTrajectories(seeds, rawQuery, pushText, maybeAddImage);
  }

  // The official RAG baseline indexes raw states with slice radius 1: an
  // answer often sits in the step before or after the matching one (open a
  // form, then the confirmation page). Seed-then-neighbour keeps the precise
  // hit first and spends the remaining budget on its context.
  if (neighborRadius > 0) {
    for (const item of seeds) {
      for (const neighborId of neighbourIds(item.id, neighborRadius)) {
        try {
          const node = await memos.retrieve(neighborId);
          if (node) {
            pushText(node.id, node.content);
            await maybeAddImage(node.id);
          }
        } catch {
          // Neighbours are additive; a missing step is normal at edges.
        }
      }
    }
  }

  if (items.length === 0) {
    const hits = await memos.search({
      query: queryText,
      limit: topK,
      namespace,
    });
    for (const hit of hits) {
      pushText(hit.node.id, hit.node.summary || hit.node.content, hit.score);
      const screenshot = hit.node.metadata?.screenshot;
      if (typeof screenshot === "string" && existsSync(screenshot)) {
        images.add(screenshot);
      }
    }
  }

  // The question image is evidence too. Without CLIP we cannot search pixels,
  // but returning it ensures a multimodal reader sees the query state.
  if (
    typeof message.queryImage === "string" &&
    message.queryImage &&
    existsSync(message.queryImage)
  ) {
    images.add(message.queryImage);
  }

  const maxImages = Math.max(0, Number(message.maxImages ?? 4));
  for (const image of [...images].slice(0, maxImages)) {
    items.push({ type: "image", value: image });
    debug.push({ id: image, type: "image", tokens: 0 });
  }
  // Optional, off by default. Calibration on the small tier found the fused
  // score does not separate abstention questions from answerable ones
  // (AUC 0.55), so enabling this without re-calibrating on your own corpus
  // would add noise rather than signal.
  if (
    message.lowConfidenceNote &&
    items.length > 0 &&
    topScore < Number(message.confidenceThreshold || 0)
  ) {
    items.unshift({
      type: "text",
      value:
        "Retrieval note: no memory directly addresses this question. " +
        "The evidence below is the closest available match.",
    });
  }
  return {
    items,
    packItems: packItems.length,
    contextTokens: usedTokens.value,
    topScore,
    debug,
  };
}

/**
 * Node ids are deterministic (`lme_<trajectory>_state_<index>`), so adjacent
 * steps can be fetched by primary key without another search.
 */
function neighbourIds(id, radius) {
  const match = /^(lme_.+)_state_(\d+)$/.exec(String(id || ""));
  if (!match) return [];
  const [, prefix, indexText] = match;
  const index = Number(indexText);
  const ids = [];
  for (let offset = 1; offset <= radius; offset += 1) {
    if (index - offset >= 0) ids.push(`${prefix}_state_${index - offset}`);
    ids.push(`${prefix}_state_${index + offset}`);
  }
  return ids;
}

/**
 * Questions open with environment boilerplate ("I am working with our
 * ServiceNow portal."). It is identical across dozens of questions and
 * dilutes the embedding, so the optional mode drops the leading sentence
 * when the remainder is still substantive.
 */
function stripQuestionPreamble(text) {
  const match =
    /^I(?:'m| am) (?:working|using|currently working)[^.!?]*[.!?]+\s*/i.exec(
      text,
    );
  if (!match) return text;
  const rest = text.slice(match[0].length).trim();
  return rest.length >= 40 ? rest : text;
}

/**
 * Same rules as the Python diagnostics: the dataset's questions open with a
 * formulaic sentence naming their site. Returns null when nothing matches, in
 * which case retrieval stays unfiltered.
 */
const QUERY_STOPWORDS = new Set(
  (
    "the a an and or of to in on for with at by from is are was were be been " +
    "what which who how why when where do does did done i we you they it this " +
    "that these those my our your their there here please tell give show me " +
    "using working portal website site page magento reddit forum admin " +
    "servicenow would like want need can could should"
  ).split(" "),
);

/**
 * Lexical variant of the question: quoted UI labels first (they are the
 * highest-signal tokens in this benchmark), then content words with the
 * boilerplate and question words removed.
 */
function keywordQuery(text) {
  const source = String(text || "");
  const quoted = [...source.matchAll(/["'\u201c\u201d\u2018\u2019]([^"'\u201c\u201d\u2018\u2019]{2,48})["'\u201c\u201d\u2018\u2019]/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  const words = source
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3 && !QUERY_STOPWORDS.has(word));
  const parts = [...new Set([...quoted, ...words])].slice(0, 14);
  return parts.join(" ");
}

function uniqueQueries(variants) {
  const seen = new Set();
  const out = [];
  for (const variant of variants) {
    const text = String(variant || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out.length > 0 ? out : [""];
}

/** Reciprocal rank fusion across packs; rank-based, so scales do not matter. */
function fuseByRank(packs) {
  const scores = new Map();
  const items = new Map();
  for (const pack of packs) {
    const list = pack && Array.isArray(pack.items) ? pack.items : [];
    list.forEach((item, index) => {
      const id = item.id ?? `anon:${index}`;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + index + 1));
      if (!items.has(id)) items.set(id, item);
    });
  }
  return [...items.values()]
    .map((item) => ({ item, score: scores.get(item.id) ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .map((row) => row.item);
}

/**
 * Once a trajectory is a top seed, its other states are cheap primary-key
 * reads. Rank them lexically against the question and add the best few: this
 * targets the dominant loss mode (right trajectory, wrong state) without a
 * model or another embedding pass.
 */
async function rescueWithinTrajectories(
  seeds,
  query,
  pushText,
  maybeAddImage,
  { maxTrajectories = 2, perTrajectory = 3 } = {},
) {
  const roots = [];
  const seen = new Set();
  for (const seed of seeds) {
    const root = trajectoryRoot(seed.id);
    if (!root || seen.has(root)) continue;
    seen.add(root);
    roots.push(root);
    if (roots.length >= maxTrajectories) break;
  }
  if (roots.length === 0) return;

  for (const root of roots) {
    // One tag-filtered search per trajectory: the tag narrows the candidate
    // set to a few dozen nodes, so this is far cheaper than walking state
    // ids until they run out.
    let hits = [];
    try {
      hits = await memos.search({
        query,
        namespace,
        tags: [`traj:${root}`],
        limit: perTrajectory,
      });
    } catch {
      hits = [];
    }
    for (const hit of hits.slice(0, perTrajectory)) {
      if (pushText(hit.node.id, hit.node.content, hit.score)) {
        await maybeAddImage(hit.node.id);
      }
    }
  }
}

function trajectoryRoot(id) {
  const match = /^lme_(.+)_(?:state|elements|procedure|gotcha|note)(?:_\d+)?$/.exec(
    String(id || ""),
  );
  return match ? match[1] : null;
}

function detectSite(text) {
  const lowered = String(text || "").toLowerCase();
  // Enterprise questions name ServiceNow; that corpus is one environment and
  // carries no site tag, so it must never be routed to a web site filter.
  if (lowered.includes("servicenow")) return null;
  if (lowered.includes("reddit") || lowered.includes("forum")) {
    return "forum";
  }
  if (
    lowered.includes("shopping admin") ||
    lowered.includes("admin dashboard")
  ) {
    return "admin";
  }
  if (
    lowered.includes("shopping website") ||
    lowered.includes("shopping site")
  ) {
    return "shop";
  }
  // Enterprise questions name ServiceNow; that corpus is one environment, so
  // no site tag exists and the filter is skipped.
  return null;
}

async function save(message) {
  if (!memos) throw new Error("bridge not initialised");
  await memos.flushEmbeddings();
  await memos.close();
  memos = null;
  const target = String(message.path);
  copyFileSync(dbPath, target);
  // A snapshot should not leave WAL sidecars pointing at the old path.
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) {
      try {
        unlinkSync(sidecar);
      } catch {
        // The main DB is already checkpointed by close().
      }
    }
  }
  return { path: target };
}

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    send({ ok: false, error: `bad json: ${String(error)}` });
    continue;
  }
  try {
    switch (message.op) {
      case "init":
        await init(message);
        send({ ok: true });
        break;
      case "insert":
        send({ ok: true, ...(await insert(message)) });
        break;
      case "query":
        send({ ok: true, ...(await query(message)) });
        break;
      case "search": {
        // Inspection only: the harness never calls this. Returns ranked hits
        // with pool/score so the adapter's pool balance is measurable.
        const hits = await memos.search({
          query: String(message.query ?? ""),
          limit: Math.max(1, Number(message.limit) || 20),
          namespace,
          ...(message.pool ? { pool: message.pool } : {}),
          ...(Array.isArray(message.tags) && message.tags.length
            ? { tags: message.tags }
            : {}),
        });
        send({
          ok: true,
          hits: hits.map((hit) => ({
            id: hit.node.id,
            pool: hit.node.pool,
            score: hit.score,
            preview: String(hit.node.content ?? "").slice(0, 160),
          })),
        });
        break;
      }
      case "save": {
        const result = await save(message);
        send({ ok: true, ...result });
        // A snapshot is terminal; exit so the Python side can join the
        // process and safely copy/clean the database directory. Give stdout
        // a tick to flush before exiting.
        setTimeout(() => process.exit(0), 25);
        break;
      }
      case "close":
        await memos?.close().catch(() => {});
        memos = null;
        send({ ok: true });
        process.exit(0);
        break;
      default:
        send({ ok: false, error: `unknown op: ${String(message.op)}` });
    }
  } catch (error) {
    send({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}
