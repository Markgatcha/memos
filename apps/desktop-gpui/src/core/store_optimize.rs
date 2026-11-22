//! Optional, explicit schema optimisation for stores created by older SDKs.
//!
//! The desktop app is read-only by default. This module is the second (and
//! only other) deliberate write path: it only runs from the **Optimize store**
//! action, only adds indexes that are missing, and never touches rows or
//! tables. `CREATE INDEX IF NOT EXISTS` makes it idempotent.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum OptimizeError {
    #[error("could not open the store for optimisation: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0} is not a MemOS store")]
    NotAStore(PathBuf),
    #[error("store optimisation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

impl OptimizeError {
    pub fn ui_summary(&self) -> String {
        match self {
            OptimizeError::NotAStore(_) => "That file is not a MemOS store".to_string(),
            OptimizeError::Io(_) | OptimizeError::Sqlite(_) => {
                "Could not optimise this store".to_string()
            }
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OptimizeReport {
    pub created: Vec<String>,
}

impl OptimizeReport {
    pub fn summary(&self) -> String {
        match self.created.len() {
            0 => "Store is already optimised".to_string(),
            1 => "Added 1 index — lists will load faster".to_string(),
            n => format!("Added {n} indexes — lists will load faster"),
        }
    }
}

/// Indexes that are safe to add to any store with the matching columns.
/// `(index name, required nodes column or None, SQL)`.
const INDEXES: &[(&str, Option<&str>, &str)] = &[
    (
        "idx_nodes_recency_sort",
        None,
        "CREATE INDEX IF NOT EXISTS idx_nodes_recency_sort \
         ON nodes(COALESCE(updated_at, created_at, 0) DESC, id DESC)",
    ),
    (
        "idx_nodes_namespace",
        Some("namespace"),
        "CREATE INDEX IF NOT EXISTS idx_nodes_namespace ON nodes(namespace)",
    ),
    (
        "idx_nodes_provenance",
        Some("provenance"),
        "CREATE INDEX IF NOT EXISTS idx_nodes_provenance ON nodes(provenance)",
    ),
    (
        "idx_nodes_trust_score",
        Some("trust_score"),
        "CREATE INDEX IF NOT EXISTS idx_nodes_trust_score ON nodes(trust_score)",
    ),
    (
        "idx_nodes_source",
        Some("source"),
        "CREATE INDEX IF NOT EXISTS idx_nodes_source ON nodes(source)",
    ),
    (
        "idx_nodes_pool",
        Some("pool"),
        "CREATE INDEX IF NOT EXISTS idx_nodes_pool ON nodes(pool)",
    ),
    (
        "idx_nodes_harness",
        Some("harness"),
        "CREATE INDEX IF NOT EXISTS idx_nodes_harness ON nodes(harness)",
    ),
    (
        "idx_nodes_expires_at",
        Some("expires_at"),
        "CREATE INDEX IF NOT EXISTS idx_nodes_expires_at ON nodes(expires_at)",
    ),
    (
        "idx_nodes_valid_from",
        Some("valid_from"),
        "CREATE INDEX IF NOT EXISTS idx_nodes_valid_from ON nodes(valid_from)",
    ),
    (
        "idx_nodes_valid_to",
        Some("valid_to"),
        "CREATE INDEX IF NOT EXISTS idx_nodes_valid_to ON nodes(valid_to)",
    ),
];

/// Add the missing read-path indexes. Non-destructive and idempotent.
pub fn optimize_store(path: &Path) -> Result<OptimizeReport, OptimizeError> {
    if let Ok(meta) = fs::symlink_metadata(path)
        && meta.file_type().is_symlink()
    {
        return Err(OptimizeError::NotAStore(path.to_path_buf()));
    }

    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.execute_batch("PRAGMA busy_timeout = 5000;")?;

    let has_nodes = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'nodes'",
            [],
            |_| Ok(()),
        )
        .is_ok();
    if !has_nodes {
        return Err(OptimizeError::NotAStore(path.to_path_buf()));
    }

    let mut cols: HashSet<String> = HashSet::new();
    {
        let mut stmt = conn.prepare("PRAGMA table_info(nodes)")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            if let Ok(name) = row.get::<_, String>(1) {
                cols.insert(name);
            }
        }
    }

    let existing: HashSet<String> = {
        let mut stmt =
            conn.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'nodes'")?;
        let mut rows = stmt.query([])?;
        let mut names = HashSet::new();
        while let Some(row) = rows.next()? {
            if let Ok(name) = row.get::<_, String>(0) {
                names.insert(name);
            }
        }
        names
    };

    let mut report = OptimizeReport::default();
    for (name, required_col, sql) in INDEXES {
        if let Some(col) = required_col
            && !cols.contains(*col)
        {
            continue;
        }
        if existing.contains(*name) {
            continue;
        }
        conn.execute_batch(sql)?;
        report.created.push((*name).to_string());
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::store_init::create_store;
    use uuid::Uuid;

    #[test]
    fn adds_missing_indexes_and_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("memos-opt-{}", Uuid::new_v4()));
        let path = dir.join("memos.db");
        create_store(&path).expect("create store");

        // Simulate a store written by an older SDK.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "DROP INDEX IF EXISTS idx_nodes_recency_sort;
                 DROP INDEX IF EXISTS idx_nodes_provenance;",
            )
            .unwrap();
        }

        let first = optimize_store(&path).expect("optimise");
        assert!(first.created.iter().any(|n| n == "idx_nodes_recency_sort"));
        assert!(first.created.iter().any(|n| n == "idx_nodes_provenance"));

        let second = optimize_store(&path).expect("optimise again");
        assert!(second.created.is_empty(), "second run must be a no-op");

        // A non-store file is refused and left alone.
        let foreign = dir.join("notes.txt");
        std::fs::write(&foreign, "hello").unwrap();
        assert!(matches!(
            optimize_store(&foreign),
            Err(OptimizeError::NotAStore(_))
        ));
        assert_eq!(std::fs::read_to_string(&foreign).unwrap(), "hello");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
