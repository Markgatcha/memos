import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { indexTerms, rankMemoryRows } from './retrieval-ranking.mjs';

// Mirrored verbatim from the Next product revision identified by product_memory_store_sha256 in measurement.json.
function memoryOptOut(text) {
  const normalized = text.normalize('NFKC').replace(/[’‘]/g, "'");
  return /(?:\boff[\s-]+the[\s-]+record\b|\b(?:just|only)\s+this\s+time\b|\b(?:do\s+not|don't|never|must\s+not|should\s+not)\s+(?:(?:ever|automatically)\s+)*(?:remember|save|store|record|retain|memorize|log|keep)\b|\b(?:don't|do not|never)\s+(?:add|put|write)\b[^.!?\n]{0,80}\b(?:memory|memories)\b|(?:仅(?:限)?|只(?:限)?)\s*(?:这|本|此)\s*次|不留(?:下)?(?:任何)?(?:记录|痕迹)|(?:不要|别|请勿|切勿|不得|禁止|不必|不需要|不想让你)\s*(?:再|长期|自动|替我|帮我|把[^。！？\n]{0,40})*\s*(?:记(?:住|录|忆|下来)|保存|存储|留存|留下|写入|加入))/iu.test(normalized);
}

function sleepSafe(text) {
  const secret = /(?:api[-_ ]?key|access[-_ ]?token|password|passcode|verification code|\botp\b|验证码|密码|密钥|令牌|sk-[a-z\d]{10,}|gh[pousr]_[a-z\d]{10,}|\b\d{6,8}\b)/iu;
  return !secret.test(text.normalize('NFKC')) && !memoryOptOut(text);
}

// Clean, in-memory adapter for newly imported benchmark conversations.
// Production reads additionally implement edited facts, tombstones and persistent exclusions.
export class MemoryStore {
  #db;
  #enabled = new Set();

  constructor(path) {
    assert.equal(path, ':memory:');
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE messages (session_id TEXT NOT NULL, position INTEGER NOT NULL, id TEXT NOT NULL,
        original TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(session_id,position));
      CREATE TABLE terms (workspace_id TEXT NOT NULL, term TEXT NOT NULL, session_id TEXT NOT NULL,
        position INTEGER NOT NULL, PRIMARY KEY(workspace_id,term,session_id,position)) WITHOUT ROWID;
      CREATE INDEX terms_message ON terms(session_id,position);
    `);
  }

  setMemoryEnabled(workspaceId, enabled) {
    if (enabled) this.#enabled.add(workspaceId);
    else this.#enabled.delete(workspaceId);
  }

  importSession({ id, workspaceId, updatedAt, messages }) {
    const putMessage = this.#db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)');
    const putTerm = this.#db.prepare('INSERT INTO terms VALUES (?,?,?,?)');
    this.#db.exec('BEGIN');
    try {
      this.#db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(id,workspaceId,updatedAt);
      for (const [position, message] of messages.entries()) {
        const {id: messageId, role, text, at} = message;
        putMessage.run(id,position,messageId,JSON.stringify({id:messageId,role,text,at}),at);
        if (role === 'user' && !memoryOptOut(text)) {
          for (const term of indexTerms(text)) putTerm.run(workspaceId,term,id,position);
        }
      }
      this.#db.exec('COMMIT');
      return {messageCount: messages.length};
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  listSessions(workspaceId) {
    return this.#db.prepare('SELECT id FROM sessions WHERE workspace_id=?').all(workspaceId);
  }

  retrieve({workspaceId, question, maxChars, excludeSessionId}) {
    const sources = [];
    if (!this.#enabled.has(workspaceId) || !maxChars) return {sources};
    const terms = [...indexTerms(question)];
    if (!terms.length) return {sources};
    const accept = (_sessionId, message) => message.role === 'user' && sleepSafe(message.text);
    const rows = rankMemoryRows(this.#db, {workspaceId, excludeSessionId, terms, accept});
    let contextLength = 0;
    for (const row of rows) {
      const {id: messageId, role, text, at} = JSON.parse(row.original);
      if (!accept(row.session_id, {role, text})) continue;
      const source = {sessionId:row.session_id, messageId, text, at, score:row.score};
      const entryLength = JSON.stringify(source).length + (sources.length ? 1 : 0);
      if (contextLength + entryLength > maxChars) continue;
      sources.push(source);
      contextLength += entryLength;
      if (sources.length >= 64) break;
    }
    return {sources};
  }

  close() {
    this.#db.close();
  }
}
