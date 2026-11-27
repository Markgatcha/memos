const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function indexTerms(text) {
  const terms = new Set();
  const normalized = text.normalize('NFKC').toLowerCase();
  for (const run of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
    let word = '';
    let previous = '';
    for (const character of run[0]) {
      if (cjk.test(character)) {
        if (word) terms.add(word);
        word = '';
        if (previous) terms.add(previous + character);
        previous = character;
        terms.add(character);
      } else {
        if (word.length < 128) word += character;
        previous = '';
      }
    }
    if (word) terms.add(word);
  }
  return terms;
}

const functionWords = new Set(
  'a an and are as at be been being by can could did do does for from had has have how i if in into is it its me my of on or our should so than that the their them then there these they this those to us was we were what when where which who why will with would you your'.split(' ')
);

// Expand the query so existing exact-term indexes remain usable after upgrading.
function inflections(term) {
  if (!/^[a-z]{3,40}$/.test(term) || functionWords.has(term)) return [];
  let base = term;
  const variants = new Set();
  if (/[^aeiou]ies$/.test(term)) base = term.slice(0, -3) + 'y';
  else if (/ing$/.test(term) && term.length > 5) base = term.slice(0, -3);
  else if (/ed$/.test(term) && term.length > 4) base = term.slice(0, -2);
  else if (/(?:sh|ch|ss|x|z)es$/.test(term)) base = term.slice(0, -2);
  else if (/[^su]s$/.test(term)) base = term.slice(0, -1);
  // A plural ending in -ises can come from either an -ise or an -is noun.
  // Retain both possible lookups; exact matches still receive full weight.
  if (term.endsWith('ises') && term.length >= 5) variants.add(term.slice(0, -2));
  if (term.endsWith('is')) variants.add(term + 'es');
  if (base !== term && /(?:ed|ing)$/.test(term)) {
    if (/([bdgmnprt])\1$/.test(base)) base = base.slice(0, -1);
    else variants.add(base + 'e');
  }
  if (base.length < 3) return [];
  variants.add(base);
  variants.add(/[^aeiou]y$/.test(base) ? base.slice(0, -1) + 'ies' :
    /(?:sh|ch|s|x|z)$/.test(base) ? base + 'es' : base + 's');
  variants.add(base.endsWith('e') ? base + 'd' : base + 'ed');
  variants.add((base.endsWith('e') ? base.slice(0, -1) : base) + 'ing');
  variants.delete(term);
  return variants;
}

function termMap(terms) {
  const map = new Map();
  for (const term of terms) {
    for (const variant of inflections(term)) {
      if (!map.has(variant)) map.set(variant, { term, strength: 0.78 });
    }
  }
  for (const term of terms) map.set(term, { term, strength: 1 });
  return map;
}

function addMax(map, key, value) {
  map.set(key, Math.max(map.get(key) ?? 0, value));
}

function idf(total, frequency) {
  return Math.log1p((total - frequency + 0.5) / (frequency + 0.5));
}

function compareRows(a, b) {
  return b.score - a.score || b.at - a.at ||
    (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0) ||
    a.position - b.position;
}

// Only explicit quotations request phrase matching. Keep old indexes usable
// and keep partial matches available when a title was remembered imperfectly.
function quotedPhrases(question) {
  const patterns = new Set();
  for (const match of question.normalize('NFKC').toLowerCase().matchAll(/"([^"\n]{2,120})"|“([^”\n]{2,120})”|《([^》\n]{2,120})》/gu)) {
    const literal = (match[1] ?? match[2] ?? match[3]).trim().replace(/\s+/gu, ' ');
    if (literal.length < 2 || !/[\p{L}\p{N}]/u.test(literal)) continue;
    const chars = [...literal];
    const needsBoundary = ch => /[\p{L}\p{N}]/u.test(ch) && !cjk.test(ch);
    const separator = '(?:[^\\p{L}\\p{N}]|' + cjk.source + ')';
    const left = needsBoundary(chars[0]) ? '(?:^|' + separator + ')' : '';
    const right = needsBoundary(chars.at(-1)) ? '(?:$|' + separator + ')' : '';
    const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    patterns.add(left + escaped + right);
    if (patterns.size === 4) break;
  }
  return [...patterns].map(pattern => new RegExp(pattern, 'u'));
}

// Punctuation separates index terms. Preserve complete identifiers for the
// tie between a literal reference, reordered segments and a longer identifier.
function identifierPhrases(question) {
  const ids = new Set();
  for (const [token] of question.normalize('NFKC').toLowerCase().matchAll(/[a-z0-9]+(?:[._-][a-z0-9]+)+/g)) {
    if (token.length <= 128 && /[a-z]/.test(token) && /\d/.test(token)) ids.add(token);
    if (ids.size === 4) break;
  }
  return [...ids].map(id => new RegExp('(?<![a-z0-9])(?<![a-z0-9][._-])'+
    id.replace(/\./g,'\\.')+'(?![a-z0-9]|[._-][a-z0-9])','u'));
}

// Compare a bounded sample from both ends. A shared query term alone is weak
// evidence of repetition: distinct facts in one conversation should survive.
function evidenceTerms(sample) {
  const terms = indexTerms(sample);
  for (const term of terms) {
    if (functionWords.has(term) || (cjk.test(term) && [...term].length === 1)) terms.delete(term);
  }
  return terms;
}

function similarity(first, other) {
  if (!first.size || !other.size) return 0;
  let common = 0;
  for (const term of other) if (first.has(term)) common++;
  return common / (first.size + other.size - common);
}

// terms(workspace_id, term, session_id, position) is a binary posting index.
// messages(session_id, position, original) stores {id, role, text, at} as JSON.
// The caller owns authorization. Only accepted rows influence the statistics.
export function* rankMemoryRows(db, { workspaceId, excludeSessionId, terms, question = '', accept = () => true }) {
  const query = termMap(terms);
  if (!query.size) return;
  // Explicitly quoted phrases have priority over inferred identifier matching.
  const quoted = quotedPhrases(question);
  const phrases = quoted.length ? quoted : identifierPhrases(question);
  const postings = db.prepare(`
    WITH hits AS (
      SELECT session_id, position, json_group_array(term) AS matched
      FROM terms WHERE workspace_id = ? AND session_id <> ?
        AND term IN (SELECT value FROM json_each(?))
      GROUP BY session_id, position
    )
    SELECT hits.*, messages.original FROM hits
    JOIN messages USING (session_id, position)
  `).iterate(workspaceId, excludeSessionId ?? '', JSON.stringify([...query.keys()]));
  const sessions = new Map();
  const messageFrequency = new Map();
  const sessionFrequency = new Map();
  let count = 0;
  for (const hit of postings) {
    const message = JSON.parse(hit.original);
    if (!accept(hit.session_id, message)) continue;
    const matched = new Map();
    for (const token of JSON.parse(hit.matched)) {
      const { term, strength } = query.get(token);
      addMax(matched, term, strength);
    }
    const session = sessions.get(hit.session_id) ?? { matched: new Map(), rows: [] };
    for (const [term, strength] of matched) {
      messageFrequency.set(term, (messageFrequency.get(term) ?? 0) + 1);
      if (!session.matched.has(term)) sessionFrequency.set(term, (sessionFrequency.get(term) ?? 0) + 1);
      addMax(session.matched, term, strength);
    }
    const text = message.text;
    const normalized = phrases.length ? text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ') : '';
    const phraseHits = phrases.reduce((hits, phrase) => hits + Number(phrase.test(normalized)), 0);
    session.rows.push({ sessionId: hit.session_id, position: hit.position, at: message.at,
      length: text.length, phraseHits, sample: text.length <= 512 ? text : text.slice(0, 256) + ' ' + text.slice(-256), matched });
    sessions.set(hit.session_id, session);
    count++;
  }

  const weights = new Map();
  for (const [term, frequency] of sessionFrequency) {
    const lexical = functionWords.has(term) ? 0.12 : cjk.test(term) && [...term].length === 1 ? 0.35 : 1;
    weights.set(term, lexical * (0.25 + idf(sessions.size, frequency) +
      0.5 * idf(count, messageFrequency.get(term))));
  }
  function coverage(matches) {
    let score = 0;
    for (const [term, strength] of matches) score += weights.get(term) * strength;
    return score;
  }
  const ranked = [];
  for (const session of sessions.values()) {
    const sessionScore = coverage(session.matched);
    for (const row of session.rows) {
      const direct = coverage(row.matched) / (1 + 0.08 * Math.log1p(row.length / 240));
      // Evidence across turns helps a direct hit, bounded to avoid unrelated excerpts.
      row.score = direct + 0.4 * Math.min(direct * 2, sessionScore);
      if (row.phraseHits) row.score *= 1 + row.phraseHits / phrases.length;
    }
    session.rows.sort(compareRows);
    const bestTerms = session.rows.length > 1 ? evidenceTerms(session.rows[0].sample) : null;
    const covered = new Map();
    for (const [index, row] of session.rows.entries()) {
      let priority = 1;
      if (index) {
        let newWeight = 0;
        for (const [term, strength] of row.matched) {
          newWeight += weights.get(term) * Math.max(0, strength - (covered.get(term) ?? 0));
        }
        const novelty = newWeight / coverage(row.matched);
        const overlap = similarity(bestTerms, evidenceTerms(row.sample));
        priority = (0.65 + 0.35 * novelty) / (1 + 2 * overlap * overlap);
      }
      for (const [term, strength] of row.matched) addMax(covered, term, strength);
      row.score = Math.max(1, Math.round(1000 * row.score * priority / (1 + 0.35 * Math.log2(1 + index))));
      ranked.push(row);
    }
  }
  ranked.sort(compareRows);
  // A short follow-up can resolve an earlier question without repeating its
  // keywords. Fetch a bounded window around the strongest hits.
  // Apply the caller's authorization to every neighboring message individually.
  const nearby = db.prepare('SELECT position,original FROM messages WHERE session_id=? AND position BETWEEN ? AND ? ORDER BY position');
  const contextual = new Map();
  const leading = ranked.slice(0, 4);
  for (const anchor of ranked.slice(0, 12)) {
    const anchorTerms = evidenceTerms(anchor.sample);
    for (const row of nearby.iterate(anchor.sessionId, anchor.position - 2, anchor.position + 2)) {
      if (row.position === anchor.position) continue;
      const message = JSON.parse(row.original);
      if (!accept(anchor.sessionId, message)) continue;
      const sample = message.text.length <= 512 ? message.text : message.text.slice(0, 256) + ' ' + message.text.slice(-256);
      const overlap = similarity(anchorTerms, evidenceTerms(sample));
      const lengthCost = 1 + message.text.length / 1800;
      const score = Math.max(1, Math.round(anchor.score * 0.73 * (1 - overlap) / lengthCost));
      const key = JSON.stringify([anchor.sessionId, row.position]);
      if (score > (contextual.get(key)?.score ?? 0)) {
        contextual.set(key, { sessionId: anchor.sessionId, position: row.position, at: message.at, score });
      }
    }
  }
  if (contextual.size) {
    for (const row of ranked) {
      const key = JSON.stringify([row.sessionId, row.position]);
      const neighbor = contextual.get(key);
      if (neighbor) {
        if (!leading.includes(row)) row.score = Math.max(row.score, neighbor.score);
        contextual.delete(key);
      }
    }
    // Preserve a small leading set of independent direct matches, even when a
    // single high-scoring conversation has several eligible surrounding turns.
    ranked.splice(0, leading.length);
    ranked.push(...contextual.values());
    ranked.sort(compareRows);
    ranked.unshift(...leading);
  }
  const get = db.prepare('SELECT original FROM messages WHERE session_id = ? AND position = ?');
  for (const row of ranked) {
    yield { session_id: row.sessionId, position: row.position, score: row.score, original: get.get(row.sessionId, row.position).original };
  }
}
