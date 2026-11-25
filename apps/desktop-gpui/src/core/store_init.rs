//! Create a brand-new, SDK-compatible MemOS store from inside the desktop app.
//!
//! Everything else in this crate opens SQLite **read-only**. Creating a store
//! is the single deliberate exception: it runs only from an explicit
//! "Create memory store" action, against a path that does not already hold a
//! store, and it writes the canonical schema below in one transaction.
//!
//! The schema mirrors `src/storage/sqlite.ts` (the writer SDK) after its
//! migrations, so the `memos` CLI and MCP server can write to a store created
//! here without an extra migration pass.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreInitError {
    #[error("could not create the store folder: {0}")]
    Io(#[from] std::io::Error),
    #[error("a MemOS store already exists at {0}")]
    AlreadyExists(PathBuf),
    #[error("a file that is not a MemOS store already exists at {0}")]
    PathOccupied(PathBuf),
    #[error("could not create the store: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

impl StoreInitError {
    /// Short, actionable message for the UI (never includes raw SQL).
    pub fn ui_summary(&self) -> String {
        match self {
            StoreInitError::AlreadyExists(path) => {
                format!("A MemOS store already exists at {}", path.display())
            }
            StoreInitError::PathOccupied(path) => format!(
                "A file already exists at {} and is not a MemOS store",
                path.display()
            ),
            StoreInitError::Io(_) => "Could not create the folder for the new store".to_string(),
            StoreInitError::Sqlite(_) => "Could not create the store file".to_string(),
        }
    }
}

/// Tables written by the writer SDK. Kept in one batch so creation is atomic.
const SCHEMA: &str = r#"
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS nodes (
  id               TEXT PRIMARY KEY,
  content          TEXT NOT NULL,
  summary          TEXT NOT NULL DEFAULT '',
  type             TEXT NOT NULL DEFAULT 'fact',
  metadata         TEXT NOT NULL DEFAULT '{}',
  importance       REAL NOT NULL DEFAULT 0.5,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  access_count     INTEGER NOT NULL DEFAULT 0,
  last_accessed    INTEGER NOT NULL DEFAULT 0,
  expires_at       INTEGER DEFAULT NULL,
  tags             TEXT NOT NULL DEFAULT '[]',
  namespace        TEXT NOT NULL DEFAULT 'default',
  valid_from       INTEGER DEFAULT NULL,
  valid_to         INTEGER DEFAULT NULL,
  source           TEXT NOT NULL DEFAULT 'user_input',
  trust_score      REAL NOT NULL DEFAULT 1.0,
  pool             TEXT NOT NULL DEFAULT 'event',
  provenance       TEXT NOT NULL DEFAULT 'user',
  quarantined      INTEGER NOT NULL DEFAULT 0,
  quarantined_at   INTEGER DEFAULT NULL,
  quarantine_reason TEXT DEFAULT NULL,
  harness          TEXT NOT NULL DEFAULT 'unknown'
);

CREATE TABLE IF NOT EXISTS edges (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  relation    TEXT NOT NULL DEFAULT 'relates_to',
  weight      REAL NOT NULL DEFAULT 0.5,
  metadata    TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  valid_from  INTEGER DEFAULT NULL,
  valid_to    INTEGER DEFAULT NULL,
  UNIQUE(source_id, target_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_importance ON nodes(importance);
CREATE INDEX IF NOT EXISTS idx_nodes_namespace ON nodes(namespace);
CREATE INDEX IF NOT EXISTS idx_nodes_expires_at ON nodes(expires_at);
CREATE INDEX IF NOT EXISTS idx_nodes_valid_from ON nodes(valid_from);
CREATE INDEX IF NOT EXISTS idx_nodes_valid_to ON nodes(valid_to);
CREATE INDEX IF NOT EXISTS idx_nodes_trust_score ON nodes(trust_score);
CREATE INDEX IF NOT EXISTS idx_nodes_source ON nodes(source);
CREATE INDEX IF NOT EXISTS idx_nodes_provenance ON nodes(provenance);
CREATE INDEX IF NOT EXISTS idx_nodes_pool ON nodes(pool);
CREATE INDEX IF NOT EXISTS idx_nodes_harness ON nodes(harness);
-- Matches the desktop list's ORDER BY exactly, so recency pages use an index
-- instead of scanning and sorting the whole table.
CREATE INDEX IF NOT EXISTS idx_nodes_recency_sort
  ON nodes(COALESCE(updated_at, created_at, 0) DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_valid_from ON edges(valid_from);
CREATE INDEX IF NOT EXISTS idx_edges_valid_to ON edges(valid_to);

CREATE TABLE IF NOT EXISTS embeddings (
  node_id    TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  vector     BLOB NOT NULL,
  dimensions INTEGER NOT NULL,
  model      TEXT NOT NULL,
  prefix     TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_embeddings_model_dims ON embeddings(dimensions, model);

CREATE TABLE IF NOT EXISTS image_embeddings (
  node_id    TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  vector     BLOB NOT NULL,
  dimensions INTEGER NOT NULL,
  model      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_image_embeddings_model_dims
  ON image_embeddings(dimensions, model);

CREATE TABLE IF NOT EXISTS contradictions (
  id          TEXT PRIMARY KEY,
  node_a      TEXT NOT NULL,
  node_b      TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'unresolved',
  UNIQUE(node_a, node_b)
);
CREATE INDEX IF NOT EXISTS idx_contradictions_nodes ON contradictions(node_a, node_b);

CREATE TABLE IF NOT EXISTS procedural_lessons (
  id            TEXT PRIMARY KEY,
  lesson        TEXT NOT NULL,
  context       TEXT NOT NULL DEFAULT '',
  tags          TEXT NOT NULL DEFAULT '[]',
  score         REAL NOT NULL DEFAULT 0.5,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  use_count     INTEGER NOT NULL DEFAULT 0,
  namespace     TEXT NOT NULL DEFAULT 'default',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_procedural_lessons_namespace ON procedural_lessons(namespace);
CREATE INDEX IF NOT EXISTS idx_procedural_lessons_score ON procedural_lessons(score);

CREATE TABLE IF NOT EXISTS recall_batches (
  id      TEXT PRIMARY KEY,
  ts      INTEGER NOT NULL,
  query   TEXT NOT NULL,
  outcome TEXT NOT NULL,
  weight  REAL NOT NULL DEFAULT 1,
  note    TEXT
);
CREATE INDEX IF NOT EXISTS idx_recall_batches_ts ON recall_batches(ts);

CREATE TABLE IF NOT EXISTS recall_feedback (
  batch_id  TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  PRIMARY KEY (batch_id, memory_id)
);
CREATE INDEX IF NOT EXISTS idx_recall_feedback_memory ON recall_feedback(memory_id);

CREATE TABLE IF NOT EXISTS tamper_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  op         TEXT NOT NULL,
  node_id    TEXT NOT NULL,
  node_hash  TEXT NOT NULL,
  prev_hash  TEXT NOT NULL,
  entry_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tamper_log_node ON tamper_log(node_id);

CREATE TABLE IF NOT EXISTS recall_traces (
  id          TEXT PRIMARY KEY,
  session_id  TEXT,
  query       TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  latency_ms  REAL NOT NULL,
  payload     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recall_traces_created_at ON recall_traces(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recall_traces_session ON recall_traces(session_id);

CREATE TABLE IF NOT EXISTS node_tags (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (node_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_node_tags_tag ON node_tags(tag);

CREATE TABLE IF NOT EXISTS entity_index (
  entity  TEXT NOT NULL,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  PRIMARY KEY (entity, node_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_index_entity ON entity_index(entity);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  content,
  summary,
  content='nodes',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, content, summary)
  VALUES (new.rowid, new.content, new.summary);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, content, summary)
  VALUES ('delete', old.rowid, old.content, old.summary);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, content, summary)
  VALUES ('delete', old.rowid, old.content, old.summary);
  INSERT INTO nodes_fts(rowid, content, summary)
  VALUES (new.rowid, new.content, new.summary);
END;
"#;

fn already_holds_store(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }
    let Ok(conn) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return false;
    };
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'nodes'",
        [],
        |_| Ok(()),
    )
    .is_ok()
}

/// Create the canonical MemOS schema at `path`.
///
/// Refuses to touch a file that already contains a `nodes` table, a symlink,
/// or a non-empty file that is not a store. The path is reserved with
/// `create_new` so two concurrent clicks cannot both initialize it.
pub fn create_store(path: &Path) -> Result<(), StoreInitError> {
    if let Ok(meta) = fs::symlink_metadata(path)
        && meta.file_type().is_symlink()
    {
        return Err(StoreInitError::PathOccupied(path.to_path_buf()));
    }
    if already_holds_store(path) {
        return Err(StoreInitError::AlreadyExists(path.to_path_buf()));
    }
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)?;
    }

    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            // An empty leftover file (for example from an interrupted first
            // attempt) is safe to initialize; anything else is not ours.
            let meta = fs::metadata(path)?;
            if meta.len() > 0 {
                return Err(StoreInitError::PathOccupied(path.to_path_buf()));
            }
        }
        Err(err) => return Err(StoreInitError::Io(err)),
    }

    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    // Re-check on the reserved file: never run DDL into an existing store.
    let has_nodes = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'nodes'",
            [],
            |_| Ok(()),
        )
        .is_ok();
    if has_nodes {
        return Err(StoreInitError::AlreadyExists(path.to_path_buf()));
    }
    // WAL keeps the desktop's read-only connection seeing committed writes.
    let _mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    conn.execute_batch("PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;")?;
    conn.execute_batch(SCHEMA)?;
    Ok(())
}

/// Suggested path for a new store when the user has not chosen one.
pub fn suggested_store_path() -> PathBuf {
    dirs_home()
        .map(|home| home.join(".memos").join("memos.db"))
        .unwrap_or_else(|| PathBuf::from(".memos").join("memos.db"))
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::db::ReadOnlyStore;
    use uuid::Uuid;

    #[test]
    fn creates_a_store_the_desktop_can_read_and_the_writer_accepts() {
        let dir = std::env::temp_dir().join(format!("memos-init-{}", Uuid::new_v4()));
        let path = dir.join("memos.db");

        create_store(&path).expect("create store");
        assert!(path.exists());

        let store = ReadOnlyStore::open(&path).expect("open created store");
        let overview = store.load_overview().expect("overview");
        assert_eq!(overview.node_count, 0);
        assert!(store.schema().has_table("nodes_fts"));
        assert!(store.schema().has_table("node_tags"));
        assert!(
            store.schema().check_writer_preflight().compatible,
            "writer preflight: {:?}",
            store.schema().check_writer_preflight().missing
        );

        // Creating over an existing store is refused rather than destructive.
        let err = create_store(&path).expect_err("second create must fail");
        assert!(matches!(err, StoreInitError::AlreadyExists(_)));

        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_non_store_files_but_accepts_an_empty_leftover() {
        let dir = std::env::temp_dir().join(format!("memos-init-guard-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let occupied = dir.join("notes.txt");
        std::fs::write(&occupied, "not a database").unwrap();
        let err = create_store(&occupied).expect_err("must refuse a foreign file");
        assert!(matches!(err, StoreInitError::PathOccupied(_)));
        assert_eq!(
            std::fs::read_to_string(&occupied).unwrap(),
            "not a database"
        );

        let leftover = dir.join("empty.db");
        std::fs::write(&leftover, "").unwrap();
        create_store(&leftover).expect("an empty leftover file can be initialized");
        assert!(ReadOnlyStore::open(&leftover).is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
