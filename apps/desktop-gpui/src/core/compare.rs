//! Side-by-side comparison of two memories (usually a contradiction pair).
//!
//! Pure helpers so the comparison wording is tested and the dialog only lays
//! out rows.

use crate::core::model::{MemoryDetail, format_relative_age, normalize_timestamp_ms};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
}

/// One aligned fact row in the comparison.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompareRow {
    pub label: &'static str,
    pub left: String,
    pub right: String,
    /// Values differ; the dialog marks the row so differences are found fast.
    pub differs: bool,
}

fn row(label: &'static str, left: String, right: String) -> CompareRow {
    let differs = left != right;
    CompareRow {
        label,
        left,
        right,
        differs,
    }
}

fn or_dash(s: &str) -> String {
    let t = s.trim();
    if t.is_empty() {
        "—".to_string()
    } else {
        t.to_string()
    }
}

fn pct(v: f32) -> String {
    format!("{:.0}%", (v.clamp(0.0, 1.0) * 100.0).round())
}

fn age(ts: i64, now_ms: i64) -> String {
    if ts <= 0 {
        "—".to_string()
    } else {
        format!("{} ago", format_relative_age(ts, now_ms))
    }
}

/// Fact rows shown under the two memories' text.
pub fn compare_rows(a: &MemoryDetail, b: &MemoryDetail, now_ms: i64) -> Vec<CompareRow> {
    vec![
        row("Type", or_dash(&a.node_type), or_dash(&b.node_type)),
        row("Namespace", or_dash(&a.namespace), or_dash(&b.namespace)),
        row(
            "Created",
            age(a.created_at, now_ms),
            age(b.created_at, now_ms),
        ),
        row(
            "Updated",
            age(a.updated_at, now_ms),
            age(b.updated_at, now_ms),
        ),
        row("Trust", pct(a.trust_score), pct(b.trust_score)),
        row("Importance", pct(a.importance), pct(b.importance)),
        row("Provenance", or_dash(&a.provenance), or_dash(&b.provenance)),
        row("Source", or_dash(&a.source), or_dash(&b.source)),
        row("Harness", or_dash(&a.harness), or_dash(&b.harness)),
        row(
            "Reads",
            a.access_count.max(0).to_string(),
            b.access_count.max(0).to_string(),
        ),
    ]
}

fn effective_updated(d: &MemoryDetail) -> i64 {
    let ts = if d.updated_at > 0 {
        d.updated_at
    } else {
        d.created_at
    };
    normalize_timestamp_ms(ts)
}

/// Which side was written more recently, if they differ.
pub fn newer_side(a: &MemoryDetail, b: &MemoryDetail) -> Option<Side> {
    let (ta, tb) = (effective_updated(a), effective_updated(b));
    match ta.cmp(&tb) {
        std::cmp::Ordering::Greater => Some(Side::Left),
        std::cmp::Ordering::Less => Some(Side::Right),
        std::cmp::Ordering::Equal => None,
    }
}

/// Which side is trusted more, ignoring differences under five points.
pub fn more_trusted_side(a: &MemoryDetail, b: &MemoryDetail) -> Option<Side> {
    let diff = a.trust_score - b.trust_score;
    if diff >= 0.05 {
        Some(Side::Left)
    } else if diff <= -0.05 {
        Some(Side::Right)
    } else {
        None
    }
}

/// Short, neutral sentence summarising what distinguishes the pair. It never
/// picks a winner; it points at the signals a person would weigh.
pub fn comparison_hint(a: &MemoryDetail, b: &MemoryDetail) -> String {
    let side_name = |s: Side| match s {
        Side::Left => "The left memory",
        Side::Right => "The right memory",
    };
    match (newer_side(a, b), more_trusted_side(a, b)) {
        (Some(n), Some(t)) if n == t => {
            format!("{} is both newer and more trusted.", side_name(n))
        }
        (Some(n), Some(t)) => format!(
            "{} is newer, but {} is more trusted.",
            side_name(n),
            side_name(t).to_ascii_lowercase()
        ),
        (Some(n), None) => format!("{} is newer; trust is about the same.", side_name(n)),
        (None, Some(t)) => format!(
            "{} is more trusted; both were written at the same time.",
            side_name(t)
        ),
        (None, None) => "Same age and similar trust. Check the source and provenance.".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detail(id: &str, updated: i64, trust: f32) -> MemoryDetail {
        MemoryDetail {
            id: id.to_string(),
            short_id: id.to_string(),
            citation_token: format!("[mem:{id}]"),
            content: "x".to_string(),
            summary: String::new(),
            node_type: "fact".to_string(),
            namespace: "auth".to_string(),
            provenance: "user".to_string(),
            source: "user_input".to_string(),
            pool: "event".to_string(),
            harness: "codex".to_string(),
            importance: 0.5,
            trust_score: trust,
            confidence: None,
            evidence_count: None,
            created_at: updated,
            updated_at: updated,
            access_count: 2,
            last_accessed: 0,
            valid_from: None,
            valid_to: None,
            expires_at: None,
            quarantined: false,
            quarantined_at: None,
            quarantine_reason: None,
            tags: Vec::new(),
            entities: Vec::new(),
            metadata_json: "{}".to_string(),
            edges: Vec::new(),
            contradictions: Vec::new(),
            receipts: Vec::new(),
        }
    }

    #[test]
    fn rows_mark_differences_only() {
        let now = 1_800_000_000_000;
        let a = detail("a", now - 3_600_000, 1.0);
        let mut b = detail("b", now - 86_400_000, 0.6);
        b.namespace = "mobile".to_string();
        let rows = compare_rows(&a, &b, now);
        let get = |l: &str| rows.iter().find(|r| r.label == l).unwrap().clone();
        assert!(!get("Type").differs);
        assert!(get("Namespace").differs);
        assert_eq!(get("Updated").left, "1h ago");
        assert_eq!(get("Updated").right, "1d ago");
        assert_eq!(get("Trust").left, "100%");
        assert_eq!(get("Trust").right, "60%");
    }

    #[test]
    fn hint_describes_newer_and_trusted_sides_without_choosing() {
        let now = 1_800_000_000_000;
        let newer_trusted = detail("a", now, 0.9);
        let older_weak = detail("b", now - 10_000, 0.5);
        assert_eq!(newer_side(&newer_trusted, &older_weak), Some(Side::Left));
        assert_eq!(
            comparison_hint(&newer_trusted, &older_weak),
            "The left memory is both newer and more trusted."
        );
        let newer_weak = detail("c", now, 0.5);
        let older_trusted = detail("d", now - 10_000, 0.9);
        assert_eq!(
            comparison_hint(&newer_weak, &older_trusted),
            "The left memory is newer, but the right memory is more trusted."
        );
        let same = detail("e", now, 0.9);
        assert_eq!(
            comparison_hint(&same, &detail("f", now, 0.92)),
            "Same age and similar trust. Check the source and provenance."
        );
    }
}
