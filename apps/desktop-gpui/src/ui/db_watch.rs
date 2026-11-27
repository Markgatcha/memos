//! Event-driven filesystem watching for the memory store.
//!
//! The desktop UI used to stat the database file every 1.5 s (8 s while the
//! window is inactive) to notice external writes. That poll was one of the
//! two suspected contributors to idle CPU use. `DbWatcher` instead registers
//! a kernel-level watch (`ReadDirectoryChangesW` / FSEvents / inotify) on the
//! store's parent directory and reports only events touching the database
//! file or its `-wal`/`-shm` siblings, so a quiet app never wakes up for the
//! watcher at all. A slow fallback poll in `app.rs` still covers missed
//! events (network filesystems, unsupported backends).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use futures::channel::mpsc::UnboundedReceiver;
use notify::{Event, EventKind, RecursiveMode, Watcher};

pub struct DbWatcher {
    db_path: PathBuf,
    events: UnboundedReceiver<()>,
    // Held only for its Drop side effect: dropping stops the kernel watch.
    _watcher: notify::RecommendedWatcher,
}

impl DbWatcher {
    /// Watch the parent directory of `db_path` non-recursively. Watching the
    /// directory rather than the file keeps working across store creation in
    /// onboarding and across SQLite's delete/recreate write pattern.
    ///
    /// Returns `None` when the path has no existing parent directory or the
    /// platform backend fails; callers then fall back to polling.
    pub fn watch(db_path: &Path) -> Option<Self> {
        // A bare filename (`--db memos.db`) has an empty parent path; anchor
        // the watch at the working directory instead of giving up.
        let dir = match db_path.parent()? {
            d if d.as_os_str().is_empty() => Path::new("."),
            d => d,
        };
        if !dir.is_dir() {
            return None;
        }
        let base = db_path.file_name()?.to_os_string();
        let mut file_names = vec![base.clone()];
        if let Some(name) = base.to_str() {
            file_names.push(OsString::from(format!("{name}-wal")));
            file_names.push(OsString::from(format!("{name}-shm")));
        }

        let (tx, rx) = futures::channel::mpsc::unbounded::<()>();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            let Ok(event) = res else {
                return;
            };
            // Only lifecycle/content changes matter; access events (e.g.
            // inotify open notifications from read-only clients) would wake
            // the reload loop for nothing.
            if !matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
            ) {
                return;
            }
            let hit = event.paths.iter().any(|p| {
                p.file_name()
                    .is_some_and(|n| file_names.iter().any(|w| w == n))
            });
            if hit {
                // The receiver is alive as long as the watcher struct is;
                // a failed send just means nobody is listening anymore.
                let _ = tx.unbounded_send(());
            }
        })
        .ok()?;
        watcher.watch(dir, RecursiveMode::NonRecursive).ok()?;

        Some(Self {
            db_path: db_path.to_path_buf(),
            events: rx,
            _watcher: watcher,
        })
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn receiver(&mut self) -> &mut UnboundedReceiver<()> {
        &mut self.events
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn temp_store() -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("memos-watch-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("store.db");
        std::fs::write(&db, b"seed").unwrap();
        (dir, db)
    }

    fn next_event_within(watcher: &mut DbWatcher, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if watcher.receiver().try_recv().is_ok() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn fires_on_db_write() {
        let (dir, db) = temp_store();
        let mut watcher = DbWatcher::watch(&db).expect("watcher should be created");
        std::fs::write(&db, b"changed").unwrap();
        assert!(
            next_event_within(&mut watcher, Duration::from_secs(5)),
            "expected a watch event after modifying the db file"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ignores_unrelated_files_but_sees_wal() {
        let (dir, db) = temp_store();
        let mut watcher = DbWatcher::watch(&db).expect("watcher should be created");
        std::fs::write(dir.join("unrelated.txt"), b"noise").unwrap();
        assert!(
            !next_event_within(&mut watcher, Duration::from_millis(500)),
            "unrelated file writes must not trigger the watcher"
        );
        std::fs::write(dir.join("store.db-wal"), b"wal bytes").unwrap();
        assert!(
            next_event_within(&mut watcher, Duration::from_secs(5)),
            "expected a watch event after writing the wal file"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bare_filename_watches_working_directory() {
        assert!(
            DbWatcher::watch(Path::new("memos.db")).is_some(),
            "a bare filename should anchor the watch at the working directory"
        );
    }

    #[test]
    fn returns_none_without_parent_dir() {
        let missing = std::env::temp_dir()
            .join(format!("memos-watch-missing-{}", uuid::Uuid::new_v4()))
            .join("store.db");
        assert!(DbWatcher::watch(&missing).is_none());
    }
}
