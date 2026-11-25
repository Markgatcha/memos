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
  if (base !== term && /(?:ed|ing)$/.test(term)) {
    if (/([bdgmnprt])\1$/.test(base)) base = base.slice(0, -1);
    else variants.add(base + 'e');
  }
  if (base.length < 3) return [];
  variants.add(base);
  variants.add(/[^aeiou]y$/.test(base) ? base.slice(0, -1) + 'ies' :
    /(?:sh|ch|ss|x|z)$/.test(base) ? base + 'es' : base + 's');
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

// terms(workspace_id, term, session_id, position) is a binary posting index.
// messages(session_id, position, original) stores {id, role, text, at} as JSON.
// The caller owns authorization. Only accepted rows influence the statistics.
export function* rankMemoryRows(db, { workspaceId, excludeSessionId, terms, accept = () => true }) {
  const query = termMap(terms);
  if (!query.size) return;
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
    session.rows.push({ sessionId: hit.session_id, position: hit.position, at: message.at,
      length: message.text.length, matched });
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
    }
    session.rows.sort(compareRows);
    for (const [index, row] of session.rows.entries()) {
      row.score = Math.max(1, Math.round(1000 * row.score / (1 + 0.35 * Math.log2(1 + index))));
      ranked.push(row);
    }
  }
  ranked.sort(compareRows);
  const get = db.prepare('SELECT original FROM messages WHERE session_id = ? AND position = ?');
  for (const row of ranked) {
    yield { session_id: row.sessionId, score: row.score, original: get.get(row.sessionId, row.position).original };
  }
}
