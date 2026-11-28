//! Read-only verification of the store's tamper-evident mutation log.
//!
//! The SDK appends one row to `tamper_log` for every store / import / update /
//! forget, each row hashing the previous one (see `src/tamper-log.ts`). This
//! module recomputes that chain in Rust without ever writing to SQLite:
//!
//! - **Chain integrity**: sequence continuity, `prev_hash` linkage and the
//!   recomputed `entry_hash` for every row (v2 rows, plus the first-day v1
//!   format the SDK still accepts as legacy).
//! - **Existence cross-check**: a node whose latest entry is `forget` must be
//!   gone, and a node whose latest entry is anything else must still exist.
//!   The SDK's full node-state hash is deliberately *not* recomputed here:
//!   matching its canonical JSON byte-for-byte from SQL rows is fragile, and a
//!   false "tampered" verdict would be worse than no verdict. The UI points to
//!   `memos log verify` for that deeper comparison.
//! - **Local anchor**: after a clean pass the desktop remembers the tip
//!   (`seq`, `entry_hash`) it saw. On the next pass the row at that `seq` must
//!   still carry the same hash, so a chain rewritten from genesis since the
//!   last check is caught, which the log alone cannot prove.
//!
//! Everything here is pure except [`AnchorBook`] file I/O, which only touches
//! the desktop's own config directory.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Domain label the SDK hashes into the genesis `prev_hash`.
const GENESIS_LABEL: &str = "memos-tamper-log-genesis-v1";
const ENTRY_V2_PREFIX: &str = "memos-tamper-entry-v2";
const ENTRY_V1_PREFIX: &str = "memos-tamper-entry-v1";

pub fn sha256_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push(char::from_digit(u32::from(byte >> 4), 16).unwrap_or('0'));
        out.push(char::from_digit(u32::from(byte & 0x0f), 16).unwrap_or('0'));
    }
    out
}

/// The fixed `prev_hash` of the first entry, matching the SDK's `GENESIS_PREV`.
pub fn genesis_prev() -> String {
    format!("{GENESIS_LABEL}:{}", sha256_hex(GENESIS_LABEL))
}

/// Current (v2) entry hash: the chain position `seq` is bound into the hash.
pub fn entry_hash_v2(
    seq: i64,
    ts: i64,
    op: &str,
    node_id: &str,
    node_hash: &str,
    prev_hash: &str,
) -> String {
    sha256_hex(&format!(
        "{ENTRY_V2_PREFIX}|{seq}|{ts}|{op}|{node_id}|{node_hash}|{prev_hash}"
    ))
}

/// First-day (v1) entry hash: content-only and not bound to `seq`.
fn entry_hash_v1(ts: i64, op: &str, node_id: &str, content_hash: &str, prev_hash: &str) -> String {
    sha256_hex(&format!(
        "{ENTRY_V1_PREFIX}|{ts}|{op}|{node_id}|{content_hash}|{prev_hash}"
    ))
}

/// One `tamper_log` row as stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TamperRow {
    pub seq: i64,
    pub ts: i64,
    pub op: String,
    pub node_id: String,
    pub node_hash: String,
    pub prev_hash: String,
    pub entry_hash: String,
}

/// How the chain first failed to verify.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BreakKind {
    /// Rows are missing or out of order.
    SequenceGap,
    /// A row does not point at the hash of the row before it.
    LinkMismatch,
    /// A row's fields no longer produce its recorded hash.
    EditedInPlace,
}

impl BreakKind {
    pub fn describe(self) -> &'static str {
        match self {
            BreakKind::SequenceGap => "log rows were deleted or reordered",
            BreakKind::LinkMismatch => "a log row no longer links to the one before it",
            BreakKind::EditedInPlace => "a log row was edited in place",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChainBreak {
    pub seq: i64,
    pub kind: BreakKind,
}

/// The tip the desktop saw on its last clean verification of a store.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntegrityAnchor {
    pub seq: i64,
    pub entry_hash: String,
    pub verified_at_ms: i64,
}

/// Outcome of comparing the chain against the remembered anchor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnchorCheck {
    /// No anchor yet for this store (first verification).
    None,
    /// The anchored row is intact; `new_entries` were appended since.
    Extends { new_entries: usize },
    /// The anchored row changed or vanished: history was rewritten.
    Diverged,
}

/// Overall verdict, in order of severity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntegrityStatus {
    /// The store has no `tamper_log` table (it predates the log).
    NotRecorded,
    /// The log exists but holds no entries yet.
    Empty,
    /// Chain, existence cross-check and anchor all agree.
    Verified,
    /// The chain is intact, but some memories exist (or are missing) in a way
    /// the log does not explain: they were changed outside MemOS.
    Inconsistent,
    /// The chain itself does not verify, or diverged from the local anchor.
    Broken,
}

impl IntegrityStatus {
    /// Short text state marker for the status card.
    pub fn label(self) -> &'static str {
        match self {
            IntegrityStatus::NotRecorded => "Not recorded",
            IntegrityStatus::Empty => "No entries",
            IntegrityStatus::Verified => "Verified",
            IntegrityStatus::Inconsistent => "Out of sync",
            IntegrityStatus::Broken => "Tampered",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntegrityReport {
    pub status: IntegrityStatus,
    pub entries_checked: usize,
    pub legacy_entries: usize,
    pub tip: Option<IntegrityAnchor>,
    pub chain_break: Option<ChainBreak>,
    pub anchor: AnchorCheck,
    /// Nodes whose latest entry is `forget` but which still exist.
    pub resurrected: usize,
    /// Nodes whose latest entry is not `forget` but which are gone.
    pub deleted_without_log: usize,
    /// Live nodes with no log entry at all (they predate the log).
    pub unlogged_nodes: usize,
    pub first_ts: Option<i64>,
    pub last_ts: Option<i64>,
}

impl IntegrityReport {
    pub fn not_recorded() -> Self {
        Self {
            status: IntegrityStatus::NotRecorded,
            entries_checked: 0,
            legacy_entries: 0,
            tip: None,
            chain_break: None,
            anchor: AnchorCheck::None,
            resurrected: 0,
            deleted_without_log: 0,
            unlogged_nodes: 0,
            first_ts: None,
            last_ts: None,
        }
    }

    /// One plain sentence for the card body. Counts only, never memory text.
    pub fn headline(&self) -> String {
        match self.status {
            IntegrityStatus::NotRecorded => {
                "This store predates the mutation log, so there is no chain to check.".to_string()
            }
            IntegrityStatus::Empty => {
                "The mutation log is empty. Entries appear as memories are stored or changed."
                    .to_string()
            }
            IntegrityStatus::Verified => {
                let mut s = format!(
                    "{} {} verified, each linked to the one before it.",
                    self.entries_checked,
                    plural(self.entries_checked, "entry", "entries")
                );
                if let AnchorCheck::Extends { new_entries } = self.anchor {
                    if new_entries == 0 {
                        s.push_str(" Nothing changed since the last check.");
                    } else {
                        s.push_str(&format!(
                            " {new_entries} new since the last check; earlier history is unchanged."
                        ));
                    }
                }
                s
            }
            IntegrityStatus::Inconsistent => {
                let mut parts = Vec::new();
                if self.resurrected > 0 {
                    parts.push(format!(
                        "{} forgotten {} still present",
                        self.resurrected,
                        plural(self.resurrected, "memory is", "memories are")
                    ));
                }
                if self.deleted_without_log > 0 {
                    parts.push(format!(
                        "{} {} removed without a log entry",
                        self.deleted_without_log,
                        plural(self.deleted_without_log, "memory was", "memories were")
                    ));
                }
                format!(
                    "The chain is intact, but {}. Something changed the store outside MemOS.",
                    parts.join(" and ")
                )
            }
            IntegrityStatus::Broken => match (self.chain_break, self.anchor) {
                (Some(b), _) => format!(
                    "The chain breaks at entry {}: {}.",
                    b.seq,
                    b.kind.describe()
                ),
                (None, AnchorCheck::Diverged) => {
                    "The chain verifies on its own, but history differs from what this app verified last time: the log was rewritten."
                        .to_string()
                }
                _ => "The chain does not verify.".to_string(),
            },
        }
    }

    /// The anchor to remember after this pass, if it is safe to move it.
    ///
    /// Only a clean, non-diverged pass advances the anchor; a broken or
    /// diverged chain keeps the old anchor as evidence.
    pub fn next_anchor(&self) -> Option<IntegrityAnchor> {
        match self.status {
            IntegrityStatus::Verified | IntegrityStatus::Inconsistent
                if self.anchor != AnchorCheck::Diverged =>
            {
                self.tip.clone()
            }
            _ => None,
        }
    }
}

fn plural<'a>(n: usize, one: &'a str, many: &'a str) -> &'a str {
    if n == 1 { one } else { many }
}

#[derive(Clone, Copy, Debug)]
struct LatestOp {
    is_forget: bool,
}

/// Streaming verifier: feed rows in `seq` order, then [`ChainVerifier::finish`].
///
/// Memory is one small entry per distinct node, so a long log can be read
/// straight off a SQLite cursor without materialising every row.
pub struct ChainVerifier {
    expected_seq: i64,
    prev: String,
    checked: usize,
    legacy: usize,
    chain_break: Option<ChainBreak>,
    latest: HashMap<String, LatestOp>,
    tip: Option<(i64, String)>,
    first_ts: Option<i64>,
    last_ts: Option<i64>,
    anchor: Option<IntegrityAnchor>,
    anchor_seen: Option<bool>,
}

impl ChainVerifier {
    pub fn new(anchor: Option<IntegrityAnchor>) -> Self {
        Self {
            expected_seq: 1,
            prev: genesis_prev(),
            checked: 0,
            legacy: 0,
            chain_break: None,
            latest: HashMap::new(),
            tip: None,
            first_ts: None,
            last_ts: None,
            anchor,
            anchor_seen: None,
        }
    }

    pub fn push(&mut self, row: &TamperRow) {
        self.checked += 1;
        self.first_ts.get_or_insert(row.ts);
        self.last_ts = Some(row.ts);
        self.tip = Some((row.seq, row.entry_hash.clone()));

        if let Some(anchor) = &self.anchor
            && row.seq == anchor.seq
        {
            self.anchor_seen = Some(row.entry_hash == anchor.entry_hash);
        }

        // Keep counting rows and tracking the tip after a break, but stop
        // hashing: once the chain is broken nothing after it is trustworthy.
        if self.chain_break.is_some() {
            return;
        }
        if row.seq != self.expected_seq {
            self.chain_break = Some(ChainBreak {
                seq: row.seq,
                kind: BreakKind::SequenceGap,
            });
            return;
        }
        if row.prev_hash != self.prev {
            self.chain_break = Some(ChainBreak {
                seq: row.seq,
                kind: BreakKind::LinkMismatch,
            });
            return;
        }
        let v2 = entry_hash_v2(
            row.seq,
            row.ts,
            &row.op,
            &row.node_id,
            &row.node_hash,
            &row.prev_hash,
        );
        if v2 != row.entry_hash {
            // A v2 row can never verify as v1 (the domain prefixes differ), so
            // this only ever accepts genuine first-day rows.
            let v1 = entry_hash_v1(
                row.ts,
                &row.op,
                &row.node_id,
                &row.node_hash,
                &row.prev_hash,
            );
            if v1 != row.entry_hash {
                self.chain_break = Some(ChainBreak {
                    seq: row.seq,
                    kind: BreakKind::EditedInPlace,
                });
                return;
            }
            self.legacy += 1;
        }
        self.latest.insert(
            row.node_id.clone(),
            LatestOp {
                is_forget: row.op == "forget",
            },
        );
        self.prev = row.entry_hash.clone();
        self.expected_seq += 1;
    }

    /// Finish with the set of node ids that currently exist in the store.
    pub fn finish(self, live_ids: &HashSet<String>, now_ms: i64) -> IntegrityReport {
        let tip = self.tip.map(|(seq, entry_hash)| IntegrityAnchor {
            seq,
            entry_hash,
            verified_at_ms: now_ms,
        });
        let anchor = match (&self.anchor, self.anchor_seen) {
            (None, _) => AnchorCheck::None,
            (Some(_), Some(false)) | (Some(_), None) => AnchorCheck::Diverged,
            (Some(a), Some(true)) => AnchorCheck::Extends {
                new_entries: tip
                    .as_ref()
                    .map(|t| usize::try_from(t.seq.saturating_sub(a.seq)).unwrap_or(0))
                    .unwrap_or(0),
            },
        };

        let mut report = IntegrityReport {
            status: IntegrityStatus::Verified,
            entries_checked: self.checked,
            legacy_entries: self.legacy,
            tip,
            chain_break: self.chain_break,
            anchor,
            resurrected: 0,
            deleted_without_log: 0,
            unlogged_nodes: 0,
            first_ts: self.first_ts,
            last_ts: self.last_ts,
        };

        if self.checked == 0 {
            // An empty log after an anchor means the whole log was truncated.
            report.status = if anchor == AnchorCheck::Diverged {
                IntegrityStatus::Broken
            } else {
                IntegrityStatus::Empty
            };
            report.unlogged_nodes = live_ids.len();
            return report;
        }
        if report.chain_break.is_some() || anchor == AnchorCheck::Diverged {
            report.status = IntegrityStatus::Broken;
            return report;
        }

        for (node_id, op) in &self.latest {
            let alive = live_ids.contains(node_id);
            if op.is_forget && alive {
                report.resurrected += 1;
            } else if !op.is_forget && !alive {
                report.deleted_without_log += 1;
            }
        }
        report.unlogged_nodes = live_ids
            .iter()
            .filter(|id| !self.latest.contains_key(*id))
            .count();
        if report.resurrected > 0 || report.deleted_without_log > 0 {
            report.status = IntegrityStatus::Inconsistent;
        }
        report
    }
}

/// Remembered anchors, one per store path, in the desktop config directory.
///
/// Holds hashes and sequence numbers only: no memory text, nothing that
/// leaves the machine.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnchorBook {
    #[serde(default)]
    pub anchors: BTreeMap<String, IntegrityAnchor>,
}

impl AnchorBook {
    pub fn default_path() -> PathBuf {
        crate::core::settings::AppSettings::config_path().with_file_name("integrity-anchors.json")
    }

    pub fn key_for(db_path: &Path) -> String {
        fs::canonicalize(db_path)
            .unwrap_or_else(|_| db_path.to_path_buf())
            .to_string_lossy()
            .into_owned()
    }

    pub fn load_from(path: &Path) -> Self {
        fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn get(&self, db_path: &Path) -> Option<IntegrityAnchor> {
        self.anchors.get(&Self::key_for(db_path)).cloned()
    }

    pub fn set(&mut self, db_path: &Path, anchor: IntegrityAnchor) {
        self.anchors.insert(Self::key_for(db_path), anchor);
    }

    pub fn forget(&mut self, db_path: &Path) -> bool {
        self.anchors.remove(&Self::key_for(db_path)).is_some()
    }

    /// Atomic write: temp file in the same directory, then rename.
    pub fn save_to(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            fs::create_dir_all(parent)?;
        }
        let body = serde_json::to_string_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let tmp = path.with_file_name(format!(
            "integrity-anchors.json.tmp.{}",
            uuid::Uuid::new_v4()
        ));
        if let Err(err) = fs::write(&tmp, body) {
            let _ = fs::remove_file(&tmp);
            return Err(err);
        }
        if let Err(err) = fs::rename(&tmp, path) {
            let _ = fs::remove_file(&tmp);
            return Err(err);
        }
        Ok(())
    }
}

/// Verify `db_path` end to end and update the anchor book at `book_path`.
///
/// `forget_anchor` drops the remembered anchor first, for when the user has
/// deliberately replaced the store (restored a backup) and accepts the
/// current chain as the new baseline.
pub fn verify_store_integrity(
    store: &crate::core::db::ReadOnlyStore,
    db_path: &Path,
    book_path: &Path,
    forget_anchor: bool,
    now_ms: i64,
) -> Result<IntegrityReport, crate::core::db::DbError> {
    let mut book = AnchorBook::load_from(book_path);
    if forget_anchor {
        book.forget(db_path);
    }
    let anchor = book.get(db_path);
    let report = store.verify_tamper_log(anchor, now_ms)?;
    let changed = match report.next_anchor() {
        Some(next) => {
            let changed = book.get(db_path).as_ref() != Some(&next);
            book.set(db_path, next);
            changed
        }
        None => forget_anchor,
    };
    if changed && let Err(_err) = book.save_to(book_path) {
        crate::core_warn!(error = %_err, "failed to persist integrity anchor");
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a valid v2 chain the same way the SDK's `appendTamperEntry` does.
    fn chain(ops: &[(&str, &str)]) -> Vec<TamperRow> {
        let mut prev = genesis_prev();
        let mut rows = Vec::new();
        for (i, (op, node)) in ops.iter().enumerate() {
            let seq = i as i64 + 1;
            let ts = 1_700_000_000_000 + seq * 1000;
            let node_hash = sha256_hex(&format!("state-{node}-{seq}"));
            let entry_hash = entry_hash_v2(seq, ts, op, node, &node_hash, &prev);
            rows.push(TamperRow {
                seq,
                ts,
                op: (*op).to_string(),
                node_id: (*node).to_string(),
                node_hash,
                prev_hash: prev.clone(),
                entry_hash: entry_hash.clone(),
            });
            prev = entry_hash;
        }
        rows
    }

    fn live(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| (*s).to_string()).collect()
    }

    fn run(rows: &[TamperRow], ids: &[&str], anchor: Option<IntegrityAnchor>) -> IntegrityReport {
        let mut v = ChainVerifier::new(anchor);
        for r in rows {
            v.push(r);
        }
        v.finish(&live(ids), 42)
    }

    #[test]
    fn genesis_and_entry_hash_match_the_sdk_recipe() {
        // Reference values produced by the SDK itself (src/tamper-log.ts,
        // GENESIS_PREV and entryHash) under Node 22.
        assert_eq!(
            genesis_prev(),
            "memos-tamper-log-genesis-v1:5ca93abd6e367b36aabdb2f509db22440557c0dafd7011c2fe0a0a82e8903da8"
        );
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            entry_hash_v2(
                1,
                1_700_000_000_000,
                "store",
                "node-a",
                "nh",
                &genesis_prev()
            ),
            SDK_FIRST_ENTRY_HASH
        );
    }

    /// `entryHash({seq:1, ts:1700000000000, op:"store", nodeId:"node-a",
    /// nodeHash:"nh", prevHash:GENESIS_PREV})` from the SDK.
    const SDK_FIRST_ENTRY_HASH: &str =
        "78615668432e541013eabfd41ab25af223ab14e0b9c42cb3cd9eb644f92dc9d4";

    #[test]
    fn clean_chain_verifies_and_reports_tip() {
        let rows = chain(&[("store", "a"), ("store", "b"), ("update", "a")]);
        let r = run(&rows, &["a", "b"], None);
        assert_eq!(r.status, IntegrityStatus::Verified);
        assert_eq!(r.entries_checked, 3);
        assert_eq!(r.tip.as_ref().map(|t| t.seq), Some(3));
        assert_eq!(r.anchor, AnchorCheck::None);
        assert!(r.next_anchor().is_some());
    }

    #[test]
    fn edited_row_breaks_the_chain_at_that_entry() {
        let mut rows = chain(&[("store", "a"), ("store", "b"), ("store", "c")]);
        rows[1].op = "update".to_string();
        let r = run(&rows, &["a", "b", "c"], None);
        assert_eq!(r.status, IntegrityStatus::Broken);
        assert_eq!(
            r.chain_break,
            Some(ChainBreak {
                seq: 2,
                kind: BreakKind::EditedInPlace
            })
        );
        assert_eq!(
            r.entries_checked, 3,
            "rows after the break are still counted"
        );
        assert!(
            r.next_anchor().is_none(),
            "a broken chain never moves the anchor"
        );
    }

    #[test]
    fn deleted_row_is_a_sequence_gap() {
        let mut rows = chain(&[("store", "a"), ("store", "b"), ("store", "c")]);
        rows.remove(1);
        let r = run(&rows, &["a", "c"], None);
        assert_eq!(r.chain_break.map(|b| b.kind), Some(BreakKind::SequenceGap));
    }

    #[test]
    fn relinked_row_is_a_link_mismatch() {
        let mut rows = chain(&[("store", "a"), ("store", "b")]);
        rows[1].prev_hash = sha256_hex("elsewhere");
        let r = run(&rows, &["a", "b"], None);
        assert_eq!(r.chain_break.map(|b| b.kind), Some(BreakKind::LinkMismatch));
    }

    #[test]
    fn legacy_v1_rows_verify_and_are_counted() {
        let prev = genesis_prev();
        let ts = 1_700_000_000_000;
        let content_hash = sha256_hex("memos-node-content-v1:hello");
        let entry = entry_hash_v1(ts, "store", "a", &content_hash, &prev);
        let rows = vec![TamperRow {
            seq: 1,
            ts,
            op: "store".into(),
            node_id: "a".into(),
            node_hash: content_hash,
            prev_hash: prev,
            entry_hash: entry,
        }];
        let r = run(&rows, &["a"], None);
        assert_eq!(r.status, IntegrityStatus::Verified);
        assert_eq!(r.legacy_entries, 1);
    }

    #[test]
    fn existence_cross_check_flags_resurrected_and_silently_deleted() {
        let rows = chain(&[("store", "a"), ("store", "b"), ("forget", "a")]);
        // `a` was forgotten but is back; `b` vanished with no forget entry;
        // `z` predates the log.
        let r = run(&rows, &["a", "z"], None);
        assert_eq!(r.status, IntegrityStatus::Inconsistent);
        assert_eq!(r.resurrected, 1);
        assert_eq!(r.deleted_without_log, 1);
        assert_eq!(r.unlogged_nodes, 1);
        assert!(r.headline().contains("outside MemOS"));
    }

    #[test]
    fn anchor_detects_a_chain_rewritten_from_genesis() {
        let original = chain(&[("store", "a"), ("store", "b")]);
        let anchor = run(&original, &["a", "b"], None).next_anchor().unwrap();

        // Appending is fine and reports how much is new.
        let grown = chain(&[("store", "a"), ("store", "b"), ("store", "c")]);
        let r = run(&grown, &["a", "b", "c"], Some(anchor.clone()));
        assert_eq!(r.status, IntegrityStatus::Verified);
        assert_eq!(r.anchor, AnchorCheck::Extends { new_entries: 1 });

        // A different but internally valid history is caught by the anchor.
        let rewritten = chain(&[("store", "x"), ("store", "y")]);
        let r = run(&rewritten, &["x", "y"], Some(anchor.clone()));
        assert_eq!(r.chain_break, None);
        assert_eq!(r.anchor, AnchorCheck::Diverged);
        assert_eq!(r.status, IntegrityStatus::Broken);
        assert!(r.next_anchor().is_none());

        // Truncation below the anchor is caught too, including to empty.
        let r = run(&original[..1], &["a"], Some(anchor.clone()));
        assert_eq!(r.anchor, AnchorCheck::Diverged);
        let r = run(&[], &["a"], Some(anchor));
        assert_eq!(r.status, IntegrityStatus::Broken);
    }

    #[test]
    fn empty_log_reports_unlogged_nodes() {
        let r = run(&[], &["a", "b"], None);
        assert_eq!(r.status, IntegrityStatus::Empty);
        assert_eq!(r.unlogged_nodes, 2);
    }

    #[test]
    fn anchor_book_round_trips_atomically() {
        let dir = std::env::temp_dir().join(format!("memos-anchor-{}", uuid::Uuid::new_v4()));
        let path = dir.join("integrity-anchors.json");
        let db = dir.join("store.db");
        let mut book = AnchorBook::default();
        book.set(
            &db,
            IntegrityAnchor {
                seq: 7,
                entry_hash: "h".into(),
                verified_at_ms: 1,
            },
        );
        book.save_to(&path).unwrap();
        let loaded = AnchorBook::load_from(&path);
        assert_eq!(loaded.get(&db).map(|a| a.seq), Some(7));
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp."))
            .collect();
        assert!(leftovers.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
