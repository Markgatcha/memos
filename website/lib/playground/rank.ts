import { stemmer } from "porter-stemmer";

export type RankableMemory = {
  id: string;
  content: string;
  type: string;
  tags: string[];
  source: string;
  trustScore: number;
};

export type RankedMemory<T extends RankableMemory = RankableMemory> = {
  memory: T;
  score: number;
};

// Mirrors the FTS stopword list in src/storage/sqlite.ts, plus a few
// conversational fillers that carry no retrieval signal in short queries.
const STOPWORDS = new Set(
  (
    "the a an is are was were be been being does did do has have had of in on at to for and or not no " +
    "with by from as it its this that these those what when where who whom which how why can could " +
    "will would should shall may might must about into over after before they them their theirs he she " +
    "his her hers we us our ours you your yours i me my mine if then than so there here any all some " +
    "very too also use using used tell me about"
  ).split(" "),
);

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const MIN_RELEVANCE = 0.2;
const TRUST_WEIGHT = 0.15;
const DEFAULT_LIMIT = 5;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    // Stopwords are checked before and after stemming: Porter rewrites some
    // ("this" -> "thi", "does" -> "doe") and stems others into stopwords
    // ("uses" -> "use"), so neither pass alone filters them all.
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .map((token) => stemmer(token).toLowerCase())
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function tokenizeUnique(text: string): string[] {
  return [...new Set(tokenize(text))];
}

function inverseDocumentFrequency(
  documentCount: number,
  documentFrequency: number,
): number {
  return Math.log(
    1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5),
  );
}

function bm25Score(
  termFrequencies: Map<string, number>,
  documentLength: number,
  averageLength: number,
  queryTerms: string[],
  idf: Map<string, number>,
): number {
  let score = 0;
  for (const term of queryTerms) {
    const frequency = termFrequencies.get(term) ?? 0;
    if (frequency === 0) continue;
    const weight = idf.get(term) ?? 0;
    score +=
      weight *
      ((frequency * (BM25_K1 + 1)) /
        (frequency + BM25_K1 * (1 - BM25_B + (BM25_B * documentLength) / averageLength)));
  }
  return score;
}

/**
 * Lexical stand-in for the SDK's hybrid retrieval, used by the playground's
 * "arbitrary query" path. Porter-stems tokens (matching FTS5's `porter`
 * tokenizer), weights terms by inverse document frequency (BM25), then blends
 * the normalized relevance with the memory's trust score. Memories with no
 * meaningful term overlap are dropped rather than ranked on trust alone.
 */
export function rankMemories<T extends RankableMemory>(
  memories: T[],
  query: string,
  limit = DEFAULT_LIMIT,
): RankedMemory<T>[] {
  const queryTerms = tokenizeUnique(query);
  if (queryTerms.length === 0) return [];

  const documents = memories.map((memory) => {
    const tokens = tokenize(
      `${memory.content} ${memory.tags.join(" ")} ${memory.type}`,
    );
    const termFrequencies = new Map<string, number>();
    for (const token of tokens) {
      termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1);
    }
    return { memory, termFrequencies, length: tokens.length };
  });

  const documentCount = documents.length;
  const averageLength =
    documents.reduce((sum, doc) => sum + doc.length, 0) /
    Math.max(documentCount, 1);

  const documentFrequency = new Map<string, number>();
  for (const doc of documents) {
    for (const term of doc.termFrequencies.keys()) {
      documentFrequency.set(
        term,
        (documentFrequency.get(term) ?? 0) + 1,
      );
    }
  }

  const idf = new Map(
    queryTerms.map((term) => [
      term,
      inverseDocumentFrequency(
        documentCount,
        documentFrequency.get(term) ?? 0,
      ),
    ]),
  );

  const scored = documents.map((doc) => ({
    memory: doc.memory,
    raw: bm25Score(
      doc.termFrequencies,
      doc.length,
      averageLength,
      queryTerms,
      idf,
    ),
  }));

  const maxRaw = Math.max(...scored.map((entry) => entry.raw), 0);

  return scored
    .map((entry) => ({
      memory: entry.memory,
      relevance: maxRaw > 0 ? entry.raw / maxRaw : 0,
      raw: entry.raw,
    }))
    .filter((entry) => entry.raw > 0 && entry.relevance >= MIN_RELEVANCE)
    .map((entry) => ({
      memory: entry.memory,
      score:
        Math.round(
          ((1 - TRUST_WEIGHT) * entry.relevance +
            TRUST_WEIGHT * entry.memory.trustScore) *
            1000,
        ) / 1000,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
