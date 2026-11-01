/**
 * Model-specific retrieval prefixes.
 *
 * Asymmetric embedding models are trained to see a task instruction on one or
 * both sides. Omitting it is not a small style issue: Nomic's own docs say the
 * prefix is required, and the retrieval geometry changes without it. MemOS
 * previously exposed `queryPrefix`/`documentPrefix` but defaulted both to the
 * empty string, including for the default `nomic-embed-text` model.
 *
 * This module resolves the right pair from the model name, while always
 * letting an explicit config value win (including an explicit empty string,
 * which is how a caller opts out).
 */

export interface EmbeddingPrefixInput {
  provider?: string;
  model?: string;
  queryPrefix?: string;
  documentPrefix?: string;
}

export interface ResolvedEmbeddingPrefixes {
  queryPrefix: string;
  documentPrefix: string;
  /** Which rule matched, for diagnostics; null when no rule applies. */
  matched: string | null;
}

interface PrefixRule {
  name: string;
  match: RegExp;
  queryPrefix: string;
  documentPrefix: string;
}

/**
 * Order matters: the Gemma/E5 instruction format must be checked before the
 * generic e5 rule, and API-side providers (Voyage/Cohere/OpenAI) use an
 * `input_type` field rather than text prefixes.
 */
const PREFIX_RULES: PrefixRule[] = [
  {
    name: "embeddinggemma",
    match: /embeddinggemma|gemma[-_ ]?300m[-_ ]?e5/i,
    queryPrefix: "task: search result | query: ",
    documentPrefix: "title: none | text: ",
  },
  {
    name: "nomic",
    match: /nomic[-_ ]?embed/i,
    queryPrefix: "search_query: ",
    documentPrefix: "search_document: ",
  },
  {
    name: "e5",
    match: /(^|[/_-])e5([/_-]|$)|e5-|multilingual-e5|intfloat\/e5/i,
    queryPrefix: "query: ",
    documentPrefix: "passage: ",
  },
  {
    name: "bge",
    match: /bge-(small|base|large|en)|baai\/bge/i,
    queryPrefix: "Represent this sentence for searching relevant passages: ",
    documentPrefix: "",
  },
];

/** Providers that set the retrieval mode in the API request, not in text. */
const API_SIDE_PROVIDERS = new Set(["voyage", "cohere"]);

export function resolveEmbeddingPrefixes(
  input: EmbeddingPrefixInput,
): ResolvedEmbeddingPrefixes {
  const provider = input.provider?.toLowerCase();
  const model = input.model ?? "";

  // Explicit values always win. `undefined` means "not configured"; an empty
  // string is an intentional opt-out.
  const explicitQuery = input.queryPrefix;
  const explicitDocument = input.documentPrefix;

  if (provider && API_SIDE_PROVIDERS.has(provider)) {
    return {
      queryPrefix: explicitQuery ?? "",
      documentPrefix: explicitDocument ?? "",
      matched: "api-input-type",
    };
  }

  const rule = PREFIX_RULES.find((candidate) => candidate.match.test(model));
  if (!rule) {
    return {
      queryPrefix: explicitQuery ?? "",
      documentPrefix: explicitDocument ?? "",
      matched: null,
    };
  }

  return {
    queryPrefix: explicitQuery ?? rule.queryPrefix,
    documentPrefix: explicitDocument ?? rule.documentPrefix,
    matched: rule.name,
  };
}
