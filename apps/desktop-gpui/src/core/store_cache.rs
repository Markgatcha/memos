//! One long-lived read-only SQLite connection, reopened only when the file changes.
//!
//! Opening a `ReadOnlyStore` re-introspects every table (`PRAGMA table_info`)
//! and starts with a cold statement cache and page cache. The UI used to open
//! a new store for every search, page, detail and graph load; this cache keeps
//! one connection alive and keys it on the main-file + WAL stamp so external
//! writers still invalidate it.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use crate::core::db::{DbError, ReadOnlyStore};

type FileStamp = (u64, Option<SystemTime>);

#[derive(Default)]
struct Slot {
    path: Option<PathBuf>,
    stamp: Option<FileStamp>,
    store: Option<ReadOnlyStore>,
    #[cfg(test)]
    opens: usize,
}

/// Cloneable handle. Clones share one connection guarded by a mutex.
#[derive(Clone, Default)]
pub struct SharedStore {
    slot: Arc<Mutex<Slot>>,
}

impl SharedStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Open the store now if the cached one is missing or stale.
    ///
    /// Useful for recording the `db_open` startup phase separately from the
    /// first query.
    pub fn ensure_open(&self, path: &Path) -> Result<(), DbError> {
        let mut slot = self.lock();
        ensure_open_locked(&mut slot, path)
    }

    /// Run `f` against the cached store, opening or reopening as needed.
    ///
    /// The lock is held for the duration of `f`; all callers are short
    /// read-only queries, and SQLite serialises them on the connection anyway.
    pub fn with_store<T>(
        &self,
        path: &Path,
        f: impl FnOnce(&ReadOnlyStore) -> Result<T, DbError>,
    ) -> Result<T, DbError> {
        let mut slot = self.lock();
        ensure_open_locked(&mut slot, path)?;
        let store = slot
            .store
            .as_ref()
            .expect("ensure_open_locked leaves the store populated");
        f(store)
    }

    /// Drop the cached connection (used after the configured database changes).
    pub fn invalidate(&self) {
        let mut slot = self.lock();
        slot.store = None;
        slot.path = None;
        slot.stamp = None;
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Slot> {
        self.slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[cfg(test)]
    pub fn open_count(&self) -> usize {
        self.lock().opens
    }
}

fn ensure_open_locked(slot: &mut Slot, path: &Path) -> Result<(), DbError> {
    let stamp = file_stamp(path);
    if slot.store.is_some() && slot.path.as_deref() == Some(path) && slot.stamp == stamp {
        return Ok(());
    }
    slot.store = None;
    slot.path = Some(path.to_path_buf());
    slot.stamp = stamp;
    slot.store = Some(ReadOnlyStore::open(path)?);
    #[cfg(test)]
    {
        slot.opens += 1;
    }
    // Opening a read-only WAL database can create/refresh the -shm and -wal
    // sidecars, which changes the stamp we just read. Adopt the post-open
    // state so our own connection doesn't invalidate itself on the next call.
    slot.stamp = file_stamp(path);
    Ok(())
}

/// Length and mtime of the main file plus its WAL, matching the change
/// detection the app already uses for live reloads.
pub fn file_stamp(db_path: &Path) -> Option<FileStamp> {
    let main_meta = std::fs::metadata(db_path).ok()?;
    let wal_path = PathBuf::from(format!("{}-wal", db_path.display()));
    let (wal_len, wal_mod) = std::fs::metadata(&wal_path)
        .ok()
        .map(|m| (m.len(), m.modified().ok()))
        .unwrap_or((0, None));
    let combined_len = main_meta.len().saturating_add(wal_len);
    let latest_mod = match (main_meta.modified().ok(), wal_mod) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    };
    Some((combined_len, latest_mod))
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn reuses_one_connection_and_reopens_after_an_external_write() {
        let dir = std::env::temp_dir().join(format!("memos-cache-{}", Uuid::new_v4()));
        let path = dir.join("memos.db");
        crate::core::store_init::create_store(&path).expect("create store");

        let shared = SharedStore::new();
        for _ in 0..5 {
            let count = shared
                .with_store(&path, |store| store.load_overview())
                .expect("overview")
                .node_count;
            assert_eq!(count, 0);
        }
        assert_eq!(shared.open_count(), 1, "repeated reads must reuse the connection");

        {
            let writer = rusqlite::Connection::open(&path).expect("open for write");
            let now = 1_700_000_000_000_i64;
            writer
                .execute(
                    "INSERT INTO nodes (id, content, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
                    rusqlite::params!["cache-test-1", "written outside the app", now],
                )
                .expect("external write");
        }

        let count = shared
            .with_store(&path, |store| store.load_overview())
            .expect("overview after write")
            .node_count;
        assert_eq!(count, 1);
        assert_eq!(shared.open_count(), 2, "file change must reopen once");

        drop(shared);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
