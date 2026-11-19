use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::core::db::{DbError, HealthRawStats, ReadOnlyStore};
use crate::core::model::DbOverview;

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
    if raw.drifted_source_count > 0 {
        let pct_penalty = ((raw.drifted_source_count as i32) * 100 / n).clamp(5, 20);
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
            "{} quarantined or drifted source record(s).",
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

#[cfg(test)]
mod tests {
    use super::*;

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
