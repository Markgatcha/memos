use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::core::db::{DbError, HealthRawStats, ReadOnlyStore};
use crate::core::model::{DbOverview, QueryFilter};

pub const STALE_STORE_AGE_DAYS: i64 = 90;
pub const MANY_MEMORIES_THRESHOLD: usize = 1_000;

/// Discrete store health classifications mapped directly to CLI `health` and Momo states.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StoreHealthStatus {
    Empty,
    Healthy,
    Contradictions,
    Stale,
    Many,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthPanelFilter {
    #[default]
    All,
    Contradictions,
    Stale,
}

impl HealthPanelFilter {
    pub const ALL: [HealthPanelFilter; 3] = [
        HealthPanelFilter::All,
        HealthPanelFilter::Contradictions,
        HealthPanelFilter::Stale,
    ];

    pub fn label(self) -> &'static str {
        match self {
            HealthPanelFilter::All => "All",
            HealthPanelFilter::Contradictions => "Contradictions",
            HealthPanelFilter::Stale => "Stale",
        }
    }
}

impl StoreHealthStatus {
    pub fn default_panel_filter(self) -> HealthPanelFilter {
        match self {
            StoreHealthStatus::Contradictions => HealthPanelFilter::Contradictions,
            StoreHealthStatus::Stale => HealthPanelFilter::Stale,
            StoreHealthStatus::Empty | StoreHealthStatus::Healthy | StoreHealthStatus::Many => {
                HealthPanelFilter::All
            }
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            StoreHealthStatus::Empty => "empty",
            StoreHealthStatus::Healthy => "healthy",
            StoreHealthStatus::Contradictions => "contradictions",
            StoreHealthStatus::Stale => "stale",
            StoreHealthStatus::Many => "many",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            StoreHealthStatus::Empty => "Empty store",
            StoreHealthStatus::Healthy => "Healthy",
            StoreHealthStatus::Contradictions => "Contradictions present",
            StoreHealthStatus::Stale => "Stale or drifted entries",
            StoreHealthStatus::Many => "Large store (1,000+ memories)",
        }
    }
}

/// Read-only store health report containing only aggregate counts, timestamps, and schema status.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoreHealthReport {
    pub db_path: PathBuf,
    pub status: StoreHealthStatus,
    pub score: u8,
    pub node_count: usize,
    pub edge_count: usize,
    pub contradiction_count: usize,
    pub quarantined_count: usize,
    pub expired_count: usize,
    pub stale_count: usize,
    pub drifted_source_count: usize,
    pub low_trust_count: usize,
    pub duplicate_count: usize,
    pub has_fts5: bool,
    pub missing_tables: Vec<String>,
    pub newest_updated_at: Option<i64>,
    pub oldest_created_at: Option<i64>,
    pub notes: Vec<String>,
}

/// Compute a 0..=100 store health score purely from aggregate non-sensitive counters.
pub fn compute_health_score(raw: &HealthRawStats, has_fts5: bool) -> u8 {
    if raw.node_count == 0 {
        return 100;
    }
    let n = raw.node_count.max(1) as i32;
    let mut score = 100_i32;

    if raw.contradiction_count > 0 {
        let penalty = (10 + (raw.contradiction_count as i32) * 5).min(35);
        score -= penalty;
    }
    if raw.expired_count > 0 {
        let pct_penalty = ((raw.expired_count as i32) * 100 / n).clamp(4, 20);
        score -= pct_penalty;
    }
    // A drifted source can also be quarantined. Apply one capped penalty.
    let flagged_count = raw.drifted_source_count.max(raw.quarantined_count);
    if flagged_count > 0 {
        let pct_penalty = ((flagged_count as i32) * 100 / n).clamp(5, 20);
        score -= pct_penalty;
    }
    if raw.stale_count > 0 {
        let pct_penalty = ((raw.stale_count as i32) * 30 / n).clamp(2, 15);
        score -= pct_penalty;
    }
    if raw.duplicate_count > 0 {
        let pct_penalty = ((raw.duplicate_count as i32) * 40 / n).clamp(3, 15);
        score -= pct_penalty;
    }
    if raw.low_trust_count > 0 {
        let pct_penalty = ((raw.low_trust_count as i32) * 40 / n).clamp(3, 15);
        score -= pct_penalty;
    }
    if !has_fts5 {
        score -= 5;
    }

    score.clamp(0, 100) as u8
}

pub fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Derive one of the 5 health states purely from non-sensitive aggregate store metrics.
pub fn classify_store_health(
    raw: &HealthRawStats,
    now_ms: i64,
    stale_age_days: i64,
) -> StoreHealthStatus {
    if raw.node_count == 0 {
        return StoreHealthStatus::Empty;
    }
    if raw.contradiction_count > 0 {
        return StoreHealthStatus::Contradictions;
    }
    let stale_cutoff_ms = now_ms.saturating_sub(stale_age_days * 86_400_000);
    let newest_is_idle = raw
        .newest_updated_at
        .is_some_and(|ts| ts > 0 && ts < stale_cutoff_ms);
    if raw.expired_count > 0 || raw.drifted_source_count > 0 || newest_is_idle {
        return StoreHealthStatus::Stale;
    }
    if raw.node_count >= MANY_MEMORIES_THRESHOLD {
        return StoreHealthStatus::Many;
    }
    StoreHealthStatus::Healthy
}

/// Evaluate complete read-only health diagnostics for an opened store.
pub fn assess_store_health(
    store: &ReadOnlyStore,
    overview: &DbOverview,
    now_ms: i64,
) -> Result<StoreHealthReport, DbError> {
    let stale_cutoff_ms = now_ms.saturating_sub(STALE_STORE_AGE_DAYS * 86_400_000);
    let mut raw = store.load_health_raw_stats(now_ms, stale_cutoff_ms)?;
    // Prefer active contradiction node set count if open contradictions exist even on quirky schemas.
    raw.contradiction_count =
        raw.contradiction_count
            .max(if overview.contradiction_node_ids.is_empty() {
                0
            } else {
                1
            });
    let status = classify_store_health(&raw, now_ms, STALE_STORE_AGE_DAYS);
    let has_fts5 = store.schema().has_table("nodes_fts");

    let mut notes = Vec::new();
    if raw.node_count == 0 {
        notes.push("Store contains 0 memories.".to_string());
    }
    if raw.contradiction_count > 0 {
        notes.push(format!(
            "{} contradiction record(s) require review.",
            raw.contradiction_count
        ));
    }
    if raw.expired_count > 0 {
        notes.push(format!("{} expired memory record(s).", raw.expired_count));
    }
    if raw.drifted_source_count > 0 {
        notes.push(format!(
            "{} record(s) with drifted or stale provenance.",
            raw.drifted_source_count
        ));
    }
    if raw.duplicate_count > 0 {
        notes.push(format!(
            "{} duplicate copy record(s) found.",
            raw.duplicate_count
        ));
    }
    if raw.low_trust_count > 0 {
        notes.push(format!(
            "{} memory record(s) have low trust (< 0.50).",
            raw.low_trust_count
        ));
    }
    if !has_fts5 {
        notes.push("FTS5 table `nodes_fts` absent; falling back to LIKE search.".to_string());
    }
    if notes.is_empty() {
        notes.push("Schema, FTS5 index, and memory freshness look good.".to_string());
    }

    let score = compute_health_score(&raw, has_fts5);

    Ok(StoreHealthReport {
        db_path: store.path().to_path_buf(),
        status,
        score,
        node_count: raw.node_count,
        edge_count: raw.edge_count,
        contradiction_count: raw.contradiction_count,
        quarantined_count: raw.quarantined_count,
        expired_count: raw.expired_count,
        stale_count: raw.stale_count,
        drifted_source_count: raw.drifted_source_count,
        low_trust_count: raw.low_trust_count,
        duplicate_count: raw.duplicate_count,
        has_fts5,
        missing_tables: overview.missing_tables.clone(),
        newest_updated_at: raw.newest_updated_at,
        oldest_created_at: raw.oldest_created_at,
        notes,
    })
}

/// How urgently an issue deserves a look. Wording, not color, carries this.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum IssueSeverity {
    /// Recall can return wrong or outdated answers.
    Attention,
    /// Quality problems worth a pass when convenient.
    Review,
    /// Background facts; nothing is wrong yet.
    Info,
}

impl IssueSeverity {
    pub fn heading(self) -> &'static str {
        match self {
            IssueSeverity::Attention => "Needs attention",
            IssueSeverity::Review => "Worth a review",
            IssueSeverity::Info => "Good to know",
        }
    }
}

/// What the action button on an issue does.
#[derive(Clone, Debug, PartialEq)]
pub enum HealthIssueAction {
    /// Show the matching memories in the list.
    Filter(Box<QueryFilter>),
    OpenReview,
    OpenToday,
    /// No in-app fix; the impact text says what to do.
    None,
}

/// One row of the Store health action center.
#[derive(Clone, Debug, PartialEq)]
pub struct HealthIssue {
    pub id: &'static str,
    pub severity: IssueSeverity,
    pub count: usize,
    pub title: String,
    /// Plain-language consequence and next step.
    pub impact: &'static str,
    pub action_label: &'static str,
    pub action: HealthIssueAction,
    /// Which panel tab the issue belongs to (Momo opens a tab directly).
    pub panel: HealthPanelFilter,
}

fn plural(n: usize, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

/// Turn a health report into ordered, actionable issues (most urgent first).
pub fn health_issues(
    report: &StoreHealthReport,
    pending_review: usize,
    now_ms: i64,
) -> Vec<HealthIssue> {
    let mut out = Vec::new();
    if report.contradiction_count > 0 {
        out.push(HealthIssue {
            id: "contradictions",
            severity: IssueSeverity::Attention,
            count: report.contradiction_count,
            title: plural(report.contradiction_count, "unresolved conflict", "unresolved conflicts"),
            impact: "Agents may recall either side, so answers can flip. Compare each pair from Today and keep the one that holds.",
            action_label: "Compare in Today",
            action: HealthIssueAction::OpenToday,
            panel: HealthPanelFilter::Contradictions,
        });
    }
    if report.expired_count > 0 {
        out.push(HealthIssue {
            id: "expired",
            severity: IssueSeverity::Attention,
            count: report.expired_count,
            title: plural(report.expired_count, "memory past its expiry", "memories past their expiry"),
            impact: "They are still in the store and can still be recalled. Forget or refresh them.",
            action_label: "Show",
            action: HealthIssueAction::Filter(Box::new(QueryFilter {
                expiring_window_ms: Some((1, now_ms)),
                ..Default::default()
            })),
            panel: HealthPanelFilter::Stale,
        });
    }
    if pending_review > 0 {
        out.push(HealthIssue {
            id: "pending-review",
            severity: IssueSeverity::Review,
            count: pending_review,
            title: plural(
                pending_review,
                "memory awaiting approval",
                "memories awaiting approval",
            ),
            impact: "Open the review queue to approve or reject pending memories.",
            action_label: "Open Review",
            action: HealthIssueAction::OpenReview,
            panel: HealthPanelFilter::Contradictions,
        });
    }
    if report.quarantined_count > 0 {
        let n = report.quarantined_count;
        out.push(HealthIssue {
            id: "quarantined",
            severity: IssueSeverity::Review,
            count: n,
            title: plural(n, "quarantined memory", "quarantined memories"),
            impact: "Quarantine holds these memories back from recall.",
            action_label: "Show",
            action: HealthIssueAction::Filter(Box::new(QueryFilter {
                quarantined_only: true,
                ..Default::default()
            })),
            panel: HealthPanelFilter::Contradictions,
        });
    }
    if report.duplicate_count > 0 {
        out.push(HealthIssue {
            id: "duplicates",
            severity: IssueSeverity::Review,
            count: report.duplicate_count,
            title: plural(report.duplicate_count, "exact duplicate", "exact duplicates"),
            impact: "Copies crowd other memories out of recall results. Keep one and forget the rest.",
            action_label: "Show",
            action: HealthIssueAction::Filter(Box::new(QueryFilter {
                duplicates_only: true,
                ..Default::default()
            })),
            panel: HealthPanelFilter::All,
        });
    }
    if report.low_trust_count > 0 {
        out.push(HealthIssue {
            id: "low-trust",
            severity: IssueSeverity::Review,
            count: report.low_trust_count,
            title: plural(report.low_trust_count, "low-trust memory", "low-trust memories"),
            impact: "Written on weak evidence (trust under 50%). Recall ranks them lower but still returns them.",
            action_label: "Show",
            action: HealthIssueAction::Filter(Box::new(QueryFilter {
                max_trust: Some(0.5),
                ..Default::default()
            })),
            panel: HealthPanelFilter::Stale,
        });
    }
    if report.drifted_source_count > 0 {
        out.push(HealthIssue {
            id: "drifted",
            severity: IssueSeverity::Review,
            count: report.drifted_source_count,
            title: plural(report.drifted_source_count, "memory with stale provenance", "memories with stale provenance"),
            impact: "Their provenance indicates possible drift. Check the source before refreshing them.",
            action_label: "",
            action: HealthIssueAction::None,
            panel: HealthPanelFilter::Stale,
        });
    }
    if report.stale_count > 0 {
        out.push(HealthIssue {
            id: "stale",
            severity: IssueSeverity::Info,
            count: report.stale_count,
            title: plural(
                report.stale_count,
                "memory untouched for 90 days",
                "memories untouched for 90 days",
            ),
            impact: "Old is not wrong, but facts drift. Skim them and forget what no longer holds.",
            action_label: "Show",
            action: HealthIssueAction::Filter(Box::new(QueryFilter {
                updated_before_ms: Some(
                    now_ms.saturating_sub(STALE_STORE_AGE_DAYS.saturating_mul(86_400_000)),
                ),
                ..Default::default()
            })),
            panel: HealthPanelFilter::Stale,
        });
    }
    if !report.has_fts5 && report.node_count > 0 {
        out.push(HealthIssue {
            id: "fts",
            severity: IssueSeverity::Info,
            count: 0,
            title: "No full-text index".to_string(),
            impact: "Search falls back to slower substring matching. Opening the store once with the MemOS CLI rebuilds it.",
            action_label: "",
            action: HealthIssueAction::None,
            panel: HealthPanelFilter::All,
        });
    }
    out.sort_by_key(|i| i.severity);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_issues_order_by_severity_and_link_to_filters() {
        let now = 1_800_000_000_000_i64;
        let report = StoreHealthReport {
            db_path: PathBuf::from("x.db"),
            status: StoreHealthStatus::Contradictions,
            score: 60,
            node_count: 100,
            edge_count: 10,
            contradiction_count: 2,
            quarantined_count: 0,
            expired_count: 0,
            stale_count: 5,
            drifted_source_count: 0,
            low_trust_count: 1,
            duplicate_count: 3,
            has_fts5: true,
            missing_tables: Vec::new(),
            newest_updated_at: None,
            oldest_created_at: None,
            notes: Vec::new(),
        };
        let issues = health_issues(&report, 4, now);
        let ids: Vec<&str> = issues.iter().map(|i| i.id).collect();
        assert_eq!(
            ids,
            vec![
                "contradictions",
                "pending-review",
                "duplicates",
                "low-trust",
                "stale"
            ]
        );
        assert_eq!(issues[0].title, "2 unresolved conflicts");
        assert_eq!(issues[0].action, HealthIssueAction::OpenToday);
        assert_eq!(issues[1].action, HealthIssueAction::OpenReview);
        let mixed = StoreHealthReport {
            quarantined_count: 2,
            ..report.clone()
        };
        let actions = health_issues(&mixed, 1, now);
        let quarantine = actions
            .iter()
            .find(|issue| issue.id == "quarantined")
            .unwrap();
        assert_eq!(quarantine.count, 2);
        assert!(
            matches!(&quarantine.action, HealthIssueAction::Filter(filter) if filter.quarantined_only)
        );
        assert_eq!(issues[3].title, "1 low-trust memory");
        match &issues[4].action {
            HealthIssueAction::Filter(f) => assert!(f.updated_before_ms.is_some()),
            other => panic!("unexpected {other:?}"),
        }

        let clean = StoreHealthReport {
            contradiction_count: 0,
            stale_count: 0,
            low_trust_count: 0,
            duplicate_count: 0,
            ..report
        };
        assert!(health_issues(&clean, 0, now).is_empty());
    }

    #[test]
    fn classifies_all_five_health_states() {
        let now = 1_800_000_000_000_i64;
        let fresh_ts = now - 86_400_000;
        let old_ts = now - (STALE_STORE_AGE_DAYS + 5) * 86_400_000;

        let empty = HealthRawStats::default();
        assert_eq!(
            classify_store_health(&empty, now, STALE_STORE_AGE_DAYS),
            StoreHealthStatus::Empty
        );

        let healthy = HealthRawStats {
            node_count: 12,
            newest_updated_at: Some(fresh_ts),
            ..Default::default()
        };
        assert_eq!(
            classify_store_health(&healthy, now, STALE_STORE_AGE_DAYS),
            StoreHealthStatus::Healthy
        );

        let contradictions = HealthRawStats {
            node_count: 1_500,
            contradiction_count: 2,
            newest_updated_at: Some(fresh_ts),
            ..Default::default()
        };
        assert_eq!(
            classify_store_health(&contradictions, now, STALE_STORE_AGE_DAYS),
            StoreHealthStatus::Contradictions
        );

        let stale_drifted = HealthRawStats {
            node_count: 20,
            drifted_source_count: 1,
            newest_updated_at: Some(fresh_ts),
            ..Default::default()
        };
        assert_eq!(
            classify_store_health(&stale_drifted, now, STALE_STORE_AGE_DAYS),
            StoreHealthStatus::Stale
        );

        let stale_idle = HealthRawStats {
            node_count: 20,
            newest_updated_at: Some(old_ts),
            ..Default::default()
        };
        assert_eq!(
            classify_store_health(&stale_idle, now, STALE_STORE_AGE_DAYS),
            StoreHealthStatus::Stale
        );

        let many = HealthRawStats {
            node_count: 1_000,
            newest_updated_at: Some(fresh_ts),
            ..Default::default()
        };
        assert_eq!(
            classify_store_health(&many, now, STALE_STORE_AGE_DAYS),
            StoreHealthStatus::Many
        );

        assert_eq!(compute_health_score(&healthy, true), 100);
        let quarantined = HealthRawStats {
            quarantined_count: 1,
            ..healthy
        };
        assert!(compute_health_score(&quarantined, true) < 100);
        let degraded = HealthRawStats {
            node_count: 100,
            contradiction_count: 3,
            expired_count: 10,
            drifted_source_count: 5,
            duplicate_count: 8,
            low_trust_count: 6,
            ..Default::default()
        };
        let score = compute_health_score(&degraded, false);
        assert!(
            score < 65,
            "degraded store score should drop materially, got {score}"
        );
    }
}
