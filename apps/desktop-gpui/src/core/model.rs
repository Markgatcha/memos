use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

/// Canonical citation prefix length matching `src/citations.ts`.
pub const CITATION_MIN_HEX: usize = 4;

/// Compute the MemOS short citation id (first 4 hex chars without dashes, lowercase).
pub fn short_citation_id(id: &str) -> String {
    let hex: String = id
        .chars()
        .filter(|c| *c != '-')
        .map(|c| c.to_ascii_lowercase())
        .collect();
    if !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        hex.chars().take(CITATION_MIN_HEX).collect()
    } else {
        id.chars().take(CITATION_MIN_HEX).collect()
    }
}

/// Render `[mem:<shortid>]` citation token matching `src/citations.ts`.
pub fn citation_token(id: &str) -> String {
    format!("[mem:{}]", short_citation_id(id))
}

/// Parse user search input like `[mem:a3f9]` or `mem:a3f9` into a normalized hex prefix.
pub fn parse_citation_prefix(input: &str) -> Option<String> {
    let trimmed = input.trim();
    let body = if let Some(inner) = trimmed
        .strip_prefix("[mem:")
        .and_then(|s| s.strip_suffix(']'))
    {
        inner
    } else {
        trimmed.strip_prefix("mem:")?
    };
    let hex: String = body
        .chars()
        .filter(|c| *c != '-')
        .map(|c| c.to_ascii_lowercase())
        .collect();
    if hex.len() >= 2 && hex.len() <= 32 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(hex)
    } else {
        None
    }
}

/// Active view mode in the main workspace.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ViewMode {
    #[default]
    List,
    Graph,
}

/// List row density option (`64 px` comfortable vs `48 px` compact).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum RowDensity {
    #[default]
    Comfortable,
    Compact,
}

impl RowDensity {
    pub fn row_height_px(self) -> f32 {
        match self {
            RowDensity::Comfortable => 64.0,
            RowDensity::Compact => 48.0,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            RowDensity::Comfortable => "Comfortable",
            RowDensity::Compact => "Compact",
        }
    }
}

/// Sort order for the memory list.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum SortOrder {
    #[default]
    Recency,
    Importance,
    Trust,
}

impl SortOrder {
    pub fn label(self) -> &'static str {
        match self {
            SortOrder::Recency => "Recency",
            SortOrder::Importance => "Importance",
            SortOrder::Trust => "Trust",
        }
    }

    pub fn next(self) -> Self {
        match self {
            SortOrder::Recency => SortOrder::Importance,
            SortOrder::Importance => SortOrder::Trust,
            SortOrder::Trust => SortOrder::Recency,
        }
    }
}

/// Graph visualization modes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum GraphMode {
    #[default]
    Namespace,
    Tag,
    Entity,
    Temporal,
    Contradictions,
}

impl GraphMode {
    pub const ALL: [GraphMode; 5] = [
        GraphMode::Namespace,
        GraphMode::Tag,
        GraphMode::Entity,
        GraphMode::Temporal,
        GraphMode::Contradictions,
    ];

    pub fn label(self) -> &'static str {
        match self {
            GraphMode::Namespace => "Namespace",
            GraphMode::Tag => "Tag",
            GraphMode::Entity => "Entity",
            GraphMode::Temporal => "Temporal",
            GraphMode::Contradictions => "Contradictions",
        }
    }
}

/// Query filters applied to the memory list and graph.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct QueryFilter {
    pub query: String,
    pub namespace: Option<String>,
    pub tag: Option<String>,
    pub node_type: Option<String>,
    pub provenance: Option<String>,
    pub has_contradiction: bool,
    pub min_importance: Option<f32>,
    pub created_after_ms: Option<i64>,
    pub quarantined_only: bool,
    #[serde(default)]
    pub stale_before_ms: Option<i64>,
    #[serde(default)]
    pub max_trust: Option<f32>,
    #[serde(default)]
    pub duplicates_only: bool,
    #[serde(default)]
    pub updated_not_new_after_ms: Option<i64>,
    #[serde(default)]
    pub expiring_window_ms: Option<(i64, i64)>,
    #[serde(default)]
    pub needs_review_only: bool,
    pub sort: SortOrder,
}

impl QueryFilter {
    pub fn is_empty(&self) -> bool {
        self.query.trim().is_empty()
            && self.namespace.is_none()
            && self.tag.is_none()
            && self.node_type.is_none()
            && self.provenance.is_none()
            && !self.has_contradiction
            && self.min_importance.is_none()
            && self.created_after_ms.is_none()
            && !self.quarantined_only
            && self.stale_before_ms.is_none()
            && self.max_trust.is_none()
            && !self.duplicates_only
            && self.updated_not_new_after_ms.is_none()
            && self.expiring_window_ms.is_none()
            && !self.needs_review_only
    }
}

/// Lightweight list row kept in memory so 50k+ nodes stay well under the RSS budget.
#[derive(Clone, Debug)]
pub struct MemoryListItem {
    pub id: String,
    pub short_id: Arc<str>,
    pub preview: Arc<str>,
    pub node_type: Arc<str>,
    pub namespace: Arc<str>,
    pub provenance: Arc<str>,
    pub source: Arc<str>,
    pub harness: Arc<str>,
    pub tags: Vec<Arc<str>>,
    pub importance: f32,
    pub trust_score: f32,
    pub created_at: i64,
    pub updated_at: i64,
    pub has_contradiction: bool,
    pub quarantined: bool,
}

/// Linked graph edge shown in the detail pane.
#[derive(Clone, Debug)]
pub struct LinkedEdge {
    pub id: String,
    pub direction: EdgeDirection,
    pub relation: String,
    pub weight: f32,
    pub peer_id: String,
    pub peer_short_id: String,
    pub peer_preview: String,
    pub peer_type: String,
    pub created_at: i64,
    pub valid_from: Option<i64>,
    pub valid_to: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EdgeDirection {
    Outgoing,
    Incoming,
}

/// Linked contradiction record shown in the detail pane.
#[derive(Clone, Debug)]
pub struct LinkedContradiction {
    pub id: String,
    pub status: String,
    pub detected_at: i64,
    pub peer_id: String,
    pub peer_short_id: String,
    pub peer_preview: String,
}

/// Unresolved contradiction pair surfaced in the Today / Brief view.
#[derive(Clone, Debug)]
pub struct BriefContradictionPair {
    pub id: String,
    pub node_a_id: String,
    pub node_a_short_id: String,
    pub node_a_preview: String,
    pub node_b_id: String,
    pub node_b_short_id: String,
    pub node_b_preview: String,
    pub status: String,
    pub detected_at: i64,
}

/// Pure SQLite read-only snapshot for the Today / Brief view (last 24h & upcoming expirations).
#[derive(Clone, Debug, Default)]
pub struct BriefSnapshot {
    pub now_ms: i64,
    pub new_items: Vec<MemoryListItem>,
    pub new_count: usize,
    pub changed_items: Vec<MemoryListItem>,
    pub changed_count: usize,
    pub expiring_items: Vec<MemoryListItem>,
    pub expiring_count: usize,
    pub contradiction_pairs: Vec<BriefContradictionPair>,
    pub contradiction_count: usize,
    pub needs_review_items: Vec<MemoryListItem>,
    pub needs_review_count: usize,
    /// Distinct nodes across the four node sections plus unresolved
    /// contradiction pairs. Sections can overlap; this does not.
    pub unique_count: usize,
}

impl BriefSnapshot {
    pub fn total_count(&self) -> usize {
        self.unique_count
    }

    pub fn is_empty(&self) -> bool {
        self.new_items.is_empty()
            && self.changed_items.is_empty()
            && self.expiring_items.is_empty()
            && self.contradiction_pairs.is_empty()
            && self.needs_review_items.is_empty()
    }
}

/// Hash-chained tamper-log receipt entry for a memory node.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TamperReceipt {
    pub seq: i64,
    pub ts: i64,
    pub op: String,
    pub node_hash: String,
    pub entry_hash: String,
}

/// Full memory details loaded on demand for the selected node.
#[derive(Clone, Debug)]
pub struct MemoryDetail {
    pub id: String,
    pub short_id: String,
    pub citation_token: String,
    pub content: String,
    pub summary: String,
    pub node_type: String,
    pub namespace: String,
    pub provenance: String,
    pub source: String,
    pub pool: String,
    pub harness: String,
    pub importance: f32,
    pub trust_score: f32,
    pub confidence: Option<f32>,
    pub evidence_count: Option<u64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub access_count: i64,
    pub last_accessed: i64,
    pub valid_from: Option<i64>,
    pub valid_to: Option<i64>,
    pub expires_at: Option<i64>,
    pub quarantined: bool,
    pub quarantined_at: Option<i64>,
    pub quarantine_reason: Option<String>,
    pub tags: Vec<String>,
    pub entities: Vec<String>,
    pub metadata_json: String,
    pub edges: Vec<LinkedEdge>,
    pub contradictions: Vec<LinkedContradiction>,
    pub receipts: Vec<TamperReceipt>,
}

/// Counted facet item for the sidebar (namespace, tag, type, provenance).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FacetCount {
    pub name: String,
    pub count: usize,
}

/// Known tables checked via runtime introspection.
pub const KNOWN_TABLES: &[&str] = &[
    "nodes",
    "edges",
    "node_tags",
    "embeddings",
    "contradictions",
    "procedural_lessons",
    "recall_traces",
    "tamper_log",
    "nodes_fts",
    "entity_index",
];

/// Introspected table metadata (count + column names only, never row content).
#[derive(Clone, Debug)]
pub struct TableSummary {
    pub name: String,
    pub present: bool,
    pub row_count: usize,
    pub columns: HashSet<String>,
}

/// Result of checking whether a store matches the schema columns written by the MemOS SDK.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WriterSchemaPreflight {
    pub compatible: bool,
    pub missing: Vec<String>,
}

impl WriterSchemaPreflight {
    /// Human-readable banner/card message when the store predates the writer schema.
    pub fn human_message(&self) -> Option<String> {
        let first = self.missing.first()?;
        Some(format!(
            "This store predates the writer schema (missing {first}). Run `memos init`/migrate or open a migrated database."
        ))
    }
}

/// Aggregate read-only database overview for status bar, sidebar, and diagnostics.
#[derive(Clone, Debug)]
pub struct DbOverview {
    pub db_path: PathBuf,
    pub node_count: usize,
    pub edge_count: usize,
    pub contradiction_count: usize,
    pub lesson_count: usize,
    pub trace_count: usize,
    pub tamper_count: usize,
    pub embedding_count: usize,
    pub newest_updated_at: Option<i64>,
    pub writer_preflight: WriterSchemaPreflight,
    pub namespaces: Vec<FacetCount>,
    pub tags: Vec<FacetCount>,
    pub types: Vec<FacetCount>,
    pub provenances: Vec<FacetCount>,
    pub tables: Vec<TableSummary>,
    pub missing_tables: Vec<String>,
    pub contradiction_node_ids: HashSet<String>,
}

impl DbOverview {
    /// Minimal overview for the first paint: totals and contradiction ids
    /// only. Facets, table counts and preflight arrive with the full overview.
    pub fn fast(
        db_path: PathBuf,
        node_count: usize,
        contradiction_node_ids: HashSet<String>,
    ) -> Self {
        Self {
            db_path,
            node_count,
            edge_count: 0,
            contradiction_count: 0,
            lesson_count: 0,
            trace_count: 0,
            tamper_count: 0,
            embedding_count: 0,
            newest_updated_at: None,
            writer_preflight: WriterSchemaPreflight::default(),
            namespaces: Vec::new(),
            tags: Vec::new(),
            types: Vec::new(),
            provenances: Vec::new(),
            tables: Vec::new(),
            missing_tables: Vec::new(),
            contradiction_node_ids,
        }
    }
}

/// Raw node rendered in the graph canvas (either a real memory or an aggregated cluster).
#[derive(Clone, Debug)]
pub struct GraphNodeData {
    pub key: String,
    pub memory_id: Option<String>,
    pub label: String,
    pub group: String,
    pub node_type: String,
    pub importance: f32,
    pub created_at: i64,
    pub cluster_count: usize,
    pub has_contradiction: bool,
}

/// Edge connecting two graph nodes (or cluster hubs).
#[derive(Clone, Debug)]
pub struct GraphEdgeData {
    pub source_idx: usize,
    pub target_idx: usize,
    pub relation: String,
    pub weight: f32,
    pub is_contradiction: bool,
}

/// Graph snapshot returned from the background DB worker for layout and rendering.
#[derive(Clone, Debug)]
pub struct GraphSnapshot {
    pub mode: GraphMode,
    pub nodes: Vec<GraphNodeData>,
    pub edges: Vec<GraphEdgeData>,
    pub total_matching_nodes: usize,
    pub clustered_nodes: usize,
}

/// Kind of memory lifecycle or consolidation event displayed in Dream Diff.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DreamDiffKind {
    Promoted,
    Merged,
    Decayed,
    Contradiction,
    Updated,
}

impl DreamDiffKind {
    pub const ALL: [DreamDiffKind; 5] = [
        Self::Promoted,
        Self::Merged,
        Self::Decayed,
        Self::Contradiction,
        Self::Updated,
    ];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Promoted => "Promoted",
            Self::Merged => "Merged",
            Self::Decayed => "Decayed",
            Self::Contradiction => "Contradiction",
            Self::Updated => "Updated",
        }
    }
}

/// Chronological consolidation / memory evolution event shown in Dream Diff.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DreamDiffEntry {
    pub timestamp: i64,
    pub kind: DreamDiffKind,
    pub node_id: String,
    pub short_id: String,
    pub summary: String,
    pub detail: String,
}

/// Format Unix ms (or seconds if small) into compact UTC ISO-like string without panicking.
pub fn format_timestamp_ms(ts: i64) -> String {
    if ts <= 0 {
        return "—".to_string();
    }
    let ms = normalize_timestamp_ms(ts);
    let secs = ms.div_euclid(1000);
    if let Ok(dt) = time::OffsetDateTime::from_unix_timestamp(secs) {
        let format =
            time::macros::format_description!("[year]-[month]-[day] [hour]:[minute]:[second] UTC");
        dt.format(&format).unwrap_or_else(|_| ts.to_string())
    } else {
        ts.to_string()
    }
}

/// Normalize second-precision timestamps (such as `expires_at`) into Unix milliseconds.
pub fn normalize_timestamp_ms(ts: i64) -> i64 {
    if ts > 0 && ts < 10_000_000_000 {
        ts * 1000
    } else {
        ts
    }
}

fn format_duration_units(diff_secs: i64) -> String {
    if diff_secs < 60 {
        format!("{diff_secs}s")
    } else if diff_secs < 3600 {
        format!("{}m", diff_secs / 60)
    } else if diff_secs < 86_400 {
        format!("{}h", diff_secs / 3600)
    } else if diff_secs < 86_400 * 30 {
        format!("{}d", diff_secs / 86_400)
    } else {
        format!("{}mo", diff_secs / (86_400 * 30))
    }
}

/// Format a compact relative age string for list rows.
pub fn format_relative_age(ts_ms: i64, now_ms: i64) -> String {
    if ts_ms <= 0 {
        return "—".to_string();
    }
    let ms = normalize_timestamp_ms(ts_ms);
    let diff_secs = (now_ms - ms).max(0) / 1000;
    format_duration_units(diff_secs)
}

/// Format a past or future timestamp relative to `now_ms`, paired with its absolute UTC timestamp.
pub fn format_time_relative_and_absolute(ts: i64, now_ms: i64) -> String {
    if ts <= 0 {
        return "—".to_string();
    }
    let ms = normalize_timestamp_ms(ts);
    let rel = if ms > now_ms {
        format!("in {}", format_duration_units((ms - now_ms) / 1000))
    } else {
        format!("{} ago", format_duration_units((now_ms - ms) / 1000))
    };
    format!("{rel} · {}", format_timestamp_ms(ms))
}

/// Format `last_accessed` for detail/CLI surfaces (`"Never recalled"` when `0`).
pub fn format_last_read(last_accessed: i64, now_ms: i64) -> String {
    if last_accessed <= 0 {
        return "Never recalled".to_string();
    }
    format_time_relative_and_absolute(last_accessed, now_ms)
}

/// Collapse internal newlines/runs of whitespace into a single-line preview capped at `max_chars`.
pub fn make_single_line_preview(text: &str, max_chars: usize) -> String {
    let mut out = String::with_capacity(text.len().min(max_chars + 4));
    let mut prev_space = true;
    let mut count = 0usize;
    for ch in text.chars() {
        if ch.is_whitespace() {
            if !prev_space {
                if count >= max_chars {
                    out.push('…');
                    break;
                }
                out.push(' ');
                count += 1;
                prev_space = true;
            }
        } else {
            if count >= max_chars {
                out.push('…');
                break;
            }
            out.push(ch);
            count += 1;
            prev_space = false;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    if out.is_empty() {
        "(empty)".to_string()
    } else {
        out
    }
}

pub const CONTEXT_PREVIEW_VIEW_LIMIT: usize = 12;

/// Full-text fields of a single memory formatted for the read-only AI context preview modal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContextPreviewItem {
    pub id: String,
    pub short_id: String,
    pub node_type: String,
    pub namespace: String,
    pub content: String,
    pub summary: String,
    pub tags: Vec<String>,
    /// Last update (or creation) time in the store's native unit; `0` if unknown.
    pub updated_at: i64,
    /// Creation time in the store's native unit; `0` if unknown.
    pub created_at: i64,
    /// Provenance tier (`user`, `verified`, `agent-inferred`, …); empty if unknown.
    pub provenance: String,
}

/// Formatted agent context payload plus char/token estimates.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AiContextPreview {
    pub subtitle: String,
    pub payload: String,
    pub shown_count: usize,
    pub total_count: usize,
    pub char_count: usize,
    pub estimated_tokens: usize,
}

/// Format selected memory or active view memories into a read-only agent context block.
pub fn format_ai_context_payload(
    items: &[ContextPreviewItem],
    total_matching: usize,
    subtitle: impl Into<String>,
) -> AiContextPreview {
    let shown_count = items.len();
    let noun = if shown_count == 1 { "item" } else { "items" };
    let mut payload = format!("# MemOS memory context ({shown_count} {noun})");
    for item in items {
        let content = item.content.trim();
        let summary = item.summary.trim();
        payload.push_str("\n\n[mem:");
        payload.push_str(&item.short_id);
        payload.push_str("] ");
        payload.push_str(&item.node_type);
        payload.push_str(" · ");
        payload.push_str(&item.namespace);
        payload.push('\n');
        payload.push_str(if content.is_empty() { summary } else { content });
        if !summary.is_empty() && !content.is_empty() && summary != content {
            payload.push_str("\nSummary: ");
            payload.push_str(summary);
        }
    }
    let char_count = payload.chars().count();
    let estimated_tokens = if char_count == 0 {
        0
    } else {
        char_count.div_ceil(4)
    };
    AiContextPreview {
        subtitle: subtitle.into(),
        payload,
        shown_count,
        total_count: total_matching.max(shown_count),
        char_count,
        estimated_tokens,
    }
}

/// Filter keys parsed from search-box scope prefixes (`type:`, `tag:`, `ns:`, etc.).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SearchScopeKind {
    NodeType,
    Tag,
    Namespace,
    Provenance,
    HasContradiction,
    IsStale,
    AfterDate,
    MaxTrust,
    IsQuarantined,
}

/// Active search scope chip displayed beneath the search box.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchScopeChip {
    pub kind: SearchScopeKind,
    pub label: String,
}

/// Result of extracting scope tokens from raw search-box text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtractedSearchTokens {
    pub extracted: Vec<(SearchScopeKind, String)>,
    pub remaining_input: String,
    pub applied_any: bool,
}

fn parse_scope_token(
    raw_token: &str,
    now_ms: i64,
    out: &mut QueryFilter,
) -> Option<SearchScopeKind> {
    let trimmed = raw_token.trim();
    if trimmed.is_empty() {
        return None;
    }
    let (key, val) = trimmed.split_once(':')?;
    match key.to_ascii_lowercase().as_str() {
        "type" => {
            let v = val.trim().to_ascii_lowercase();
            if v.is_empty() {
                return None;
            }
            out.node_type = Some(v);
            Some(SearchScopeKind::NodeType)
        }
        "tag" => {
            let v = val.trim().trim_start_matches('#');
            if v.is_empty() {
                return None;
            }
            out.tag = Some(v.to_string());
            Some(SearchScopeKind::Tag)
        }
        "ns" | "namespace" => {
            let v = val.trim();
            if v.is_empty() {
                return None;
            }
            out.namespace = Some(v.to_string());
            Some(SearchScopeKind::Namespace)
        }
        "provenance" => {
            let v = val.trim().to_ascii_lowercase();
            if v.is_empty() {
                return None;
            }
            out.provenance = Some(v);
            Some(SearchScopeKind::Provenance)
        }
        "has" if val.trim().eq_ignore_ascii_case("contradiction") => {
            out.has_contradiction = true;
            Some(SearchScopeKind::HasContradiction)
        }
        "is" if val.trim().eq_ignore_ascii_case("stale") => {
            let stale_ms = crate::core::health::STALE_STORE_AGE_DAYS.saturating_mul(86_400_000);
            out.stale_before_ms = Some(now_ms.saturating_sub(stale_ms));
            Some(SearchScopeKind::IsStale)
        }
        "is" if val.trim().eq_ignore_ascii_case("quarantined") => {
            out.quarantined_only = true;
            Some(SearchScopeKind::IsQuarantined)
        }
        "after" => {
            let date_str = val.trim();
            if date_str.len() != 10 {
                return None;
            }
            let bytes = date_str.as_bytes();
            if bytes[4] != b'-' || bytes[7] != b'-' {
                return None;
            }
            let year: i32 = date_str[0..4].parse().ok()?;
            let month_num: u8 = date_str[5..7].parse().ok()?;
            let day: u8 = date_str[8..10].parse().ok()?;
            let month = time::Month::try_from(month_num).ok()?;
            let date = time::Date::from_calendar_date(year, month, day).ok()?;
            let ms = date
                .midnight()
                .assume_utc()
                .unix_timestamp()
                .saturating_mul(1000);
            out.created_after_ms = Some(ms);
            Some(SearchScopeKind::AfterDate)
        }
        "trust" => {
            let num_str = val.trim().strip_prefix('<')?;
            if num_str.is_empty() {
                return None;
            }
            let parsed: f32 = num_str.parse().ok()?;
            if !parsed.is_finite() || !(0.0..=1.0).contains(&parsed) {
                return None;
            }
            out.max_trust = Some(parsed);
            Some(SearchScopeKind::MaxTrust)
        }
        _ => None,
    }
}

/// Extract valid search scope tokens from `raw` into `filter`.
///
/// When `extract_final_token` is `false` (live typing without trailing whitespace),
/// the final whitespace-delimited token is left inside `remaining_input` so partially
/// typed scopes like `type:dec` or plain words are not stripped mid-word; when trailing
/// whitespace is present or `extract_final_token` is `true` (Enter/Submit), every
/// valid scope token is promoted into structured `filter` fields.
pub fn extract_search_scopes(
    raw: &str,
    filter: &mut QueryFilter,
    now_ms: i64,
    extract_final_token: bool,
) -> ExtractedSearchTokens {
    let has_trailing_ws = raw.chars().last().is_some_and(char::is_whitespace);
    let words: Vec<&str> = raw.split_whitespace().collect();
    if words.is_empty() {
        return ExtractedSearchTokens {
            extracted: Vec::new(),
            remaining_input: raw.to_string(),
            applied_any: false,
        };
    }

    let extract_limit = if extract_final_token || has_trailing_ws {
        words.len()
    } else {
        words.len().saturating_sub(1)
    };

    let mut extracted = Vec::new();
    let mut kept = Vec::with_capacity(words.len());
    for (ix, word) in words.iter().enumerate() {
        if ix < extract_limit
            && let Some(kind) = parse_scope_token(word, now_ms, filter)
        {
            extracted.push((kind, (*word).to_string()));
        } else {
            kept.push(*word);
        }
    }

    let applied_any = !extracted.is_empty();
    let mut remaining_input = kept.join(" ");
    if has_trailing_ws && !remaining_input.is_empty() {
        remaining_input.push(' ');
    }
    ExtractedSearchTokens {
        extracted,
        remaining_input,
        applied_any,
    }
}

fn format_trust_threshold(value: f32) -> String {
    let s = format!("{value:.2}");
    let trimmed = s.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Materialize active removable chips representing `filter`'s structured scopes.
pub fn scopes_from_filter(filter: &QueryFilter) -> Vec<SearchScopeChip> {
    let mut chips = Vec::new();
    if let Some(nt) = filter.node_type.as_deref().filter(|s| !s.is_empty()) {
        chips.push(SearchScopeChip {
            kind: SearchScopeKind::NodeType,
            label: format!("type:{nt}"),
        });
    }
    if let Some(tag) = filter.tag.as_deref().filter(|s| !s.is_empty()) {
        chips.push(SearchScopeChip {
            kind: SearchScopeKind::Tag,
            label: format!("tag:{}", tag.trim_start_matches('#')),
        });
    }
    if let Some(ns) = filter.namespace.as_deref().filter(|s| !s.is_empty()) {
        chips.push(SearchScopeChip {
            kind: SearchScopeKind::Namespace,
            label: format!("ns:{ns}"),
        });
    }
    if let Some(prov) = filter.provenance.as_deref().filter(|s| !s.is_empty()) {
        chips.push(SearchScopeChip {
            kind: SearchScopeKind::Provenance,
            label: format!("provenance:{prov}"),
        });
    }
    if filter.has_contradiction {
        chips.push(SearchScopeChip {
            kind: SearchScopeKind::HasContradiction,
            label: "has:contradiction".to_string(),
        });
    }
    if filter.stale_before_ms.is_some() {
        chips.push(SearchScopeChip {
            kind: SearchScopeKind::IsStale,
            label: "is:stale".to_string(),
        });
    }
    if let Some(after_ms) = filter.created_after_ms
        && after_ms > 0
        && after_ms.rem_euclid(86_400_000) == 0
        && let Ok(dt) = time::OffsetDateTime::from_unix_timestamp(after_ms.div_euclid(1000))
    {
        chips.push(SearchScopeChip {
            kind: SearchScopeKind::AfterDate,
            label: format!(
                "after:{:04}-{:02}-{:02}",
                dt.year(),
                u8::from(dt.month()),
                dt.day()
            ),
        });
    }
    if let Some(max_trust) = filter.max_trust {
        chips.push(SearchScopeChip {
            kind: SearchScopeKind::MaxTrust,
            label: format!("trust:<{}", format_trust_threshold(max_trust)),
        });
    }
    if filter.quarantined_only {
        chips.push(SearchScopeChip {
            kind: SearchScopeKind::IsQuarantined,
            label: "is:quarantined".to_string(),
        });
    }
    chips
}

/// Remove a specific search scope field from `filter`, returning `true` if `filter` changed.
pub fn remove_search_scope(filter: &mut QueryFilter, kind: SearchScopeKind) -> bool {
    match kind {
        SearchScopeKind::NodeType => filter.node_type.take().is_some(),
        SearchScopeKind::Tag => filter.tag.take().is_some(),
        SearchScopeKind::Namespace => filter.namespace.take().is_some(),
        SearchScopeKind::Provenance => filter.provenance.take().is_some(),
        SearchScopeKind::HasContradiction => {
            std::mem::replace(&mut filter.has_contradiction, false)
        }
        SearchScopeKind::IsStale => filter.stale_before_ms.take().is_some(),
        SearchScopeKind::AfterDate => filter.created_after_ms.take().is_some(),
        SearchScopeKind::MaxTrust => filter.max_trust.take().is_some(),
        SearchScopeKind::IsQuarantined => std::mem::replace(&mut filter.quarantined_only, false),
    }
}

/// Remove the rightmost active scope chip (`Backspace` on empty search input).
pub fn remove_last_search_scope(filter: &mut QueryFilter) -> Option<SearchScopeKind> {
    let last = scopes_from_filter(filter).last()?.kind;
    if remove_search_scope(filter, last) {
        Some(last)
    } else {
        None
    }
}

/// Concise human-readable description of the active list/graph filter for modal subtitles.
pub fn describe_filter_target(filter: &QueryFilter) -> String {
    let mut parts: Vec<String> = Vec::new();
    let q = filter.query.trim();
    if !q.is_empty() {
        parts.push(format!("\"{q}\""));
    }
    if let Some(tag) = filter.tag.as_deref().filter(|s| !s.is_empty()) {
        parts.push(format!("#{}", tag.trim_start_matches('#')));
    }
    if let Some(ns) = filter.namespace.as_deref().filter(|s| !s.is_empty()) {
        parts.push(ns.to_string());
    }
    if let Some(ty) = filter.node_type.as_deref().filter(|s| !s.is_empty()) {
        parts.push(ty.to_string());
    }
    if let Some(prov) = filter.provenance.as_deref().filter(|s| !s.is_empty()) {
        parts.push(prov.to_string());
    }
    if filter.has_contradiction {
        parts.push("contradictions".to_string());
    }
    if filter.min_importance.is_some() {
        parts.push("important".to_string());
    }
    if filter.created_after_ms.is_some() {
        parts.push("recent".to_string());
    }
    if parts.is_empty() {
        format!("Current view · All memories · {}", filter.sort.label())
    } else {
        format!(
            "Current view · {} · {}",
            parts.join(" · "),
            filter.sort.label()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_ai_context_payload_with_summary_when_different_and_token_estimate() {
        let items = vec![
            ContextPreviewItem {
                id: "1234abcd-0000".to_string(),
                short_id: "1234abcd".to_string(),
                node_type: "decision".to_string(),
                namespace: "auth".to_string(),
                content: "Use PKCE for OAuth flows.".to_string(),
                summary: "PKCE OAuth decision".to_string(),
                tags: Vec::new(),
                updated_at: 0,
                created_at: 0,
                provenance: String::new(),
            },
            ContextPreviewItem {
                id: "5678ef90-0000".to_string(),
                short_id: "5678ef90".to_string(),
                node_type: "fact".to_string(),
                namespace: "auth".to_string(),
                content: "Token lifetime is 15 minutes.".to_string(),
                summary: "Token lifetime is 15 minutes.".to_string(),
                tags: Vec::new(),
                updated_at: 0,
                created_at: 0,
                provenance: String::new(),
            },
        ];
        let formatted = format_ai_context_payload(&items, 42, "Current view");
        assert!(
            formatted
                .payload
                .starts_with("# MemOS memory context (2 items)")
        );
        assert!(formatted
            .payload
            .contains("[mem:1234abcd] decision · auth\nUse PKCE for OAuth flows.\nSummary: PKCE OAuth decision"));
        assert!(
            formatted
                .payload
                .contains("[mem:5678ef90] fact · auth\nToken lifetime is 15 minutes.")
        );
        assert!(
            !formatted
                .payload
                .contains("Summary: Token lifetime is 15 minutes.")
        );
        assert_eq!(formatted.shown_count, 2);
        assert_eq!(formatted.total_count, 42);
        assert_eq!(formatted.char_count, formatted.payload.chars().count());
        assert_eq!(formatted.estimated_tokens, formatted.char_count.div_ceil(4));
    }

    #[test]
    fn search_scope_parser_extracts_valid_tokens_preserves_invalid_and_round_trips() {
        let now_ms = 1_793_577_600_000_i64; // 2026-11-02T00:00:00Z
        let mut filter = QueryFilter::default();

        // While typing without trailing whitespace, only preceding tokens promote; partial final token stays.
        let partial = extract_search_scopes("type:decision tag:au", &mut filter, now_ms, false);
        assert!(partial.applied_any);
        assert_eq!(filter.node_type.as_deref(), Some("decision"));
        assert_eq!(filter.tag, None);
        assert_eq!(partial.remaining_input, "tag:au");

        // All 9 documented scopes + free text + invalid tokens with Submit/trailing space extraction.
        let mut full = QueryFilter::default();
        let res = extract_search_scopes(
            "type:decision tag:#auth ns:work provenance:agent-inferred has:contradiction is:stale after:2026-11-01 trust:<0.5 is:quarantined after:bad-date trust:<2.0 oauth ",
            &mut full,
            now_ms,
            false,
        );
        assert!(res.applied_any);
        assert_eq!(res.extracted.len(), 9);
        assert_eq!(res.remaining_input, "after:bad-date trust:<2.0 oauth ");
        assert_eq!(full.node_type.as_deref(), Some("decision"));
        assert_eq!(full.tag.as_deref(), Some("auth"));
        assert_eq!(full.namespace.as_deref(), Some("work"));
        assert_eq!(full.provenance.as_deref(), Some("agent-inferred"));
        assert!(full.has_contradiction);
        assert!(full.stale_before_ms.is_some());
        assert_eq!(full.created_after_ms, Some(1_793_491_200_000)); // 2026-11-01T00:00:00Z
        assert_eq!(full.max_trust, Some(0.5));
        assert!(full.quarantined_only);

        // JSON round-trip (as in SavedView) reproduces identical scope chips.
        let json = serde_json::to_string(&full).expect("serialize QueryFilter");
        let round_tripped: QueryFilter =
            serde_json::from_str(&json).expect("deserialize QueryFilter");
        let chips = scopes_from_filter(&round_tripped);
        let labels: Vec<&str> = chips.iter().map(|c| c.label.as_str()).collect();
        assert_eq!(
            labels,
            vec![
                "type:decision",
                "tag:auth",
                "ns:work",
                "provenance:agent-inferred",
                "has:contradiction",
                "is:stale",
                "after:2026-11-01",
                "trust:<0.5",
                "is:quarantined",
            ]
        );

        // Chip removal and Backspace-on-empty pop in order.
        let mut edited = round_tripped;
        assert!(remove_search_scope(&mut edited, SearchScopeKind::Namespace));
        assert_eq!(edited.namespace, None);
        assert_eq!(
            remove_last_search_scope(&mut edited),
            Some(SearchScopeKind::IsQuarantined)
        );
        assert!(!edited.quarantined_only);
        assert_eq!(
            remove_last_search_scope(&mut edited),
            Some(SearchScopeKind::MaxTrust)
        );
        assert_eq!(edited.max_trust, None);
    }
}
