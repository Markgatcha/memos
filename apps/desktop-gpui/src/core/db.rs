use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use rusqlite::{Connection, OpenFlags, Row, types::Value as SqlValue};
use thiserror::Error;

use crate::core::model::{
    BriefContradictionPair, BriefSnapshot, ContextPreviewItem, DbOverview, EdgeDirection,
    FacetCount, GraphEdgeData, GraphMode, GraphNodeData, GraphSnapshot, KNOWN_TABLES,
    LinkedContradiction, LinkedEdge, MemoryDetail, MemoryListItem, QueryFilter, SortOrder,
    TableSummary, TamperReceipt, WriterSchemaPreflight, citation_token, make_single_line_preview,
    parse_citation_prefix, short_citation_id,
};
use crate::core::write_bridge::ReviewQueueItem;

pub const DEFAULT_GRAPH_NODE_CAP: usize = 2_000;

/// Result of resolving a full memory ID, `[mem:<short>]` token, or prefix.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NodeLookup {
    Exact(String),
    Ambiguous(Vec<String>),
    NotFound,
}

/// Non-secret aggregate statistics gathered read-only for store health classification.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HealthRawStats {
    pub node_count: usize,
    pub edge_count: usize,
    pub contradiction_count: usize,
    pub quarantined_count: usize,
    pub expired_count: usize,
    pub stale_count: usize,
    pub drifted_source_count: usize,
    pub low_trust_count: usize,
    pub duplicate_count: usize,
    pub newest_updated_at: Option<i64>,
    pub oldest_created_at: Option<i64>,
}

/// Return bundled SQLite runtime version string.
pub fn sqlite_version() -> &'static str {
    rusqlite::version()
}

/// Summary returned by fast read-only database validation during onboarding/open.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DbProbeSummary {
    pub path: PathBuf,
    pub node_count: usize,
    pub edge_count: usize,
}

/// Non-blocking validation helper used by onboarding before accepting a store path.
pub fn probe_database(path: &Path) -> Result<DbProbeSummary, String> {
    ReadOnlyStore::probe_database(path)
}

/// Sanitized database error type (never embeds memory text or search queries).
#[derive(Debug, Error)]
pub enum DbError {
    #[error("database file does not exist")]
    NotFound,
    #[error("database has no `nodes` table")]
    MissingNodesTable,
    #[error("failed to open read-only SQLite connection (code: {code})")]
    OpenFailed { code: String },
    #[error("read-only SQLite query failed (code: {code})")]
    QueryFailed { code: String },
}

impl DbError {
    fn from_sqlite(err: &rusqlite::Error, is_open: bool) -> Self {
        let code = match err {
            rusqlite::Error::SqliteFailure(ffi_err, _) => format!("{:?}", ffi_err.code),
            _ => "sqlite_error".to_string(),
        };
        if is_open {
            DbError::OpenFailed { code }
        } else {
            DbError::QueryFailed { code }
        }
    }
}

/// Runtime-introspected schema map built via `PRAGMA table_info(...)`.
#[derive(Clone, Debug, Default)]
pub struct SchemaInfo {
    pub tables: HashMap<String, HashSet<String>>,
}

impl SchemaInfo {
    pub fn introspect(conn: &Connection) -> Result<Self, DbError> {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        let table_names: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| DbError::from_sqlite(&e, false))?
            .filter_map(Result::ok)
            .collect();

        let mut tables = HashMap::new();
        for name in table_names {
            if !is_safe_ident(&name) {
                continue;
            }
            let pragma_sql = format!("PRAGMA table_info(\"{name}\")");
            let mut cols_stmt = conn
                .prepare(&pragma_sql)
                .map_err(|e| DbError::from_sqlite(&e, false))?;
            let cols: HashSet<String> = cols_stmt
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| DbError::from_sqlite(&e, false))?
                .filter_map(Result::ok)
                .collect();
            tables.insert(name, cols);
        }

        Ok(Self { tables })
    }

    pub fn has_table(&self, table: &str) -> bool {
        self.tables.contains_key(table)
    }

    pub fn has_col(&self, table: &str, col: &str) -> bool {
        self.tables
            .get(table)
            .is_some_and(|cols| cols.contains(col))
    }

    fn node_col_expr(&self, alias: &str, col: &str, fallback_sql: &str) -> String {
        if self.has_col("nodes", col) {
            format!("{alias}.{col}")
        } else {
            format!("{fallback_sql} AS {col}")
        }
    }

    /// Verify all tables and columns written by the MemOS MCP SDK exist before enabling writes.
    pub fn check_writer_preflight(&self) -> WriterSchemaPreflight {
        let mut missing = Vec::new();
        for (table, cols) in [
            ("edges", &["metadata", "valid_from", "valid_to"][..]),
            ("nodes", &["metadata", "valid_from", "valid_to"][..]),
        ] {
            if !self.has_table(table) {
                missing.push(format!("{table} table"));
                continue;
            }
            for col in cols {
                if !self.has_col(table, col) {
                    missing.push(format!("{table}.{col}"));
                }
            }
        }
        for table in ["node_tags", "contradictions"] {
            if !self.has_table(table) {
                missing.push(format!("{table} table"));
            }
        }
        WriterSchemaPreflight {
            compatible: missing.is_empty(),
            missing,
        }
    }
}

fn is_safe_ident(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Strictly read-only handle to a MemOS SQLite store.
///
/// Maximum rows the UI list materializes per query.
///
/// The list is virtualized for rendering, but rendering is not the only
/// cost: FTS5 ranking plus row hydration dominates search latency. At 2k
/// rows a broad query measured 59 ms p95 in release; 500 rows keeps it in
/// the low milliseconds while still giving 50 screens of scroll. The search
/// box and filters reach everything beyond the cap, and the header reports
/// "500 of N memories" so truncation is visible. The graph view keeps its
/// wider scan because it needs an accurate cluster count.
/// Maximum rows materialized on the initial memory list load; subsequent pages fetch
/// [`LIST_NEXT_PAGE_SIZE`] rows via keyset pagination.
pub const LIST_PAGE_SIZE: usize = 500;

/// Increment size for subsequent keyset-paginated list loads.
pub const LIST_NEXT_PAGE_SIZE: usize = 250;

/// Keyset pagination cursor capturing exact sort values and tie-break `id` of the last row.
#[derive(Clone, Debug, PartialEq)]
pub struct ListCursor {
    pub updated_at: i64,
    pub importance: f64,
    pub trust_score: f64,
    pub id: String,
    pub fts_or_fallback: bool,
}

impl ListCursor {
    pub fn from_list_item(item: &MemoryListItem) -> Self {
        Self {
            updated_at: item.updated_at,
            importance: item.importance as f64,
            trust_score: item.trust_score as f64,
            id: item.id.clone(),
            fts_or_fallback: false,
        }
    }
}

/// One page of lightweight list items along with its continuation cursor.
#[derive(Clone, Debug)]
pub struct ListPageResult {
    pub items: Vec<MemoryListItem>,
    pub next_cursor: Option<ListCursor>,
    pub has_more: bool,
}

/// Opens with `SQLITE_OPEN_READ_ONLY`, `PRAGMA query_only = ON`, and `PRAGMA busy_timeout = 5000`.
pub struct ReadOnlyStore {
    path: PathBuf,
    conn: Connection,
    schema: SchemaInfo,
}

impl ReadOnlyStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, DbError> {
        let path = path.as_ref().to_path_buf();
        if !path.is_file() {
            return Err(DbError::NotFound);
        }

        let _t0 = Instant::now();
        let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| DbError::from_sqlite(&e, true))?;
        conn.pragma_update(None, "query_only", "ON")
            .map_err(|e| DbError::from_sqlite(&e, true))?;
        conn.pragma_update(None, "busy_timeout", 5000i64)
            .map_err(|e| DbError::from_sqlite(&e, true))?;
        let _ = conn.pragma_update(None, "temp_store", "MEMORY");
        let _ = conn.pragma_update(None, "cache_size", -16384i64);

        let schema = SchemaInfo::introspect(&conn)?;
        if !schema.has_table("nodes") {
            return Err(DbError::MissingNodesTable);
        }

        crate::core_info!(
            elapsed_ms = _t0.elapsed().as_millis() as u64,
            tables_found = schema.tables.len(),
            "opened read-only SQLite store"
        );

        Ok(Self { path, conn, schema })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn schema(&self) -> &SchemaInfo {
        &self.schema
    }

    pub fn probe_database(path: &Path) -> Result<DbProbeSummary, String> {
        if !path.exists() {
            return Err("Database file does not exist at this path.".to_string());
        }
        if !path.is_file() {
            return Err("Selected path is a directory, not a database file.".to_string());
        }
        match Self::open(path) {
            Ok(store) => {
                let node_count = store
                    .count_table("nodes")
                    .map_err(|e| format!("Could not count `nodes` rows ({e})."))?;
                let edge_count = store.count_table("edges").unwrap_or(0);
                Ok(DbProbeSummary {
                    path: path.to_path_buf(),
                    node_count,
                    edge_count,
                })
            }
            Err(DbError::NotFound) => Err("Database file does not exist at this path.".to_string()),
            Err(DbError::MissingNodesTable) => {
                Err("File opened as SQLite, but it does not contain a `nodes` table.".to_string())
            }
            Err(DbError::OpenFailed { code }) | Err(DbError::QueryFailed { code }) => {
                if code.contains("NotADatabase") {
                    Err("Selected file is not a valid SQLite database.".to_string())
                } else {
                    Err(format!(
                        "Failed to validate SQLite database (code: {code})."
                    ))
                }
            }
        }
    }

    /// Collect aggregate counts, facets, and schema summary (never logs memory text).
    pub fn load_overview(&self) -> Result<DbOverview, DbError> {
        let _t0 = Instant::now();
        let mut table_summaries = Vec::with_capacity(KNOWN_TABLES.len());
        let mut missing_tables = Vec::new();
        let mut counts_map: HashMap<&str, usize> = HashMap::new();

        for &tbl in KNOWN_TABLES {
            if let Some(cols) = self.schema.tables.get(tbl) {
                let row_count = self.count_table(tbl).unwrap_or(0);
                counts_map.insert(tbl, row_count);
                table_summaries.push(TableSummary {
                    name: tbl.to_string(),
                    present: true,
                    row_count,
                    columns: cols.clone(),
                });
            } else {
                missing_tables.push(tbl.to_string());
                table_summaries.push(TableSummary {
                    name: tbl.to_string(),
                    present: false,
                    row_count: 0,
                    columns: HashSet::new(),
                });
            }
        }

        let namespaces = self.count_facet("namespace", "default")?;
        let types = self.count_facet("type", "fact")?;
        let provenances = self.count_facet("provenance", "user")?;
        let tags = self.load_tag_counts()?;
        let contradiction_node_ids = self.load_contradiction_node_ids()?;
        let newest_updated_at = self.load_newest_updated_at();
        let writer_preflight = self.schema.check_writer_preflight();

        let overview = DbOverview {
            db_path: self.path.clone(),
            node_count: *counts_map.get("nodes").unwrap_or(&0),
            edge_count: *counts_map.get("edges").unwrap_or(&0),
            contradiction_count: *counts_map.get("contradictions").unwrap_or(&0),
            lesson_count: *counts_map.get("procedural_lessons").unwrap_or(&0),
            trace_count: *counts_map.get("recall_traces").unwrap_or(&0),
            tamper_count: *counts_map.get("tamper_log").unwrap_or(&0),
            embedding_count: *counts_map.get("embeddings").unwrap_or(&0),
            newest_updated_at,
            writer_preflight,
            namespaces,
            tags,
            types,
            provenances,
            tables: table_summaries,
            missing_tables,
            contradiction_node_ids,
        };

        crate::core_info!(
            elapsed_ms = _t0.elapsed().as_millis() as u64,
            nodes = overview.node_count,
            edges = overview.edge_count,
            contradictions = overview.contradiction_count,
            "loaded DB overview"
        );
        Ok(overview)
    }

    fn load_newest_updated_at(&self) -> Option<i64> {
        let col = if self.schema.has_col("nodes", "updated_at") {
            "updated_at"
        } else if self.schema.has_col("nodes", "created_at") {
            "created_at"
        } else {
            return None;
        };
        let sql = format!(
            "SELECT MAX(CASE WHEN {col} > 0 AND {col} < 10000000000 THEN {col} * 1000 ELSE {col} END) FROM nodes"
        );
        self.conn
            .query_row(&sql, [], |row| row.get::<_, Option<i64>>(0))
            .ok()
            .flatten()
            .filter(|v| *v > 0)
    }

    /// Fast metadata lookup for `list` / `search` without scanning all 10 schema tables.
    pub fn load_list_fast_meta(&self) -> Result<(usize, HashSet<String>), DbError> {
        let total = self.count_table("nodes")?;
        let contradiction_ids = self.load_contradiction_node_ids()?;
        Ok((total, contradiction_ids))
    }

    /// Resolve a full ID, `[mem:<short>]`, `mem:<short>`, or short hex prefix to a canonical node ID.
    pub fn resolve_node_id(&self, raw: &str) -> Result<NodeLookup, DbError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() || !self.schema.has_col("nodes", "id") {
            return Ok(NodeLookup::NotFound);
        }

        if let Ok(exact) = self.conn.query_row(
            "SELECT id FROM nodes WHERE id = ?1 LIMIT 1",
            [trimmed],
            |row| row.get::<_, String>(0),
        ) {
            return Ok(NodeLookup::Exact(exact));
        }

        let candidate_prefix = if let Some(hex) = parse_citation_prefix(trimmed) {
            hex
        } else {
            let cleaned: String = trimmed
                .chars()
                .filter(|c| *c != '-')
                .map(|c| c.to_ascii_lowercase())
                .collect();
            if cleaned.len() < 2 {
                return Ok(NodeLookup::NotFound);
            }
            cleaned
        };

        let like_pat = format!("{}%", escape_like(&candidate_prefix));
        let mut stmt = self
            .conn
            .prepare_cached(
                "SELECT id FROM nodes WHERE lower(replace(id, '-', '')) LIKE ?1 ESCAPE '\\' LIMIT 6",
            )
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        let mut rows = stmt
            .query([&like_pat])
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        let mut matches = Vec::new();
        while let Some(row) = rows.next().map_err(|e| DbError::from_sqlite(&e, false))? {
            if let Ok(id) = row.get::<_, String>(0) {
                matches.push(id);
            }
        }
        match matches.len() {
            0 => Ok(NodeLookup::NotFound),
            1 => Ok(NodeLookup::Exact(matches.into_iter().next().unwrap())),
            _ => Ok(NodeLookup::Ambiguous(matches)),
        }
    }

    /// Collect aggregate counts and timestamp bounds without reading any memory text.
    pub fn load_health_raw_stats(
        &self,
        now_ms: i64,
        stale_cutoff_ms: i64,
    ) -> Result<HealthRawStats, DbError> {
        let node_count = self.count_table("nodes")?;
        let edge_count = self.count_table("edges")?;
        let contradiction_count = self.count_table("contradictions")?;

        if node_count == 0 {
            return Ok(HealthRawStats {
                node_count,
                edge_count,
                contradiction_count,
                ..Default::default()
            });
        }

        let max_updated_expr = if self.schema.has_col("nodes", "updated_at") {
            "MAX(CASE WHEN updated_at > 0 AND updated_at < 10000000000 THEN updated_at * 1000 ELSE updated_at END)"
        } else {
            "NULL"
        };
        let min_created_expr = if self.schema.has_col("nodes", "created_at") {
            "MIN(CASE WHEN created_at > 0 AND created_at < 10000000000 THEN created_at * 1000 ELSE created_at END)"
        } else {
            "NULL"
        };
        let quar_expr = if self.schema.has_col("nodes", "quarantined") {
            "SUM(CASE WHEN COALESCE(quarantined, 0) != 0 THEN 1 ELSE 0 END)"
        } else {
            "0"
        };
        let exp_expr = if self.schema.has_col("nodes", "expires_at") {
            "SUM(CASE WHEN expires_at IS NOT NULL AND expires_at > 0 AND (CASE WHEN expires_at < 10000000000 THEN expires_at * 1000 ELSE expires_at END) < ?1 THEN 1 ELSE 0 END)"
        } else {
            "0"
        };
        let stale_expr = if self.schema.has_col("nodes", "updated_at") {
            "SUM(CASE WHEN updated_at > 0 AND (CASE WHEN updated_at < 10000000000 THEN updated_at * 1000 ELSE updated_at END) < ?2 THEN 1 ELSE 0 END)"
        } else {
            "0"
        };
        let drift_expr = match (
            self.schema.has_col("nodes", "provenance"),
            self.schema.has_col("nodes", "quarantined"),
        ) {
            (true, true) => {
                "SUM(CASE WHEN COALESCE(quarantined, 0) != 0 OR lower(COALESCE(provenance, '')) LIKE '%drift%' OR lower(COALESCE(provenance, '')) LIKE '%stale%' THEN 1 ELSE 0 END)"
            }
            (true, false) => {
                "SUM(CASE WHEN lower(COALESCE(provenance, '')) LIKE '%drift%' OR lower(COALESCE(provenance, '')) LIKE '%stale%' THEN 1 ELSE 0 END)"
            }
            (false, true) => "SUM(CASE WHEN COALESCE(quarantined, 0) != 0 THEN 1 ELSE 0 END)",
            (false, false) => "0",
        };

        let low_trust_expr = if self.schema.has_col("nodes", "trust_score") {
            "SUM(CASE WHEN COALESCE(trust_score, 1.0) < 0.5 THEN 1 ELSE 0 END)"
        } else {
            "0"
        };

        let sql = format!(
            "SELECT {max_updated_expr}, {min_created_expr}, {quar_expr}, {exp_expr}, {stale_expr}, {drift_expr}, {low_trust_expr} FROM nodes"
        );
        let (
            newest_updated_at,
            oldest_created_at,
            quarantined_count,
            expired_count,
            stale_count,
            drifted_source_count,
            low_trust_count,
        ) = self
            .conn
            .query_row(&sql, rusqlite::params![now_ms, stale_cutoff_ms], |row| {
                Ok((
                    row.get::<_, Option<i64>>(0).ok().flatten(),
                    row.get::<_, Option<i64>>(1).ok().flatten(),
                    row.get::<_, i64>(2).unwrap_or(0).max(0) as usize,
                    row.get::<_, i64>(3).unwrap_or(0).max(0) as usize,
                    row.get::<_, i64>(4).unwrap_or(0).max(0) as usize,
                    row.get::<_, i64>(5).unwrap_or(0).max(0) as usize,
                    row.get::<_, i64>(6).unwrap_or(0).max(0) as usize,
                ))
            })
            .map_err(|e| DbError::from_sqlite(&e, false))?;

        let duplicate_count = if node_count > 1 {
            if let Some(dup_expr) = self.duplicate_key_expr("") {
                let dup_sql = format!(
                    "SELECT COALESCE(SUM(c - 1), 0) FROM (SELECT COUNT(*) AS c FROM nodes WHERE {dup_expr} IS NOT NULL GROUP BY {dup_expr} HAVING c > 1)"
                );
                self.conn
                    .query_row(&dup_sql, [], |row| row.get::<_, i64>(0))
                    .map(|v| v.max(0) as usize)
                    .unwrap_or(0)
            } else {
                0
            }
        } else {
            0
        };

        Ok(HealthRawStats {
            node_count,
            edge_count,
            contradiction_count,
            quarantined_count,
            expired_count,
            stale_count,
            drifted_source_count,
            low_trust_count,
            duplicate_count,
            newest_updated_at: newest_updated_at.filter(|&v| v > 0),
            oldest_created_at: oldest_created_at.filter(|&v| v > 0),
        })
    }

    fn duplicate_key_expr(&self, prefix: &str) -> Option<String> {
        let has_content = self.schema.has_col("nodes", "content");
        let has_summary = self.schema.has_col("nodes", "summary");
        match (has_content, has_summary) {
            (true, true) => Some(format!(
                "NULLIF(TRIM(COALESCE(NULLIF(TRIM({prefix}content), ''), COALESCE({prefix}summary, ''))), '')"
            )),
            (true, false) => Some(format!("NULLIF(TRIM(COALESCE({prefix}content, '')), '')")),
            (false, true) => Some(format!("NULLIF(TRIM(COALESCE({prefix}summary, '')), '')")),
            (false, false) => None,
        }
    }

    fn count_table(&self, table: &str) -> Result<usize, DbError> {
        if !is_safe_ident(table) || !self.schema.has_table(table) {
            return Ok(0);
        }
        let sql = format!("SELECT COUNT(*) FROM \"{table}\"");
        let count: i64 = self
            .conn
            .query_row(&sql, [], |row| row.get(0))
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        Ok(count.max(0) as usize)
    }

    fn count_facet(&self, col: &str, default_val: &str) -> Result<Vec<FacetCount>, DbError> {
        if !self.schema.has_col("nodes", col) {
            let total = self.count_table("nodes")?;
            return Ok(if total > 0 {
                vec![FacetCount {
                    name: default_val.to_string(),
                    count: total,
                }]
            } else {
                vec![]
            });
        }
        // Group by the raw column so SQLite can use its facet index; NULL and
        // empty values are folded into the default facet after counting.
        let sql = format!("SELECT {col}, COUNT(*) AS c FROM nodes GROUP BY {col}");
        let mut stmt = self
            .conn
            .prepare(&sql)
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, i64>(1)?.max(0) as usize,
                ))
            })
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        let mut counts: HashMap<String, usize> = HashMap::new();
        for row in rows {
            let (value, count) = row.map_err(|e| DbError::from_sqlite(&e, false))?;
            let name = match value {
                Some(value) if !value.is_empty() => value,
                _ => default_val.to_string(),
            };
            *counts.entry(name).or_insert(0) += count;
        }
        let mut out: Vec<FacetCount> = counts
            .into_iter()
            .map(|(name, count)| FacetCount { name, count })
            .collect();
        out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));
        out.truncate(250);
        Ok(out)
    }

    fn load_tag_counts(&self) -> Result<Vec<FacetCount>, DbError> {
        if self.schema.has_table("node_tags") && self.schema.has_col("node_tags", "tag") {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT tag, COUNT(*) AS c FROM node_tags \
                     GROUP BY tag ORDER BY c DESC, tag ASC LIMIT 250",
                )
                .map_err(|e| DbError::from_sqlite(&e, false))?;
            let rows: Vec<FacetCount> = stmt
                .query_map([], |row| {
                    Ok(FacetCount {
                        name: row.get::<_, String>(0)?,
                        count: row.get::<_, i64>(1)?.max(0) as usize,
                    })
                })
                .map_err(|e| DbError::from_sqlite(&e, false))?
                .filter_map(Result::ok)
                .collect();
            if !rows.is_empty() {
                return Ok(rows);
            }
        }

        if !self.schema.has_col("nodes", "tags") {
            return Ok(vec![]);
        }
        let mut stmt = self
            .conn
            .prepare("SELECT tags FROM nodes WHERE tags IS NOT NULL AND tags != '[]'")
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        let mut counts: HashMap<String, usize> = HashMap::new();
        let mut rows = stmt
            .query([])
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        while let Some(row) = rows.next().map_err(|e| DbError::from_sqlite(&e, false))? {
            let raw: String = row.get(0).unwrap_or_default();
            for tag in parse_tags_json(&raw) {
                *counts.entry(tag).or_insert(0) += 1;
            }
        }
        let mut out: Vec<FacetCount> = counts
            .into_iter()
            .map(|(name, count)| FacetCount { name, count })
            .collect();
        out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));
        out.truncate(250);
        Ok(out)
    }

    fn load_contradiction_node_ids(&self) -> Result<HashSet<String>, DbError> {
        let mut set = HashSet::new();
        if self.schema.has_table("contradictions")
            && self.schema.has_col("contradictions", "node_a")
            && self.schema.has_col("contradictions", "node_b")
        {
            let mut stmt = self
                .conn
                .prepare("SELECT node_a, node_b FROM contradictions")
                .map_err(|e| DbError::from_sqlite(&e, false))?;
            let mut rows = stmt
                .query([])
                .map_err(|e| DbError::from_sqlite(&e, false))?;
            while let Some(row) = rows.next().map_err(|e| DbError::from_sqlite(&e, false))? {
                if let Ok(a) = row.get::<_, String>(0) {
                    set.insert(a);
                }
                if let Ok(b) = row.get::<_, String>(1) {
                    set.insert(b);
                }
            }
        }
        if self.schema.has_table("edges")
            && self.schema.has_col("edges", "relation")
            && self.schema.has_col("edges", "source_id")
            && self.schema.has_col("edges", "target_id")
        {
            let mut stmt = self
                .conn
                .prepare("SELECT source_id, target_id FROM edges WHERE relation = 'contradicts'")
                .map_err(|e| DbError::from_sqlite(&e, false))?;
            let mut rows = stmt
                .query([])
                .map_err(|e| DbError::from_sqlite(&e, false))?;
            while let Some(row) = rows.next().map_err(|e| DbError::from_sqlite(&e, false))? {
                if let Ok(a) = row.get::<_, String>(0) {
                    set.insert(a);
                }
                if let Ok(b) = row.get::<_, String>(1) {
                    set.insert(b);
                }
            }
        }
        Ok(set)
    }

    /// Query lightweight memory list items using FTS5 when searching or structured SQL otherwise.
    pub fn query_nodes(
        &self,
        filter: &QueryFilter,
        contradiction_ids: &HashSet<String>,
        limit: usize,
    ) -> Result<Vec<MemoryListItem>, DbError> {
        Ok(self
            .query_nodes_page(filter, contradiction_ids, None, limit)?
            .items)
    }

    /// Keyset-paginated query returning up to `limit` items after `cursor`, sorted strictly by
    /// `(filter.sort DESC, id DESC)` (including search mode, for deterministic page boundaries).
    pub fn query_nodes_page(
        &self,
        filter: &QueryFilter,
        contradiction_ids: &HashSet<String>,
        cursor: Option<&ListCursor>,
        limit: usize,
    ) -> Result<ListPageResult, DbError> {
        let _t0 = Instant::now();
        if limit == 0 {
            return Ok(ListPageResult {
                items: Vec::new(),
                next_cursor: None,
                has_more: false,
            });
        }
        let trimmed_query = filter.query.trim();

        let page = if !trimmed_query.is_empty() {
            if let Some(hex_prefix) = parse_citation_prefix(trimmed_query) {
                self.query_nodes_by_citation_prefix(
                    &hex_prefix,
                    filter,
                    contradiction_ids,
                    cursor,
                    limit,
                )?
            } else if self.schema.has_table("nodes_fts") {
                self.query_nodes_fts(trimmed_query, filter, contradiction_ids, cursor, limit)?
            } else {
                self.query_nodes_like(trimmed_query, filter, contradiction_ids, cursor, limit)?
            }
        } else {
            self.query_nodes_structured(filter, contradiction_ids, cursor, limit)?
        };

        crate::core_debug!(
            elapsed_ms = _t0.elapsed().as_millis() as u64,
            result_count = page.items.len(),
            has_more = page.has_more,
            has_cursor = cursor.is_some(),
            has_query = !trimmed_query.is_empty(),
            "queried memory list page"
        );
        Ok(page)
    }

    fn preview_expr(&self, alias: &str) -> String {
        let has_summary = self.schema.has_col("nodes", "summary");
        let has_content = self.schema.has_col("nodes", "content");
        match (has_summary, has_content) {
            (true, true) => format!(
                "substr(CASE WHEN length({alias}.summary) > 0 THEN {alias}.summary ELSE {alias}.content END, 1, 220) AS preview"
            ),
            (true, false) => format!("substr({alias}.summary, 1, 220) AS preview"),
            (false, true) => format!("substr({alias}.content, 1, 220) AS preview"),
            (false, false) => "'' AS preview".to_string(),
        }
    }

    fn list_select_clause(&self, alias: &str) -> String {
        let id_expr = self
            .schema
            .node_col_expr(alias, "id", "CAST(rowid AS TEXT)");
        let preview = self.preview_expr(alias);
        let type_expr = self.schema.node_col_expr(alias, "type", "'fact'");
        let ns_expr = self.schema.node_col_expr(alias, "namespace", "'default'");
        let prov_expr = self.schema.node_col_expr(alias, "provenance", "'user'");
        let src_expr = self.schema.node_col_expr(alias, "source", "'user_input'");
        let harness_expr = self.schema.node_col_expr(alias, "harness", "'unknown'");
        let tags_expr = self.schema.node_col_expr(alias, "tags", "'[]'");
        let imp_expr = if self.schema.has_col("nodes", "importance") {
            format!("COALESCE({alias}.importance, 0.5)")
        } else {
            "0.5".to_string()
        };
        let trust_expr = if self.schema.has_col("nodes", "trust_score") {
            format!("COALESCE({alias}.trust_score, 1.0)")
        } else {
            "1.0".to_string()
        };
        let created_expr = self.schema.node_col_expr(alias, "created_at", "0");
        let updated_expr = if self.schema.has_col("nodes", "updated_at")
            && self.schema.has_col("nodes", "created_at")
        {
            format!("COALESCE({alias}.updated_at, {alias}.created_at, 0) AS updated_at")
        } else if self.schema.has_col("nodes", "updated_at") {
            format!("COALESCE({alias}.updated_at, 0) AS updated_at")
        } else if self.schema.has_col("nodes", "created_at") {
            format!("COALESCE({alias}.created_at, 0) AS updated_at")
        } else {
            "0 AS updated_at".to_string()
        };
        let quar_expr = self.schema.node_col_expr(alias, "quarantined", "0");

        format!(
            "{id_expr}, {preview}, {type_expr}, {ns_expr}, {prov_expr}, {src_expr}, \
             {harness_expr}, {tags_expr}, {imp_expr}, {trust_expr}, {created_expr}, \
             {updated_expr}, {quar_expr}"
        )
    }

    fn build_filter_where(
        &self,
        alias: &str,
        filter: &QueryFilter,
        conds: &mut Vec<String>,
        params: &mut Vec<SqlValue>,
    ) {
        if let Some(ns) = filter.namespace.as_deref().filter(|s| !s.is_empty())
            && self.schema.has_col("nodes", "namespace")
        {
            conds.push(format!("{alias}.namespace = ?"));
            params.push(SqlValue::Text(ns.to_string()));
        }

        if let Some(tag) = filter.tag.as_deref().filter(|s| !s.is_empty()) {
            if self.schema.has_table("node_tags")
                && self.schema.has_col("node_tags", "node_id")
                && self.schema.has_col("node_tags", "tag")
                && self.schema.has_col("nodes", "id")
            {
                conds.push(format!(
                    "EXISTS (SELECT 1 FROM node_tags nt WHERE nt.node_id = {alias}.id AND nt.tag = ?)"
                ));
                params.push(SqlValue::Text(tag.to_string()));
            } else if self.schema.has_col("nodes", "tags") {
                // Legacy stores predate `node_tags`: match the JSON array
                // exactly instead of LIKE, which is case-insensitive and
                // treats `%`/`_` as wildcards.
                conds.push(format!(
                    "EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid({alias}.tags) THEN {alias}.tags ELSE '[]' END) je WHERE je.value = ?)"
                ));
                params.push(SqlValue::Text(tag.to_string()));
            }
        }

        if let Some(nt) = filter.node_type.as_deref().filter(|s| !s.is_empty())
            && self.schema.has_col("nodes", "type")
        {
            conds.push(format!("{alias}.type = ?"));
            params.push(SqlValue::Text(nt.to_string()));
        }

        if let Some(prov) = filter.provenance.as_deref().filter(|s| !s.is_empty())
            && self.schema.has_col("nodes", "provenance")
        {
            conds.push(format!("{alias}.provenance = ?"));
            params.push(SqlValue::Text(prov.to_string()));
        }

        if filter.has_contradiction && self.schema.has_col("nodes", "id") {
            let mut union_parts = Vec::new();
            if self.schema.has_table("contradictions")
                && self.schema.has_col("contradictions", "node_a")
                && self.schema.has_col("contradictions", "node_b")
            {
                union_parts.push("SELECT node_a FROM contradictions".to_string());
                union_parts.push("SELECT node_b FROM contradictions".to_string());
            }
            if self.schema.has_table("edges")
                && self.schema.has_col("edges", "relation")
                && self.schema.has_col("edges", "source_id")
                && self.schema.has_col("edges", "target_id")
            {
                union_parts
                    .push("SELECT source_id FROM edges WHERE relation = 'contradicts'".to_string());
                union_parts
                    .push("SELECT target_id FROM edges WHERE relation = 'contradicts'".to_string());
            }
            if union_parts.is_empty() {
                conds.push("0 = 1".to_string());
            } else {
                // Materialize the contradicting ID set once instead of per-row correlated OR scans.
                conds.push(format!("{alias}.id IN ({})", union_parts.join(" UNION ")));
            }
        }

        if let Some(min_imp) = filter.min_importance
            && self.schema.has_col("nodes", "importance")
        {
            conds.push(format!("{alias}.importance >= ?"));
            params.push(SqlValue::Real(min_imp as f64));
        }

        if let Some(after_ms) = filter.created_after_ms
            && self.schema.has_col("nodes", "created_at")
        {
            conds.push(format!("{alias}.created_at >= ?"));
            params.push(SqlValue::Integer(after_ms));
        }

        if filter.quarantined_only {
            if self.schema.has_col("nodes", "quarantined") {
                conds.push(format!("{alias}.quarantined != 0"));
            } else {
                conds.push("0 = 1".to_string());
            }
        }

        if let Some(cutoff_ms) = filter.updated_before_ms {
            if self.schema.has_col("nodes", "updated_at") {
                conds.push(format!(
                    "({alias}.updated_at > 0 AND (CASE WHEN {alias}.updated_at < 10000000000 THEN {alias}.updated_at * 1000 ELSE {alias}.updated_at END) < ?)"
                ));
                params.push(SqlValue::Integer(cutoff_ms));
            } else {
                conds.push("0 = 1".to_string());
            }
        }

        if let Some(cutoff_ms) = filter.stale_before_ms {
            let mut stale_parts = Vec::new();
            if self.schema.has_col("nodes", "updated_at") {
                stale_parts.push(format!(
                    "({alias}.updated_at > 0 AND (CASE WHEN {alias}.updated_at < 10000000000 THEN {alias}.updated_at * 1000 ELSE {alias}.updated_at END) < ?)"
                ));
                params.push(SqlValue::Integer(cutoff_ms));
            }
            if self.schema.has_col("nodes", "expires_at") {
                let exp_now_ms = cutoff_ms.saturating_add(90 * 86_400_000);
                stale_parts.push(format!(
                    "({alias}.expires_at IS NOT NULL AND {alias}.expires_at > 0 AND (CASE WHEN {alias}.expires_at < 10000000000 THEN {alias}.expires_at * 1000 ELSE {alias}.expires_at END) < ?)"
                ));
                params.push(SqlValue::Integer(exp_now_ms));
            }
            if self.schema.has_col("nodes", "quarantined") {
                stale_parts.push(format!("COALESCE({alias}.quarantined, 0) != 0"));
            }
            if self.schema.has_col("nodes", "provenance") {
                stale_parts.push(format!(
                    "(lower(COALESCE({alias}.provenance, '')) LIKE '%drift%' OR lower(COALESCE({alias}.provenance, '')) LIKE '%stale%')"
                ));
            }
            if stale_parts.is_empty() {
                conds.push("0 = 1".to_string());
            } else {
                conds.push(format!("({})", stale_parts.join(" OR ")));
            }
        }

        if let Some(max_trust) = filter.max_trust {
            if self.schema.has_col("nodes", "trust_score") {
                conds.push(format!("COALESCE({alias}.trust_score, 1.0) < ?"));
                params.push(SqlValue::Real(max_trust as f64));
            } else {
                conds.push("0 = 1".to_string());
            }
        }

        if filter.duplicates_only {
            let prefix = format!("{alias}.");
            if let (Some(outer_dup), Some(inner_dup)) = (
                self.duplicate_key_expr(&prefix),
                self.duplicate_key_expr(""),
            ) {
                conds.push(format!(
                    "{outer_dup} IN (SELECT {inner_dup} AS dup_k FROM nodes WHERE {inner_dup} IS NOT NULL GROUP BY dup_k HAVING COUNT(*) > 1)"
                ));
            } else {
                conds.push("0 = 1".to_string());
            }
        }

        if let Some(after_ms) = filter.updated_not_new_after_ms {
            if self.schema.has_col("nodes", "updated_at")
                && self.schema.has_col("nodes", "created_at")
            {
                conds.push(format!(
                    "{alias}.updated_at >= ? AND {alias}.created_at < ?"
                ));
                params.push(SqlValue::Integer(after_ms));
                params.push(SqlValue::Integer(after_ms));
            } else {
                conds.push("0 = 1".to_string());
            }
        }

        if let Some((start_ms, end_ms)) = filter.expiring_window_ms {
            if self.schema.has_col("nodes", "expires_at") {
                conds.push(format!(
                    "({alias}.expires_at IS NOT NULL AND {alias}.expires_at > 0 AND (CASE WHEN {alias}.expires_at < 10000000000 THEN {alias}.expires_at * 1000 ELSE {alias}.expires_at END) BETWEEN ? AND ?)"
                ));
                params.push(SqlValue::Integer(start_ms));
                params.push(SqlValue::Integer(end_ms));
            } else {
                conds.push("0 = 1".to_string());
            }
        }

        if filter.needs_review_only {
            let mut review_parts = Vec::new();
            if self.schema.has_col("nodes", "provenance") {
                review_parts.push(format!(
                    "LOWER(COALESCE({alias}.provenance, '')) = 'agent-inferred'"
                ));
            }
            if self.schema.has_col("nodes", "trust_score") {
                review_parts.push(format!("COALESCE({alias}.trust_score, 1.0) < 0.5"));
            }
            if review_parts.is_empty() {
                conds.push("0 = 1".to_string());
            } else {
                conds.push(format!("({})", review_parts.join(" OR ")));
            }
        }
    }

    fn id_sort_col(&self, alias: &str) -> String {
        self.schema
            .node_col_expr(alias, "id", &format!("CAST({alias}.rowid AS TEXT)"))
    }

    fn updated_sort_col(&self, alias: &str) -> String {
        if self.schema.has_col("nodes", "updated_at") && self.schema.has_col("nodes", "created_at")
        {
            format!("COALESCE({alias}.updated_at, {alias}.created_at, 0)")
        } else if self.schema.has_col("nodes", "updated_at") {
            format!("COALESCE({alias}.updated_at, 0)")
        } else if self.schema.has_col("nodes", "created_at") {
            format!("COALESCE({alias}.created_at, 0)")
        } else {
            // No time axis at all: order and page by the same id expression
            // the cursor uses, otherwise page two compares against 0.
            self.id_sort_col(alias)
        }
    }

    fn importance_sort_col(&self, alias: &str) -> String {
        if self.schema.has_col("nodes", "importance") {
            format!("COALESCE({alias}.importance, 0.5)")
        } else {
            "0.5".to_string()
        }
    }

    fn trust_sort_col(&self, alias: &str) -> String {
        if self.schema.has_col("nodes", "trust_score") {
            format!("COALESCE({alias}.trust_score, 1.0)")
        } else {
            "1.0".to_string()
        }
    }

    fn order_by_clause(&self, alias: &str, sort: SortOrder, _with_fts_rank: bool) -> String {
        let id_col = self.id_sort_col(alias);
        match sort {
            SortOrder::Recency => {
                let updated_col = self.updated_sort_col(alias);
                format!("{updated_col} DESC, {id_col} DESC")
            }
            SortOrder::Importance => {
                let imp_col = self.importance_sort_col(alias);
                format!("{imp_col} DESC, {id_col} DESC")
            }
            SortOrder::Trust => {
                let trust_col = self.trust_sort_col(alias);
                format!("{trust_col} DESC, {id_col} DESC")
            }
        }
    }

    fn build_cursor_where(
        &self,
        alias: &str,
        sort: SortOrder,
        cursor: Option<&ListCursor>,
        conds: &mut Vec<String>,
        params: &mut Vec<SqlValue>,
    ) {
        let Some(c) = cursor else {
            return;
        };
        let id_col = self.id_sort_col(alias);
        match sort {
            SortOrder::Recency => {
                if !self.schema.has_col("nodes", "updated_at")
                    && !self.schema.has_col("nodes", "created_at")
                {
                    conds.push(format!("{id_col} < ?"));
                    params.push(SqlValue::Text(c.id.clone()));
                    return;
                }
                let col = self.updated_sort_col(alias);
                conds.push(format!("({col} < ? OR ({col} = ? AND {id_col} < ?))"));
                params.push(SqlValue::Integer(c.updated_at));
                params.push(SqlValue::Integer(c.updated_at));
                params.push(SqlValue::Text(c.id.clone()));
            }
            SortOrder::Importance => {
                let col = self.importance_sort_col(alias);
                conds.push(format!("({col} < ? OR ({col} = ? AND {id_col} < ?))"));
                params.push(SqlValue::Real(c.importance));
                params.push(SqlValue::Real(c.importance));
                params.push(SqlValue::Text(c.id.clone()));
            }
            SortOrder::Trust => {
                let col = self.trust_sort_col(alias);
                conds.push(format!("({col} < ? OR ({col} = ? AND {id_col} < ?))"));
                params.push(SqlValue::Real(c.trust_score));
                params.push(SqlValue::Real(c.trust_score));
                params.push(SqlValue::Text(c.id.clone()));
            }
        }
    }

    fn query_nodes_structured(
        &self,
        filter: &QueryFilter,
        contradiction_ids: &HashSet<String>,
        cursor: Option<&ListCursor>,
        limit: usize,
    ) -> Result<ListPageResult, DbError> {
        let select = self.list_select_clause("n");
        let mut conds = Vec::new();
        let mut params = Vec::new();
        self.build_filter_where("n", filter, &mut conds, &mut params);
        self.build_cursor_where("n", filter.sort, cursor, &mut conds, &mut params);
        let where_sql = if conds.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conds.join(" AND "))
        };
        let order = self.order_by_clause("n", filter.sort, false);
        params.push(SqlValue::Integer(limit.saturating_add(1) as i64));
        // Defer preview substring + 12-column projection until after Top-N rowid ranking.
        let sql = format!(
            "WITH ranked AS (\
                SELECT n.rowid AS rid FROM nodes n {where_sql} ORDER BY {order} LIMIT ?\
             ) \
             SELECT {select} FROM ranked r \
             INNER JOIN nodes n ON n.rowid = r.rid \
             ORDER BY {order}"
        );
        self.execute_list_page_query(
            &sql,
            params,
            filter.tag.as_deref(),
            contradiction_ids,
            limit,
            false,
        )
    }

    fn query_nodes_fts(
        &self,
        raw_query: &str,
        filter: &QueryFilter,
        contradiction_ids: &HashSet<String>,
        cursor: Option<&ListCursor>,
        limit: usize,
    ) -> Result<ListPageResult, DbError> {
        let terms = build_fts_terms(raw_query);
        if terms.is_empty() {
            return self.query_nodes_structured(filter, contradiction_ids, cursor, limit);
        }

        let select = self.list_select_clause("n");
        let mut conds = vec!["nodes_fts MATCH ?".to_string()];
        let mut base_params = vec![SqlValue::Null];
        self.build_filter_where("n", filter, &mut conds, &mut base_params);
        self.build_cursor_where("n", filter.sort, cursor, &mut conds, &mut base_params);
        let where_sql = format!("WHERE {}", conds.join(" AND "));
        let order = self.order_by_clause("n", filter.sort, false);
        let sql = format!(
            "WITH ranked AS (\
                SELECT n.rowid AS rid FROM nodes n \
                INNER JOIN nodes_fts fts ON fts.rowid = n.rowid \
                {where_sql} ORDER BY {order} LIMIT ?\
             ) \
             SELECT {select} FROM ranked r \
             INNER JOIN nodes n ON n.rowid = r.rid \
             ORDER BY {order}"
        );

        let use_or_only = cursor.is_some_and(|c| c.fts_or_fallback);
        if use_or_only {
            let mut or_params = base_params;
            or_params[0] = SqlValue::Text(terms.join(" OR "));
            or_params.push(SqlValue::Integer(limit.saturating_add(1) as i64));
            return self.execute_list_page_query(
                &sql,
                or_params,
                filter.tag.as_deref(),
                contradiction_ids,
                limit,
                true,
            );
        }

        let and_expr = terms.join(" AND ");
        let mut and_params = base_params.clone();
        and_params[0] = SqlValue::Text(and_expr);
        and_params.push(SqlValue::Integer(limit.saturating_add(1) as i64));

        let page = self.execute_list_page_query(
            &sql,
            and_params,
            filter.tag.as_deref(),
            contradiction_ids,
            limit,
            false,
        )?;
        // Only fall back from AND -> OR on page 1 (`cursor.is_none()`), never mid-pagination.
        if cursor.is_none() && page.items.is_empty() && terms.len() > 1 {
            let mut or_params = base_params;
            or_params[0] = SqlValue::Text(terms.join(" OR "));
            or_params.push(SqlValue::Integer(limit.saturating_add(1) as i64));
            return self.execute_list_page_query(
                &sql,
                or_params,
                filter.tag.as_deref(),
                contradiction_ids,
                limit,
                true,
            );
        }

        Ok(page)
    }

    fn query_nodes_like(
        &self,
        raw_query: &str,
        filter: &QueryFilter,
        contradiction_ids: &HashSet<String>,
        cursor: Option<&ListCursor>,
        limit: usize,
    ) -> Result<ListPageResult, DbError> {
        let select = self.list_select_clause("n");
        let escaped = escape_like(raw_query);
        let pattern = format!("%{escaped}%");
        let mut conds = Vec::new();
        let mut params = Vec::new();

        let has_content = self.schema.has_col("nodes", "content");
        let has_summary = self.schema.has_col("nodes", "summary");
        match (has_content, has_summary) {
            (true, true) => {
                conds.push(
                    "(LOWER(n.content) LIKE LOWER(?) ESCAPE '\\' OR LOWER(n.summary) LIKE LOWER(?) ESCAPE '\\')"
                        .to_string(),
                );
                params.push(SqlValue::Text(pattern.clone()));
                params.push(SqlValue::Text(pattern));
            }
            (true, false) => {
                conds.push("LOWER(n.content) LIKE LOWER(?) ESCAPE '\\'".to_string());
                params.push(SqlValue::Text(pattern));
            }
            (false, true) => {
                conds.push("LOWER(n.summary) LIKE LOWER(?) ESCAPE '\\'".to_string());
                params.push(SqlValue::Text(pattern));
            }
            (false, false) => {
                conds.push("0 = 1".to_string());
            }
        }

        self.build_filter_where("n", filter, &mut conds, &mut params);
        self.build_cursor_where("n", filter.sort, cursor, &mut conds, &mut params);
        let order = self.order_by_clause("n", filter.sort, false);
        params.push(SqlValue::Integer(limit.saturating_add(1) as i64));
        let sql = format!(
            "SELECT {select} FROM nodes n WHERE {} ORDER BY {order} LIMIT ?",
            conds.join(" AND ")
        );
        self.execute_list_page_query(
            &sql,
            params,
            filter.tag.as_deref(),
            contradiction_ids,
            limit,
            false,
        )
    }

    fn query_nodes_by_citation_prefix(
        &self,
        hex_prefix: &str,
        filter: &QueryFilter,
        contradiction_ids: &HashSet<String>,
        cursor: Option<&ListCursor>,
        limit: usize,
    ) -> Result<ListPageResult, DbError> {
        let select = self.list_select_clause("n");
        let mut conds = Vec::new();
        let mut params = Vec::new();
        if self.schema.has_col("nodes", "id") {
            conds.push("REPLACE(LOWER(n.id), '-', '') LIKE ?".to_string());
            params.push(SqlValue::Text(format!("{hex_prefix}%")));
        } else {
            conds.push("0 = 1".to_string());
        }
        self.build_filter_where("n", filter, &mut conds, &mut params);
        self.build_cursor_where("n", filter.sort, cursor, &mut conds, &mut params);
        let order = self.order_by_clause("n", filter.sort, false);
        params.push(SqlValue::Integer(limit.saturating_add(1) as i64));
        let sql = format!(
            "SELECT {select} FROM nodes n WHERE {} ORDER BY {order} LIMIT ?",
            conds.join(" AND ")
        );
        self.execute_list_page_query(
            &sql,
            params,
            filter.tag.as_deref(),
            contradiction_ids,
            limit,
            false,
        )
    }

    fn execute_list_page_query(
        &self,
        sql: &str,
        params: Vec<SqlValue>,
        exact_tag_fallback: Option<&str>,
        contradiction_ids: &HashSet<String>,
        limit: usize,
        fts_or_fallback: bool,
    ) -> Result<ListPageResult, DbError> {
        let mut stmt = self
            .conn
            .prepare_cached(sql)
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        let mut interner: HashMap<String, Arc<str>> = HashMap::with_capacity(64);
        let mut rows = stmt
            .query(rusqlite::params_from_iter(params.iter()))
            .map_err(|e| DbError::from_sqlite(&e, false))?;

        let mut items = Vec::with_capacity(limit.min(512));
        let mut last_cursor: Option<ListCursor> = None;
        let mut has_more = false;
        while let Some(row) = rows.next().map_err(|e| DbError::from_sqlite(&e, false))? {
            let id: String = get_string(row, 0);
            let raw_preview: String = get_string(row, 1);
            let node_type = intern_col(&mut interner, row, 2, "fact");
            let namespace = intern_col(&mut interner, row, 3, "default");
            let provenance = intern_col(&mut interner, row, 4, "user");
            let source = intern_col(&mut interner, row, 5, "user_input");
            let harness = intern_col(&mut interner, row, 6, "unknown");
            let tags_slice = row
                .get_ref(7)
                .ok()
                .and_then(|v| v.as_str().ok())
                .unwrap_or("[]");
            let parsed_tags = parse_tags_json(tags_slice);

            // Guard against JSON-LIKE false positives when `node_tags` table is absent.
            if let Some(required_tag) = exact_tag_fallback
                && !self.schema.has_table("node_tags")
                && !parsed_tags.iter().any(|t| t == required_tag)
            {
                continue;
            }

            if items.len() >= limit {
                has_more = true;
                break;
            }

            let tags: Vec<Arc<str>> = parsed_tags
                .into_iter()
                .map(|t| intern(&mut interner, t))
                .collect();
            let importance_f64 = row.get::<_, f64>(8).unwrap_or(0.5);
            let trust_f64 = row.get::<_, f64>(9).unwrap_or(1.0);
            let importance = importance_f64 as f32;
            let trust_score = trust_f64 as f32;
            let created_at = row.get::<_, i64>(10).unwrap_or(0);
            let updated_at = row.get::<_, i64>(11).unwrap_or(created_at);
            let quarantined = row.get::<_, i64>(12).unwrap_or(0) != 0;
            let has_contradiction = contradiction_ids.contains(&id);
            let short_id = intern(&mut interner, short_citation_id(&id));
            let preview: Arc<str> = Arc::from(make_single_line_preview(&raw_preview, 180));

            last_cursor = Some(ListCursor {
                updated_at,
                importance: importance_f64,
                trust_score: trust_f64,
                id: id.clone(),
                fts_or_fallback,
            });
            items.push(MemoryListItem {
                id,
                short_id,
                preview,
                node_type,
                namespace,
                provenance,
                source,
                harness,
                tags,
                importance,
                trust_score,
                created_at,
                updated_at,
                has_contradiction,
                quarantined,
            });
        }

        Ok(ListPageResult {
            items,
            next_cursor: if has_more { last_cursor } else { None },
            has_more,
        })
    }

    /// Load full detail (content, metadata, temporal fields, edges, contradictions) for one node.
    pub fn load_node_detail(&self, node_id: &str) -> Result<Option<MemoryDetail>, DbError> {
        if !self.schema.has_col("nodes", "id") {
            return Ok(None);
        }

        let cols = [
            ("id", "''"),
            ("content", "''"),
            ("summary", "''"),
            ("type", "'fact'"),
            ("namespace", "'default'"),
            ("provenance", "'user'"),
            ("source", "'user_input'"),
            ("pool", "'event'"),
            ("harness", "'unknown'"),
            ("importance", "0.5"),
            ("trust_score", "1.0"),
            ("created_at", "0"),
            ("updated_at", "0"),
            ("access_count", "0"),
            ("last_accessed", "0"),
            ("valid_from", "NULL"),
            ("valid_to", "NULL"),
            ("expires_at", "NULL"),
            ("quarantined", "0"),
            ("quarantined_at", "NULL"),
            ("quarantine_reason", "NULL"),
            ("tags", "'[]'"),
            ("metadata", "'{}'"),
        ];

        let select_parts: Vec<String> = cols
            .iter()
            .map(|(col, fallback)| self.schema.node_col_expr("n", col, fallback))
            .collect();
        let sql = format!(
            "SELECT {} FROM nodes n WHERE n.id = ?1 LIMIT 1",
            select_parts.join(", ")
        );

        let mut stmt = self
            .conn
            .prepare_cached(&sql)
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        let mut rows = stmt
            .query([node_id])
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        let Some(row) = rows.next().map_err(|e| DbError::from_sqlite(&e, false))? else {
            return Ok(None);
        };

        let id = get_string(row, 0);
        let content = get_string(row, 1);
        let summary = get_string(row, 2);
        let node_type = get_string_or(row, 3, "fact");
        let namespace = get_string_or(row, 4, "default");
        let provenance = get_string_or(row, 5, "user");
        let source = get_string_or(row, 6, "user_input");
        let pool = get_string_or(row, 7, "event");
        let harness = get_string_or(row, 8, "unknown");
        let importance = row.get::<_, f64>(9).unwrap_or(0.5) as f32;
        let trust_score = row.get::<_, f64>(10).unwrap_or(1.0) as f32;
        let created_at = row.get::<_, i64>(11).unwrap_or(0);
        let updated_at = row.get::<_, i64>(12).unwrap_or(created_at);
        let access_count = row.get::<_, i64>(13).unwrap_or(0);
        let last_accessed = row.get::<_, i64>(14).unwrap_or(0);
        let valid_from = row.get::<_, Option<i64>>(15).unwrap_or(None);
        let valid_to = row.get::<_, Option<i64>>(16).unwrap_or(None);
        let expires_at = row.get::<_, Option<i64>>(17).unwrap_or(None);
        let quarantined = row.get::<_, i64>(18).unwrap_or(0) != 0;
        let quarantined_at = row.get::<_, Option<i64>>(19).unwrap_or(None);
        let quarantine_reason = row.get::<_, Option<String>>(20).unwrap_or(None);
        let tags_raw = get_string_or(row, 21, "[]");
        let metadata_raw = get_string_or(row, 22, "{}");

        let mut tags = parse_tags_json(&tags_raw);
        if tags.is_empty() && self.schema.has_table("node_tags") {
            tags = self.load_tags_for_node(&id).unwrap_or_default();
        }

        let meta_json: serde_json::Value =
            serde_json::from_str(&metadata_raw).unwrap_or_else(|_| serde_json::json!({}));
        let confidence = meta_json
            .get("confidence")
            .and_then(|v| v.as_f64())
            .map(|v| v as f32);
        let evidence_count = meta_json.get("evidenceCount").and_then(|v| v.as_u64());
        let metadata_pretty =
            serde_json::to_string_pretty(&meta_json).unwrap_or_else(|_| metadata_raw.clone());

        let mut entities = self.load_entities_for_node(&id).unwrap_or_default();
        if entities.is_empty()
            && let Some(arr) = meta_json.get("entities").and_then(|v| v.as_array())
        {
            entities = arr
                .iter()
                .filter_map(|v| v.as_str().map(ToOwned::to_owned))
                .collect();
        }

        let edges = self.load_edges_for_node(&id)?;
        let contradictions = self.load_contradictions_for_node(&id)?;
        let receipts = self.load_tamper_receipts_for_node(&id)?;

        Ok(Some(MemoryDetail {
            short_id: short_citation_id(&id),
            citation_token: citation_token(&id),
            id,
            content,
            summary,
            node_type,
            namespace,
            provenance,
            source,
            pool,
            harness,
            importance,
            trust_score,
            confidence,
            evidence_count,
            created_at,
            updated_at,
            access_count,
            last_accessed,
            valid_from,
            valid_to,
            expires_at,
            quarantined,
            quarantined_at,
            quarantine_reason,
            tags,
            entities,
            metadata_json: metadata_pretty,
            edges,
            contradictions,
            receipts,
        }))
    }

    fn load_tags_for_node(&self, node_id: &str) -> Result<Vec<String>, DbError> {
        if !self.schema.has_table("node_tags") || !self.schema.has_col("node_tags", "tag") {
            return Ok(vec![]);
        }
        let mut stmt = self
            .conn
            .prepare_cached("SELECT tag FROM node_tags WHERE node_id = ?1 ORDER BY tag ASC")
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        let rows = stmt
            .query_map([node_id], |row| row.get::<_, String>(0))
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    fn load_entities_for_node(&self, node_id: &str) -> Result<Vec<String>, DbError> {
        if !self.schema.has_table("entity_index") || !self.schema.has_col("entity_index", "entity")
        {
            return Ok(vec![]);
        }
        let mut stmt = self
            .conn
            .prepare_cached(
                "SELECT entity FROM entity_index WHERE node_id = ?1 ORDER BY entity ASC",
            )
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        let rows = stmt
            .query_map([node_id], |row| row.get::<_, String>(0))
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    fn load_edges_for_node(&self, node_id: &str) -> Result<Vec<LinkedEdge>, DbError> {
        if !self.schema.has_table("edges")
            || !self.schema.has_col("edges", "source_id")
            || !self.schema.has_col("edges", "target_id")
        {
            return Ok(vec![]);
        }

        let id_expr = if self.schema.has_col("edges", "id") {
            "e.id"
        } else {
            "CAST(e.rowid AS TEXT) AS id"
        };
        let rel_expr = if self.schema.has_col("edges", "relation") {
            "e.relation"
        } else {
            "'relates_to' AS relation"
        };
        let weight_expr = if self.schema.has_col("edges", "weight") {
            "e.weight"
        } else {
            "0.5 AS weight"
        };
        let created_expr = if self.schema.has_col("edges", "created_at") {
            "e.created_at"
        } else {
            "0 AS created_at"
        };
        let vf_expr = if self.schema.has_col("edges", "valid_from") {
            "e.valid_from"
        } else {
            "NULL AS valid_from"
        };
        let vt_expr = if self.schema.has_col("edges", "valid_to") {
            "e.valid_to"
        } else {
            "NULL AS valid_to"
        };
        let peer_preview = self.preview_expr("p");
        let peer_type = self.schema.node_col_expr("p", "type", "'fact'");

        let sql = format!(
            "SELECT {id_expr}, e.source_id, e.target_id, {rel_expr}, {weight_expr}, \
                    {created_expr}, {vf_expr}, {vt_expr}, {peer_preview}, {peer_type} \
             FROM edges e \
             LEFT JOIN nodes p ON p.id = CASE WHEN e.source_id = ?1 THEN e.target_id ELSE e.source_id END \
             WHERE e.source_id = ?1 OR e.target_id = ?1 \
             ORDER BY {weight_expr} DESC LIMIT 100"
        );

        let mut stmt = self
            .conn
            .prepare_cached(&sql)
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        let mut rows = stmt
            .query([node_id])
            .map_err(|e| DbError::from_sqlite(&e, false))?;

        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| DbError::from_sqlite(&e, false))? {
            let source_id = get_string(row, 1);
            let target_id = get_string(row, 2);
            let (direction, peer_id) = if source_id == node_id {
                (EdgeDirection::Outgoing, target_id)
            } else {
                (EdgeDirection::Incoming, source_id)
            };
            let raw_preview = get_string_or(row, 8, &peer_id);
            out.push(LinkedEdge {
                id: get_string(row, 0),
                direction,
                relation: get_string_or(row, 3, "relates_to"),
                weight: row.get::<_, f64>(4).unwrap_or(0.5) as f32,
                peer_short_id: short_citation_id(&peer_id),
                peer_id,
                peer_preview: make_single_line_preview(&raw_preview, 96),
                peer_type: get_string_or(row, 9, "fact"),
                created_at: row.get::<_, i64>(5).unwrap_or(0),
                valid_from: row.get::<_, Option<i64>>(6).unwrap_or(None),
                valid_to: row.get::<_, Option<i64>>(7).unwrap_or(None),
            });
        }

        Ok(out)
    }

    fn load_contradictions_for_node(
        &self,
        node_id: &str,
    ) -> Result<Vec<LinkedContradiction>, DbError> {
        if !self.schema.has_table("contradictions")
            || !self.schema.has_col("contradictions", "node_a")
            || !self.schema.has_col("contradictions", "node_b")
        {
            return Ok(vec![]);
        }

        let id_expr = if self.schema.has_col("contradictions", "id") {
            "c.id"
        } else {
            "CAST(c.rowid AS TEXT) AS id"
        };
        let status_expr = if self.schema.has_col("contradictions", "status") {
            "c.status"
        } else {
            "'unresolved' AS status"
        };
        let det_expr = if self.schema.has_col("contradictions", "detected_at") {
            "c.detected_at"
        } else {
            "0 AS detected_at"
        };
        let peer_preview = self.preview_expr("p");

        let sql = format!(
            "SELECT {id_expr}, c.node_a, c.node_b, {status_expr}, {det_expr}, {peer_preview} \
             FROM contradictions c \
             LEFT JOIN nodes p ON p.id = CASE WHEN c.node_a = ?1 THEN c.node_b ELSE c.node_a END \
             WHERE c.node_a = ?1 OR c.node_b = ?1 \
             ORDER BY {det_expr} DESC LIMIT 100"
        );

        let mut stmt = self
            .conn
            .prepare_cached(&sql)
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        let mut rows = stmt
            .query([node_id])
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| DbError::from_sqlite(&e, false))? {
            let a = get_string(row, 1);
            let b = get_string(row, 2);
            let peer_id = if a == node_id { b } else { a };
            let raw_preview = get_string_or(row, 5, &peer_id);
            out.push(LinkedContradiction {
                id: get_string(row, 0),
                status: get_string_or(row, 3, "unresolved"),
                detected_at: row.get::<_, i64>(4).unwrap_or(0),
                peer_short_id: short_citation_id(&peer_id),
                peer_id,
                peer_preview: make_single_line_preview(&raw_preview, 96),
            });
        }
        Ok(out)
    }

    fn load_tamper_receipts_for_node(&self, node_id: &str) -> Result<Vec<TamperReceipt>, DbError> {
        if !self.schema.has_table("tamper_log")
            || !self.schema.has_col("tamper_log", "node_id")
            || !self.schema.has_col("tamper_log", "op")
        {
            return Ok(vec![]);
        }

        let seq_expr = if self.schema.has_col("tamper_log", "seq") {
            "seq"
        } else {
            "rowid AS seq"
        };
        let ts_expr = if self.schema.has_col("tamper_log", "ts") {
            "ts"
        } else {
            "0 AS ts"
        };
        let node_hash_expr = if self.schema.has_col("tamper_log", "node_hash") {
            "node_hash"
        } else if self.schema.has_col("tamper_log", "content_hash") {
            "content_hash"
        } else {
            "'' AS node_hash"
        };
        let entry_hash_expr = if self.schema.has_col("tamper_log", "entry_hash") {
            "entry_hash"
        } else {
            "'' AS entry_hash"
        };
        let order_col = if self.schema.has_col("tamper_log", "seq") {
            "seq"
        } else {
            "rowid"
        };

        let sql = format!(
            "SELECT {seq_expr}, {ts_expr}, op, {node_hash_expr}, {entry_hash_expr} \
             FROM tamper_log WHERE node_id = ?1 ORDER BY {order_col} DESC LIMIT 8"
        );
        let mut stmt = self
            .conn
            .prepare_cached(&sql)
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        let mut rows = stmt
            .query([node_id])
            .map_err(|e| DbError::from_sqlite(&e, false))?;

        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| DbError::from_sqlite(&e, false))? {
            out.push(TamperReceipt {
                seq: row.get::<_, i64>(0).unwrap_or(0),
                ts: row.get::<_, i64>(1).unwrap_or(0),
                op: get_string(row, 2),
                node_hash: get_string(row, 3),
                entry_hash: get_string(row, 4),
            });
        }
        Ok(out)
    }

    /// Collect recent consolidation, decay, contradiction, and update events across available tables.
    pub fn load_dream_diff(
        &self,
        limit: usize,
    ) -> Result<Vec<crate::core::model::DreamDiffEntry>, DbError> {
        use crate::core::model::{DreamDiffEntry, DreamDiffKind, format_timestamp_ms};

        let cap = limit.clamp(1, 500);
        let cap_i64 = cap as i64;
        let mut entries: Vec<DreamDiffEntry> = Vec::new();
        let mut seen: HashSet<(i64, DreamDiffKind, String)> = HashSet::new();

        fn push_entry(
            seen: &mut HashSet<(i64, DreamDiffKind, String)>,
            entries: &mut Vec<DreamDiffEntry>,
            entry: DreamDiffEntry,
        ) {
            let key = (entry.timestamp, entry.kind, entry.node_id.clone());
            if seen.insert(key) {
                entries.push(entry);
            }
        }

        // 1. Tamper log mutation / promotion / consolidation stream.
        if self.schema.has_table("tamper_log")
            && self.schema.has_col("tamper_log", "node_id")
            && self.schema.has_col("tamper_log", "op")
        {
            let ts_expr = if self.schema.has_col("tamper_log", "ts") {
                "t.ts"
            } else {
                "0 AS ts"
            };
            let hash_expr = if self.schema.has_col("tamper_log", "node_hash") {
                "t.node_hash"
            } else if self.schema.has_col("tamper_log", "content_hash") {
                "t.content_hash"
            } else {
                "'' AS node_hash"
            };
            let order_expr = if self.schema.has_col("tamper_log", "seq") {
                "t.seq DESC"
            } else {
                "t.rowid DESC"
            };
            let preview_col = self.preview_expr("n");
            let sql = format!(
                "SELECT {ts_expr}, t.op, t.node_id, {hash_expr}, {preview_col} \
                 FROM tamper_log t \
                 LEFT JOIN nodes n ON n.id = t.node_id \
                 ORDER BY {order_expr} LIMIT ?1"
            );
            let mut stmt = self
                .conn
                .prepare_cached(&sql)
                .map_err(|e| DbError::from_sqlite(&e, false))?;
            let mut rows = stmt
                .query([cap_i64])
                .map_err(|e| DbError::from_sqlite(&e, false))?;
            while let Some(row) = rows.next().map_err(|e| DbError::from_sqlite(&e, false))? {
                let ts = row.get::<_, i64>(0).unwrap_or(0);
                let op = get_string(row, 1);
                let node_id = get_string(row, 2);
                if node_id.is_empty() {
                    continue;
                }
                let node_hash = get_string(row, 3);
                let raw_preview = get_string_or(row, 4, &node_id);
                let kind = classify_tamper_op_for_dream(&op);
                let hash_suffix = if node_hash.is_empty() {
                    String::new()
                } else {
                    let short_h: String = node_hash.chars().take(8).collect();
                    format!(" · #{short_h}")
                };
                push_entry(
                    &mut seen,
                    &mut entries,
                    DreamDiffEntry {
                        timestamp: ts,
                        kind,
                        short_id: short_citation_id(&node_id),
                        node_id,
                        summary: make_single_line_preview(&raw_preview, 84),
                        detail: format!("tamper_log: {op}{hash_suffix}"),
                    },
                );
            }
        }

        // 2. Contradiction pair discoveries.
        if self.schema.has_table("contradictions")
            && self.schema.has_col("contradictions", "node_a")
            && self.schema.has_col("contradictions", "node_b")
        {
            let ts_expr = if self.schema.has_col("contradictions", "detected_at") {
                "c.detected_at"
            } else {
                "0 AS detected_at"
            };
            let status_expr = if self.schema.has_col("contradictions", "status") {
                "c.status"
            } else {
                "'unresolved' AS status"
            };
            let preview_col = self.preview_expr("a");
            let sql = format!(
                "SELECT {ts_expr}, c.node_a, c.node_b, {status_expr}, {preview_col} \
                 FROM contradictions c \
                 LEFT JOIN nodes a ON a.id = c.node_a \
                 ORDER BY {ts_expr} DESC LIMIT ?1"
            );
            let mut stmt = self
                .conn
                .prepare_cached(&sql)
                .map_err(|e| DbError::from_sqlite(&e, false))?;
            let mut rows = stmt
                .query([cap_i64])
                .map_err(|e| DbError::from_sqlite(&e, false))?;
            while let Some(row) = rows.next().map_err(|e| DbError::from_sqlite(&e, false))? {
                let ts = row.get::<_, i64>(0).unwrap_or(0);
                let node_a = get_string(row, 1);
                let node_b = get_string(row, 2);
                if node_a.is_empty() {
                    continue;
                }
                let status = get_string_or(row, 3, "unresolved");
                let raw_preview = get_string_or(row, 4, &node_a);
                push_entry(
                    &mut seen,
                    &mut entries,
                    DreamDiffEntry {
                        timestamp: ts,
                        kind: DreamDiffKind::Contradiction,
                        short_id: short_citation_id(&node_a),
                        node_id: node_a,
                        summary: make_single_line_preview(&raw_preview, 84),
                        detail: format!(
                            "Conflicts with [mem:{}] · {status}",
                            short_citation_id(&node_b)
                        ),
                    },
                );
            }
        }

        // 3. Consolidation / lineage edges (merged_from, supersedes, derived_from, consolidated_from).
        if self.schema.has_table("edges")
            && self.schema.has_col("edges", "source_id")
            && self.schema.has_col("edges", "target_id")
            && self.schema.has_col("edges", "relation")
        {
            let ts_expr = if self.schema.has_col("edges", "created_at") {
                "e.created_at"
            } else {
                "0 AS created_at"
            };
            let preview_col = self.preview_expr("s");
            let sql = format!(
                "SELECT {ts_expr}, e.source_id, e.target_id, e.relation, {preview_col} \
                 FROM edges e \
                 LEFT JOIN nodes s ON s.id = e.source_id \
                 WHERE LOWER(e.relation) IN ('supersedes', 'derived_from', 'merged_from', 'consolidated_from', 'promotes', 'replaces') \
                 ORDER BY {ts_expr} DESC LIMIT ?1"
            );
            let mut stmt = self
                .conn
                .prepare_cached(&sql)
                .map_err(|e| DbError::from_sqlite(&e, false))?;
            let mut rows = stmt
                .query([cap_i64])
                .map_err(|e| DbError::from_sqlite(&e, false))?;
            while let Some(row) = rows.next().map_err(|e| DbError::from_sqlite(&e, false))? {
                let ts = row.get::<_, i64>(0).unwrap_or(0);
                let source_id = get_string(row, 1);
                let target_id = get_string(row, 2);
                if source_id.is_empty() {
                    continue;
                }
                let relation = get_string(row, 3);
                let raw_preview = get_string_or(row, 4, &source_id);
                let kind = if relation.eq_ignore_ascii_case("merged_from") {
                    DreamDiffKind::Merged
                } else {
                    DreamDiffKind::Promoted
                };
                push_entry(
                    &mut seen,
                    &mut entries,
                    DreamDiffEntry {
                        timestamp: ts,
                        kind,
                        short_id: short_citation_id(&source_id),
                        node_id: source_id,
                        summary: make_single_line_preview(&raw_preview, 84),
                        detail: format!("{relation} → [mem:{}]", short_citation_id(&target_id)),
                    },
                );
            }
        }

        // 4. Quarantined / decayed nodes and modified nodes.
        if self.schema.has_col("nodes", "quarantined") {
            let ts_expr = if self.schema.has_col("nodes", "quarantined_at")
                && self.schema.has_col("nodes", "updated_at")
            {
                "COALESCE(quarantined_at, updated_at, created_at)"
            } else if self.schema.has_col("nodes", "updated_at") {
                "COALESCE(updated_at, created_at)"
            } else {
                "created_at"
            };
            let reason_expr = if self.schema.has_col("nodes", "quarantine_reason") {
                "COALESCE(quarantine_reason, '')"
            } else {
                "'' AS reason"
            };
            let preview_col = self.preview_expr("n");
            let sql = format!(
                "SELECT n.id, {ts_expr}, {preview_col}, {reason_expr} \
                 FROM nodes n WHERE n.quarantined = 1 ORDER BY {ts_expr} DESC LIMIT ?1"
            );
            let mut stmt = self
                .conn
                .prepare_cached(&sql)
                .map_err(|e| DbError::from_sqlite(&e, false))?;
            let mut rows = stmt
                .query([cap_i64])
                .map_err(|e| DbError::from_sqlite(&e, false))?;
            while let Some(row) = rows.next().map_err(|e| DbError::from_sqlite(&e, false))? {
                let node_id = get_string(row, 0);
                let ts = row.get::<_, i64>(1).unwrap_or(0);
                let raw_preview = get_string_or(row, 2, &node_id);
                let reason = get_string(row, 3);
                push_entry(
                    &mut seen,
                    &mut entries,
                    DreamDiffEntry {
                        timestamp: ts,
                        kind: DreamDiffKind::Decayed,
                        short_id: short_citation_id(&node_id),
                        node_id,
                        summary: make_single_line_preview(&raw_preview, 84),
                        detail: if reason.trim().is_empty() {
                            "Quarantined memory".to_string()
                        } else {
                            format!("Quarantined: {reason}")
                        },
                    },
                );
            }
        }

        if self.schema.has_col("nodes", "updated_at") && self.schema.has_col("nodes", "created_at")
        {
            let preview_col = self.preview_expr("n");
            let sql = format!(
                "SELECT n.id, n.updated_at, n.created_at, {preview_col} \
                 FROM nodes n WHERE n.updated_at > n.created_at ORDER BY n.updated_at DESC LIMIT ?1"
            );
            let mut stmt = self
                .conn
                .prepare_cached(&sql)
                .map_err(|e| DbError::from_sqlite(&e, false))?;
            let mut rows = stmt
                .query([cap_i64])
                .map_err(|e| DbError::from_sqlite(&e, false))?;
            while let Some(row) = rows.next().map_err(|e| DbError::from_sqlite(&e, false))? {
                let node_id = get_string(row, 0);
                let ts = row.get::<_, i64>(1).unwrap_or(0);
                let created_at = row.get::<_, i64>(2).unwrap_or(0);
                let raw_preview = get_string_or(row, 3, &node_id);
                push_entry(
                    &mut seen,
                    &mut entries,
                    DreamDiffEntry {
                        timestamp: ts,
                        kind: DreamDiffKind::Updated,
                        short_id: short_citation_id(&node_id),
                        node_id,
                        summary: make_single_line_preview(&raw_preview, 84),
                        detail: format!(
                            "Updated after ingest (created {})",
                            format_timestamp_ms(created_at)
                        ),
                    },
                );
            }
        }

        // Legacy fallback when no explicit lifecycle events exist yet.
        if entries.is_empty() && self.schema.has_col("nodes", "created_at") {
            let ts_expr = if self.schema.has_col("nodes", "updated_at") {
                "COALESCE(n.updated_at, n.created_at)"
            } else {
                "n.created_at"
            };
            let preview_col = self.preview_expr("n");
            let sql = format!(
                "SELECT n.id, {ts_expr}, {preview_col} FROM nodes n ORDER BY {ts_expr} DESC LIMIT ?1"
            );
            let mut stmt = self
                .conn
                .prepare_cached(&sql)
                .map_err(|e| DbError::from_sqlite(&e, false))?;
            let mut rows = stmt
                .query([cap_i64])
                .map_err(|e| DbError::from_sqlite(&e, false))?;
            while let Some(row) = rows.next().map_err(|e| DbError::from_sqlite(&e, false))? {
                let node_id = get_string(row, 0);
                let ts = row.get::<_, i64>(1).unwrap_or(0);
                let raw_preview = get_string_or(row, 2, &node_id);
                push_entry(
                    &mut seen,
                    &mut entries,
                    DreamDiffEntry {
                        timestamp: ts,
                        kind: DreamDiffKind::Updated,
                        short_id: short_citation_id(&node_id),
                        node_id,
                        summary: make_single_line_preview(&raw_preview, 84),
                        detail: "Ingested (no consolidation log rows yet)".to_string(),
                    },
                );
            }
        }

        entries.sort_by_key(|a| std::cmp::Reverse(a.timestamp));
        entries.truncate(cap);
        Ok(entries)
    }

    /// Build a graph snapshot capped at `max_visible` (2,000) nodes, aggregating overflow into cluster nodes.
    pub fn load_graph_snapshot(
        &self,
        mode: GraphMode,
        filter: &QueryFilter,
        contradiction_ids: &HashSet<String>,
        max_visible: usize,
    ) -> Result<GraphSnapshot, DbError> {
        let _t0 = Instant::now();
        let cap = max_visible.max(16);

        let mut effective_filter = filter.clone();
        if mode == GraphMode::Contradictions {
            effective_filter.has_contradiction = true;
        }

        let mut entities_by_node: HashMap<String, Vec<Arc<str>>> = HashMap::new();
        if mode == GraphMode::Entity {
            entities_by_node = self.load_entity_map()?;
        }

        // Load only up to `cap + 1` full list items; stream lightweight metadata for any overflow > `cap`.
        let mut initial_items = self.query_nodes(&effective_filter, contradiction_ids, cap + 1)?;
        let mut total_matching_nodes = initial_items.len();

        let mut visible_items = Vec::new();
        let mut cluster_buckets: BTreeMap<String, (usize, i64, bool)> = BTreeMap::new();

        if initial_items.len() <= cap {
            visible_items = initial_items;
        } else if !effective_filter.query.trim().is_empty() {
            // Search query + > cap overflow is rare; preserve exact search ordering across 50k cap.
            let all_items = self.query_nodes(&effective_filter, contradiction_ids, 50_000)?;
            total_matching_nodes = all_items.len();
            let direct_limit = cap.saturating_sub(64).max(1);
            for (idx, item) in all_items.into_iter().enumerate() {
                if idx < direct_limit {
                    visible_items.push(item);
                } else {
                    let key = cluster_key_for_item(mode, &item, &entities_by_node);
                    if let Some(entry) = cluster_buckets.get_mut(&key) {
                        entry.0 += 1;
                        entry.1 = entry.1.max(item.created_at);
                        entry.2 |= item.has_contradiction;
                    } else {
                        cluster_buckets.insert(key, (1, item.created_at, item.has_contradiction));
                    }
                }
            }
        } else {
            let direct_limit = cap.saturating_sub(64).max(1);
            let mut seen_ids: HashSet<String> = HashSet::with_capacity(initial_items.len());
            for item in &initial_items {
                seen_ids.insert(item.id.clone());
            }
            let overflow_tail = initial_items.split_off(direct_limit);
            visible_items = initial_items;
            for item in &overflow_tail {
                let key = cluster_key_for_item(mode, item, &entities_by_node);
                if let Some(entry) = cluster_buckets.get_mut(&key) {
                    entry.0 += 1;
                    entry.1 = entry.1.max(item.created_at);
                    entry.2 |= item.has_contradiction;
                } else {
                    cluster_buckets.insert(key, (1, item.created_at, item.has_contradiction));
                }
            }
            let extra = self.accumulate_graph_overflow(
                mode,
                &effective_filter,
                contradiction_ids,
                &entities_by_node,
                &seen_ids,
                total_matching_nodes,
                50_000usize.saturating_sub(total_matching_nodes),
                &mut cluster_buckets,
            )?;
            total_matching_nodes += extra;
        }

        let mut nodes = Vec::with_capacity(visible_items.len() + cluster_buckets.len());
        let mut id_to_idx: HashMap<String, usize> = HashMap::with_capacity(visible_items.len());
        let mut group_first_idx: HashMap<String, usize> = HashMap::new();

        for item in &visible_items {
            let group = cluster_key_for_item(mode, item, &entities_by_node);
            let idx = nodes.len();
            id_to_idx.insert(item.id.clone(), idx);
            group_first_idx.entry(group.clone()).or_insert(idx);
            let label = format!(
                "{} {}",
                item.short_id,
                make_single_line_preview(&item.preview, 24)
            );
            nodes.push(GraphNodeData {
                key: item.id.clone(),
                memory_id: Some(item.id.clone()),
                label,
                group,
                node_type: item.node_type.to_string(),
                importance: item.importance,
                created_at: item.created_at,
                cluster_count: 1,
                has_contradiction: item.has_contradiction,
            });
        }

        let mut clustered_nodes = 0usize;
        let mut cluster_idx_by_group: HashMap<String, usize> = HashMap::new();
        for (group, (count, latest_ts, has_contra)) in cluster_buckets {
            if nodes.len() >= cap {
                break;
            }
            clustered_nodes += count;
            let idx = nodes.len();
            cluster_idx_by_group.insert(group.clone(), idx);
            nodes.push(GraphNodeData {
                key: format!("cluster:{group}"),
                memory_id: None,
                label: format!("{group} (+{count})"),
                group,
                node_type: "cluster".to_string(),
                importance: 0.9,
                created_at: latest_ts,
                cluster_count: count,
                has_contradiction: has_contra,
            });
        }

        let mut edges = Vec::new();
        let mut seen_pairs: HashSet<(usize, usize)> = HashSet::new();

        // 1. Add explicit DB edges between visible nodes.
        if self.schema.has_table("edges")
            && self.schema.has_col("edges", "source_id")
            && self.schema.has_col("edges", "target_id")
        {
            let rel_expr = if self.schema.has_col("edges", "relation") {
                "relation"
            } else {
                "'relates_to'"
            };
            let weight_expr = if self.schema.has_col("edges", "weight") {
                "weight"
            } else {
                "0.5"
            };
            let sql = format!(
                "SELECT source_id, target_id, {rel_expr}, {weight_expr} FROM edges LIMIT 20000"
            );
            if let Ok(mut stmt) = self.conn.prepare_cached(&sql)
                && let Ok(mut rows) = stmt.query([])
            {
                while let Ok(Some(row)) = rows.next() {
                    let Some(s) = row_str(row, 0) else { continue };
                    let Some(&si) = id_to_idx.get(s) else {
                        continue;
                    };
                    let Some(t) = row_str(row, 1) else { continue };
                    let Some(&ti) = id_to_idx.get(t) else {
                        continue;
                    };
                    if si == ti {
                        continue;
                    }
                    let key = if si < ti { (si, ti) } else { (ti, si) };
                    if seen_pairs.insert(key) {
                        let relation = get_string_or(row, 2, "relates_to");
                        let weight = row.get::<_, f64>(3).unwrap_or(0.5) as f32;
                        let is_contra = relation == "contradicts";
                        edges.push(GraphEdgeData {
                            source_idx: si,
                            target_idx: ti,
                            relation,
                            weight,
                            is_contradiction: is_contra,
                        });
                    }
                }
            }
        }

        // 2. Add contradiction edges from `contradictions` table.
        if self.schema.has_table("contradictions")
            && self.schema.has_col("contradictions", "node_a")
            && self.schema.has_col("contradictions", "node_b")
        {
            let status_expr = if self.schema.has_col("contradictions", "status") {
                "status"
            } else {
                "'unresolved'"
            };
            let sql =
                format!("SELECT node_a, node_b, {status_expr} FROM contradictions LIMIT 10000");
            if let Ok(mut stmt) = self.conn.prepare_cached(&sql)
                && let Ok(mut rows) = stmt.query([])
            {
                while let Ok(Some(row)) = rows.next() {
                    let Some(a) = row_str(row, 0) else { continue };
                    let Some(&ai) = id_to_idx.get(a) else {
                        continue;
                    };
                    let Some(b) = row_str(row, 1) else { continue };
                    let Some(&bi) = id_to_idx.get(b) else {
                        continue;
                    };
                    if ai == bi {
                        continue;
                    }
                    let key = if ai < bi { (ai, bi) } else { (bi, ai) };
                    if seen_pairs.insert(key) {
                        let status = get_string_or(row, 2, "unresolved");
                        edges.push(GraphEdgeData {
                            source_idx: ai,
                            target_idx: bi,
                            relation: format!("contradicts ({status})"),
                            weight: 1.0,
                            is_contradiction: true,
                        });
                    }
                }
            }
        }

        // 3. Mode-specific structural links (chain within namespace/tag/entity/temporal) so every view is informative.
        match mode {
            GraphMode::Namespace => {
                link_group_chains(&nodes, &mut edges, &mut seen_pairs, "same_namespace");
            }
            GraphMode::Tag => {
                let mut by_tag: HashMap<String, Vec<usize>> = HashMap::new();
                for (idx, item) in visible_items.iter().enumerate() {
                    for tag in &item.tags {
                        by_tag.entry(tag.to_string()).or_default().push(idx);
                    }
                }
                for (tag, indices) in by_tag {
                    for pair in indices.windows(2) {
                        let (a, b) = (pair[0], pair[1]);
                        let key = if a < b { (a, b) } else { (b, a) };
                        if seen_pairs.insert(key) {
                            edges.push(GraphEdgeData {
                                source_idx: a,
                                target_idx: b,
                                relation: format!("tag:{tag}"),
                                weight: 0.45,
                                is_contradiction: false,
                            });
                        }
                    }
                }
            }
            GraphMode::Entity => {
                let mut by_entity: HashMap<Arc<str>, Vec<usize>> = HashMap::new();
                for (idx, item) in visible_items.iter().enumerate() {
                    if let Some(ents) = entities_by_node.get(&item.id) {
                        for ent in ents {
                            by_entity.entry(ent.clone()).or_default().push(idx);
                        }
                    }
                }
                for (entity, indices) in by_entity {
                    for pair in indices.windows(2) {
                        let (a, b) = (pair[0], pair[1]);
                        let key = if a < b { (a, b) } else { (b, a) };
                        if seen_pairs.insert(key) {
                            edges.push(GraphEdgeData {
                                source_idx: a,
                                target_idx: b,
                                relation: format!("entity:{entity}"),
                                weight: 0.65,
                                is_contradiction: false,
                            });
                        }
                    }
                }
            }
            GraphMode::Temporal => {
                // Connect consecutive memories in chronological order per namespace (lightweight timeline thread).
                let mut ordered: Vec<(usize, i64, &str)> = visible_items
                    .iter()
                    .enumerate()
                    .map(|(i, item)| (i, item.created_at, item.namespace.as_ref()))
                    .collect();
                ordered.sort_by_key(|&(_, ts, _)| ts);
                let mut last_by_ns: HashMap<&str, usize> = HashMap::new();
                for (idx, _, ns) in ordered {
                    if let Some(prev) = last_by_ns.insert(ns, idx)
                        && prev != idx
                    {
                        let key = if prev < idx { (prev, idx) } else { (idx, prev) };
                        if seen_pairs.insert(key) {
                            edges.push(GraphEdgeData {
                                source_idx: prev,
                                target_idx: idx,
                                relation: "timeline".to_string(),
                                weight: 0.35,
                                is_contradiction: false,
                            });
                        }
                    }
                }
            }
            GraphMode::Contradictions => {}
        }

        // Link cluster summary nodes to a representative node in their group if present.
        for (group, cluster_idx) in cluster_idx_by_group {
            if let Some(&rep_idx) = group_first_idx.get(&group)
                && rep_idx != cluster_idx
            {
                let key = if rep_idx < cluster_idx {
                    (rep_idx, cluster_idx)
                } else {
                    (cluster_idx, rep_idx)
                };
                if seen_pairs.insert(key) {
                    edges.push(GraphEdgeData {
                        source_idx: rep_idx,
                        target_idx: cluster_idx,
                        relation: "cluster".to_string(),
                        weight: 0.4,
                        is_contradiction: false,
                    });
                }
            }
        }

        crate::core_info!(
            elapsed_ms = _t0.elapsed().as_millis() as u64,
            mode = mode.label(),
            visible_nodes = nodes.len(),
            clustered_nodes,
            edges = edges.len(),
            "loaded graph snapshot"
        );

        Ok(GraphSnapshot {
            mode,
            nodes,
            edges,
            total_matching_nodes,
            clustered_nodes,
        })
    }

    fn load_entity_map(&self) -> Result<HashMap<String, Vec<Arc<str>>>, DbError> {
        let mut map: HashMap<String, Vec<Arc<str>>> = HashMap::new();
        let mut interner: HashMap<String, Arc<str>> = HashMap::with_capacity(64);
        if self.schema.has_table("entity_index")
            && self.schema.has_col("entity_index", "entity")
            && self.schema.has_col("entity_index", "node_id")
        {
            let mut stmt = self
                .conn
                .prepare("SELECT node_id, entity FROM entity_index LIMIT 50000")
                .map_err(|e| DbError::from_sqlite(&e, false))?;
            let mut rows = stmt
                .query([])
                .map_err(|e| DbError::from_sqlite(&e, false))?;
            while let Some(row) = rows.next().map_err(|e| DbError::from_sqlite(&e, false))? {
                let Some(node_id) = row_str(row, 0).filter(|s| !s.is_empty()) else {
                    continue;
                };
                let Some(ent_slice) = row_str(row, 1).filter(|s| !s.is_empty()) else {
                    continue;
                };
                let ent = intern_slice(&mut interner, ent_slice);
                map.entry(node_id.to_string()).or_default().push(ent);
            }
            if !map.is_empty() {
                return Ok(map);
            }
        }

        if self.schema.has_col("nodes", "metadata") && self.schema.has_col("nodes", "id") {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT id, metadata FROM nodes WHERE metadata LIKE '%entities%' LIMIT 20000",
                )
                .map_err(|e| DbError::from_sqlite(&e, false))?;
            let mut rows = stmt
                .query([])
                .map_err(|e| DbError::from_sqlite(&e, false))?;
            while let Some(row) = rows.next().map_err(|e| DbError::from_sqlite(&e, false))? {
                let Some(raw) = row_str(row, 1) else {
                    continue;
                };
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(raw)
                    && let Some(arr) = json.get("entities").and_then(|v| v.as_array())
                {
                    let ents: Vec<Arc<str>> = arr
                        .iter()
                        .filter_map(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|s| intern_slice(&mut interner, s))
                        .collect();
                    if !ents.is_empty()
                        && let Some(node_id) = row_str(row, 0)
                    {
                        map.insert(node_id.to_string(), ents);
                    }
                }
            }
        }

        Ok(map)
    }

    #[allow(clippy::too_many_arguments)]
    fn accumulate_graph_overflow(
        &self,
        mode: GraphMode,
        filter: &QueryFilter,
        contradiction_ids: &HashSet<String>,
        entities_by_node: &HashMap<String, Vec<Arc<str>>>,
        seen_ids: &HashSet<String>,
        offset: usize,
        limit: usize,
        cluster_buckets: &mut BTreeMap<String, (usize, i64, bool)>,
    ) -> Result<usize, DbError> {
        if limit == 0 {
            return Ok(0);
        }
        let id_expr = self.schema.node_col_expr("n", "id", "CAST(rowid AS TEXT)");
        let ns_expr = self.schema.node_col_expr("n", "namespace", "'default'");
        let tags_expr = if mode == GraphMode::Tag
            || (filter.tag.is_some() && !self.schema.has_table("node_tags"))
        {
            self.schema.node_col_expr("n", "tags", "'[]'")
        } else {
            "'[]'".to_string()
        };
        let created_expr = self.schema.node_col_expr("n", "created_at", "0");

        let mut conds = Vec::new();
        let mut params = Vec::new();
        self.build_filter_where("n", filter, &mut conds, &mut params);
        let where_sql = if conds.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conds.join(" AND "))
        };

        // When total table rows fit within the 50k scan ceiling, every non-visible row is clustered,
        // so sorting 10k-50k rows just to discard them into commutative buckets is unnecessary.
        let total_table_rows = self.count_table("nodes").unwrap_or(usize::MAX);
        let skip_sort = total_table_rows <= 50_000;
        let sql = if skip_sort {
            format!(
                "SELECT {id_expr}, {ns_expr}, {tags_expr}, {created_expr} FROM nodes n {where_sql}"
            )
        } else {
            let order = self.order_by_clause("n", filter.sort, false);
            params.push(SqlValue::Integer(limit as i64));
            params.push(SqlValue::Integer(offset as i64));
            format!(
                "SELECT {id_expr}, {ns_expr}, {tags_expr}, {created_expr} FROM nodes n \
                 {where_sql} ORDER BY {order} LIMIT ? OFFSET ?"
            )
        };

        let mut stmt = self
            .conn
            .prepare_cached(&sql)
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        let mut rows = stmt
            .query(rusqlite::params_from_iter(params.iter()))
            .map_err(|e| DbError::from_sqlite(&e, false))?;

        let check_tag_fallback = filter
            .tag
            .as_deref()
            .filter(|_| !self.schema.has_table("node_tags"));
        let mut ym_buckets: HashMap<(i32, u8), (usize, i64, bool)> = HashMap::new();
        let mut count = 0usize;

        while let Some(row) = rows.next().map_err(|e| DbError::from_sqlite(&e, false))? {
            let id_slice = row_str(row, 0).unwrap_or("");
            if skip_sort && seen_ids.contains(id_slice) {
                continue;
            }
            let tags_slice = row_str(row, 2).unwrap_or("[]");
            if let Some(required_tag) = check_tag_fallback
                && !parse_tags_json(tags_slice)
                    .iter()
                    .any(|t| t == required_tag)
            {
                continue;
            }
            let created_at = row.get::<_, i64>(3).unwrap_or(0);
            let has_contra = !contradiction_ids.is_empty() && contradiction_ids.contains(id_slice);

            if mode == GraphMode::Temporal {
                if let Some(ym) = unix_ts_to_year_month(created_at) {
                    if let Some(entry) = ym_buckets.get_mut(&ym) {
                        entry.0 += 1;
                        entry.1 = entry.1.max(created_at);
                        entry.2 |= has_contra;
                    } else {
                        ym_buckets.insert(ym, (1, created_at, has_contra));
                    }
                } else {
                    accumulate_bucket(cluster_buckets, "unknown-date", created_at, has_contra);
                }
                count += 1;
                continue;
            }

            let ns_slice = row_str(row, 1)
                .filter(|s| !s.is_empty())
                .unwrap_or("default");
            match mode {
                GraphMode::Namespace | GraphMode::Contradictions => {
                    accumulate_bucket(cluster_buckets, ns_slice, created_at, has_contra);
                }
                GraphMode::Tag => {
                    if let Some(tag) = first_tag_from_json(tags_slice) {
                        let key = format!("#{tag}");
                        if let Some(entry) = cluster_buckets.get_mut(&key) {
                            entry.0 += 1;
                            entry.1 = entry.1.max(created_at);
                            entry.2 |= has_contra;
                        } else {
                            cluster_buckets.insert(key, (1, created_at, has_contra));
                        }
                    } else {
                        accumulate_bucket(cluster_buckets, "untagged", created_at, has_contra);
                    }
                }
                GraphMode::Entity => {
                    let key_slice = entities_by_node
                        .get(id_slice)
                        .and_then(|list| list.first())
                        .map(|s| s.as_ref())
                        .unwrap_or(ns_slice);
                    accumulate_bucket(cluster_buckets, key_slice, created_at, has_contra);
                }
                GraphMode::Temporal => unreachable!(),
            }
            count += 1;
        }

        if !ym_buckets.is_empty() {
            for ((year, month), (cnt, latest, has_c)) in ym_buckets {
                let label = format!("{year:04}-{month:02}");
                if let Some(entry) = cluster_buckets.get_mut(&label) {
                    entry.0 += cnt;
                    entry.1 = entry.1.max(latest);
                    entry.2 |= has_c;
                } else {
                    cluster_buckets.insert(label, (cnt, latest, has_c));
                }
            }
        }
        Ok(count)
    }

    /// Load up to `limit` full-text context items matching `filter` in current sort order,
    /// along with the total number of matching nodes for `"showing 12 of N"` indicators.
    pub fn load_context_items_for_filter(
        &self,
        filter: &QueryFilter,
        contradiction_ids: &HashSet<String>,
        limit: usize,
    ) -> Result<(Vec<ContextPreviewItem>, usize), DbError> {
        if !self.schema.has_table("nodes") || limit == 0 {
            return Ok((Vec::new(), 0));
        }

        let probe_limit = limit.saturating_add(1);
        let probe = self.query_nodes(filter, contradiction_ids, probe_limit)?;
        let total_matching = if probe.len() <= limit {
            probe.len()
        } else {
            self.count_matching_nodes(filter)?.max(probe.len())
        };
        let ids: Vec<String> = probe.into_iter().take(limit).map(|m| m.id).collect();
        let items = self.load_context_items_by_ids(&ids)?;
        Ok((items, total_matching))
    }

    /// SQL predicate shared by the review count and the read-only review queue.
    fn review_pending_predicate(&self, alias: &str) -> Option<String> {
        let mut parts = Vec::new();
        if self.schema.has_col("nodes", "metadata") {
            parts.push(format!(
                "({alias}.metadata LIKE '%\"reviewStatus\":\"pending\"%' OR {alias}.metadata LIKE '%\"reviewStatus\": \"pending\"%')"
            ));
        }
        if self.schema.has_col("nodes", "quarantine_reason") {
            parts.push(format!("{alias}.quarantine_reason = 'review:pending'"));
        }
        if parts.is_empty() {
            None
        } else {
            Some(parts.join(" OR "))
        }
    }

    /// Count memories awaiting approval (`reviewStatus == 'pending'` / `review:pending`).
    pub fn count_pending_review(&self) -> Result<usize, DbError> {
        if !self.schema.has_table("nodes") {
            return Ok(0);
        }
        let Some(predicate) = self.review_pending_predicate("nodes") else {
            return Ok(0);
        };
        let sql = format!("SELECT COUNT(*) FROM nodes WHERE {predicate}");
        self.exec_count_query(&sql, Vec::new())
    }

    /// List agent-queued memories awaiting approval straight from SQLite.
    ///
    /// Listing never needs the MCP writer, so the Review pane can show what is
    /// waiting while the app is still read-only. Approve/reject stay gated.
    pub fn load_pending_review(&self, limit: usize) -> Result<Vec<ReviewQueueItem>, DbError> {
        if !self.schema.has_table("nodes") || limit == 0 {
            return Ok(Vec::new());
        }
        let Some(predicate) = self.review_pending_predicate("n") else {
            return Ok(Vec::new());
        };
        let id_expr = self
            .schema
            .node_col_expr("n", "id", "CAST(n.rowid AS TEXT)");
        let content_expr = self.schema.node_col_expr("n", "content", "''");
        let summary_expr = self.schema.node_col_expr("n", "summary", "''");
        let type_expr = self.schema.node_col_expr("n", "type", "'fact'");
        let ns_expr = self.schema.node_col_expr("n", "namespace", "'default'");
        let created_expr = self.schema.node_col_expr("n", "created_at", "0");
        let reason_expr = if self.schema.has_col("nodes", "quarantine_reason") {
            "n.quarantine_reason".to_string()
        } else {
            "''".to_string()
        };
        let sql = format!(
            "SELECT {id_expr}, {content_expr}, {summary_expr}, {type_expr}, {ns_expr}, \
                    {created_expr}, {reason_expr} \
             FROM nodes n WHERE {predicate} ORDER BY {created_expr} DESC LIMIT ?1"
        );
        let mut stmt = self
            .conn
            .prepare_cached(&sql)
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        let mut rows = stmt
            .query(rusqlite::params![limit as i64])
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        let mut items = Vec::with_capacity(limit.min(64));
        while let Some(row) = rows.next().map_err(|e| DbError::from_sqlite(&e, false))? {
            let id: String = get_string(row, 0);
            let content: String = get_string(row, 1);
            let summary: String = get_string(row, 2);
            let node_type: String = get_string(row, 3);
            let namespace: String = get_string(row, 4);
            let created_at: i64 = row.get(5).unwrap_or(0);
            let reason: String = get_string(row, 6);
            let preview_source = if summary.trim().is_empty() {
                content.as_str()
            } else {
                summary.as_str()
            };
            items.push(ReviewQueueItem {
                short_id: short_citation_id(&id),
                preview: make_single_line_preview(preview_source, 180),
                content: content.chars().take(4_000).collect(),
                node_type,
                namespace,
                created_at,
                confidence: None,
                reason: {
                    let reason = reason.trim();
                    // `review:pending` is the queue's own marker, not a reason
                    // worth repeating on every row.
                    if reason.is_empty() || reason == "review:pending" {
                        None
                    } else {
                        Some(reason.to_string())
                    }
                },
                id,
            });
        }
        Ok(items)
    }

    /// Distinct nodes matching any Today section. Used for the nav badge so
    /// a memory that is both new and worth-reviewing counts once.
    fn count_brief_unique_nodes(&self, now_ms: i64) -> Result<usize, DbError> {
        const ONE_DAY_MS: i64 = 86_400_000;
        const SEVEN_DAYS_MS: i64 = 7 * 86_400_000;
        let day_ago = now_ms.saturating_sub(ONE_DAY_MS);
        let week_ahead = now_ms.saturating_add(SEVEN_DAYS_MS);
        let filters = [
            QueryFilter {
                created_after_ms: Some(day_ago),
                ..Default::default()
            },
            QueryFilter {
                updated_not_new_after_ms: Some(day_ago),
                ..Default::default()
            },
            QueryFilter {
                expiring_window_ms: Some((now_ms, week_ahead)),
                ..Default::default()
            },
            QueryFilter {
                needs_review_only: true,
                ..Default::default()
            },
        ];
        let mut unions = Vec::new();
        let mut params = Vec::new();
        for filter in &filters {
            let mut conds = Vec::new();
            self.build_filter_where("n", filter, &mut conds, &mut params);
            if !conds.is_empty() {
                unions.push(format!(
                    "SELECT n.id FROM nodes n WHERE {}",
                    conds.join(" AND ")
                ));
            }
        }
        if unions.is_empty() {
            return Ok(0);
        }
        let sql = format!("SELECT COUNT(*) FROM ({})", unions.join(" UNION "));
        self.exec_count_query(&sql, params)
    }

    /// Load the pure SQLite Today / Brief snapshot (`now_ms - 24h`, upcoming 7d expirations,
    /// unresolved contradictions, and inferred/low-trust rows needing review).
    pub fn load_brief(
        &self,
        now_ms: i64,
        contradiction_ids: &HashSet<String>,
        section_limit: usize,
    ) -> Result<BriefSnapshot, DbError> {
        const ONE_DAY_MS: i64 = 86_400_000;
        const SEVEN_DAYS_MS: i64 = 7 * 86_400_000;
        let limit = section_limit.max(1);
        let day_ago = now_ms.saturating_sub(ONE_DAY_MS);
        let week_ahead = now_ms.saturating_add(SEVEN_DAYS_MS);

        if !self.schema.has_table("nodes") {
            return Ok(BriefSnapshot {
                now_ms,
                ..Default::default()
            });
        }

        let new_filter = QueryFilter {
            created_after_ms: Some(day_ago),
            sort: SortOrder::Recency,
            ..Default::default()
        };
        let new_items = self.query_nodes(&new_filter, contradiction_ids, limit)?;
        let new_count = if new_items.len() < limit {
            new_items.len()
        } else {
            self.count_matching_nodes(&new_filter)?.max(new_items.len())
        };

        let changed_filter = QueryFilter {
            updated_not_new_after_ms: Some(day_ago),
            sort: SortOrder::Recency,
            ..Default::default()
        };
        let changed_items = self.query_nodes(&changed_filter, contradiction_ids, limit)?;
        let changed_count = if changed_items.len() < limit {
            changed_items.len()
        } else {
            self.count_matching_nodes(&changed_filter)?
                .max(changed_items.len())
        };

        let expiring_filter = QueryFilter {
            expiring_window_ms: Some((now_ms, week_ahead)),
            sort: SortOrder::Recency,
            ..Default::default()
        };
        let mut expiring_items = self.query_nodes(&expiring_filter, contradiction_ids, limit)?;
        // Also support sorting expiring soonest-first if schema has expires_at
        if self.schema.has_col("nodes", "expires_at") && !expiring_items.is_empty() {
            // Keep SQL selection deterministic by expires_at ASC when possible.
            expiring_items =
                self.query_expiring_nodes_soonest(now_ms, week_ahead, contradiction_ids, limit)?;
        }
        let expiring_count = if expiring_items.len() < limit {
            expiring_items.len()
        } else {
            self.count_matching_nodes(&expiring_filter)?
                .max(expiring_items.len())
        };

        let (contradiction_pairs, contradiction_count) =
            self.load_brief_contradiction_pairs(limit)?;

        let review_filter = QueryFilter {
            needs_review_only: true,
            sort: SortOrder::Recency,
            ..Default::default()
        };
        let needs_review_items = self.query_nodes(&review_filter, contradiction_ids, limit)?;
        let needs_review_count = if needs_review_items.len() < limit {
            needs_review_items.len()
        } else {
            self.count_matching_nodes(&review_filter)?
                .max(needs_review_items.len())
        };

        let unique_count = self
            .count_brief_unique_nodes(now_ms)?
            .saturating_add(contradiction_count);

        Ok(BriefSnapshot {
            now_ms,
            new_items,
            new_count,
            changed_items,
            changed_count,
            expiring_items,
            expiring_count,
            contradiction_pairs,
            contradiction_count,
            needs_review_items,
            needs_review_count,
            unique_count,
        })
    }

    fn query_expiring_nodes_soonest(
        &self,
        now_ms: i64,
        week_ahead: i64,
        contradiction_ids: &HashSet<String>,
        limit: usize,
    ) -> Result<Vec<MemoryListItem>, DbError> {
        if !self.schema.has_col("nodes", "expires_at") {
            return Ok(Vec::new());
        }
        let select = self.list_select_clause("n");
        let id_col = self.id_sort_col("n");
        let exp_ms_expr =
            "(CASE WHEN n.expires_at < 10000000000 THEN n.expires_at * 1000 ELSE n.expires_at END)";
        let sql = format!(
            "SELECT {select} FROM nodes n \
             WHERE n.expires_at IS NOT NULL AND n.expires_at > 0 \
             AND {exp_ms_expr} BETWEEN ? AND ? \
             ORDER BY {exp_ms_expr} ASC, {id_col} DESC LIMIT ?"
        );
        let page = self.execute_list_page_query(
            &sql,
            vec![
                SqlValue::Integer(now_ms),
                SqlValue::Integer(week_ahead),
                SqlValue::Integer(limit as i64),
            ],
            None,
            contradiction_ids,
            limit,
            false,
        )?;
        Ok(page.items)
    }

    fn load_brief_contradiction_pairs(
        &self,
        limit: usize,
    ) -> Result<(Vec<BriefContradictionPair>, usize), DbError> {
        if !self.schema.has_table("contradictions")
            || !self.schema.has_col("contradictions", "node_a")
            || !self.schema.has_col("contradictions", "node_b")
        {
            return Ok((Vec::new(), 0));
        }

        let has_id = self.schema.has_col("contradictions", "id");
        let has_status = self.schema.has_col("contradictions", "status");
        let has_detected = self.schema.has_col("contradictions", "detected_at");
        let has_node_id = self.schema.has_col("nodes", "id");
        if !has_node_id {
            return Ok((Vec::new(), 0));
        }

        let status_where = if has_status {
            "WHERE c.status IS NULL OR LOWER(c.status) NOT IN ('resolved', 'dismissed', 'closed')"
        } else {
            ""
        };
        let count_sql = format!("SELECT COUNT(*) FROM contradictions c {status_where}");
        let total = self.exec_count_query(&count_sql, Vec::new())?;
        if total == 0 {
            return Ok((Vec::new(), 0));
        }

        let id_expr = if has_id {
            "c.id"
        } else {
            "CAST(c.rowid AS TEXT)"
        };
        let status_expr = if has_status {
            "COALESCE(c.status, 'open')"
        } else {
            "'open'"
        };
        let detected_expr = if has_detected {
            "COALESCE(c.detected_at, 0)"
        } else {
            "0"
        };
        let order_expr = if has_detected {
            "c.detected_at DESC, c.rowid DESC"
        } else {
            "c.rowid DESC"
        };
        let prev_a = self.preview_expr("na").replace(" AS preview", " AS pa");
        let prev_b = self.preview_expr("nb").replace(" AS preview", " AS pb");
        let sql = format!(
            "SELECT {id_expr}, c.node_a, {prev_a}, c.node_b, {prev_b}, {status_expr}, {detected_expr} \
             FROM contradictions c \
             LEFT JOIN nodes na ON na.id = c.node_a \
             LEFT JOIN nodes nb ON nb.id = c.node_b \
             {status_where} \
             ORDER BY {order_expr} LIMIT ?"
        );
        let mut stmt = self
            .conn
            .prepare_cached(&sql)
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        let mut rows = stmt
            .query([SqlValue::Integer(limit as i64)])
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| DbError::from_sqlite(&e, false))? {
            let id = get_string(row, 0);
            let node_a_id = get_string(row, 1);
            let raw_a = get_string(row, 2);
            let node_b_id = get_string(row, 3);
            let raw_b = get_string(row, 4);
            let status = get_string_or(row, 5, "open");
            let detected_at = row.get::<_, i64>(6).unwrap_or(0);
            out.push(BriefContradictionPair {
                id,
                node_a_short_id: short_citation_id(&node_a_id),
                node_a_preview: make_single_line_preview(&raw_a, 120),
                node_a_id,
                node_b_short_id: short_citation_id(&node_b_id),
                node_b_preview: make_single_line_preview(&raw_b, 120),
                node_b_id,
                status,
                detected_at,
            });
        }
        let count = total.max(out.len());
        Ok((out, count))
    }

    pub fn count_matching_nodes(&self, filter: &QueryFilter) -> Result<usize, DbError> {
        let mut conds = Vec::new();
        let mut params = Vec::new();
        self.build_filter_where("n", filter, &mut conds, &mut params);

        let trimmed_query = filter.query.trim();
        if trimmed_query.is_empty() {
            let where_sql = if conds.is_empty() {
                String::new()
            } else {
                format!("WHERE {}", conds.join(" AND "))
            };
            let sql = format!("SELECT COUNT(*) FROM nodes n {where_sql}");
            return self.exec_count_query(&sql, params);
        }

        if let Some(prefix) = parse_citation_prefix(trimmed_query)
            && self.schema.has_col("nodes", "id")
        {
            // Must match `query_nodes_by_citation_prefix` exactly, including
            // stripping dashes from UUID ids.
            conds.push("REPLACE(LOWER(n.id), '-', '') LIKE ?".to_string());
            params.push(SqlValue::Text(format!("{prefix}%")));
            let sql = format!("SELECT COUNT(*) FROM nodes n WHERE {}", conds.join(" AND "));
            return self.exec_count_query(&sql, params);
        }

        if self.schema.has_table("nodes_fts") {
            let terms = build_fts_terms(trimmed_query);
            if terms.is_empty() {
                let where_sql = if conds.is_empty() {
                    String::new()
                } else {
                    format!("WHERE {}", conds.join(" AND "))
                };
                let sql = format!("SELECT COUNT(*) FROM nodes n {where_sql}");
                return self.exec_count_query(&sql, params);
            }

            let mut fts_conds = vec!["nodes_fts MATCH ?".to_string()];
            fts_conds.extend(conds.iter().cloned());
            let mut and_params = vec![SqlValue::Text(terms.join(" AND "))];
            and_params.extend(params.iter().cloned());
            let sql = format!(
                "SELECT COUNT(*) FROM nodes n INNER JOIN nodes_fts fts ON fts.rowid = n.rowid WHERE {}",
                fts_conds.join(" AND ")
            );
            let and_count = self.exec_count_query(&sql, and_params)?;
            if and_count > 0 || terms.len() <= 1 {
                return Ok(and_count);
            }

            let mut or_params = vec![SqlValue::Text(terms.join(" OR "))];
            or_params.extend(params);
            return self.exec_count_query(&sql, or_params);
        }

        let escaped = escape_like(trimmed_query);
        let pattern = format!("%{escaped}%");
        let has_content = self.schema.has_col("nodes", "content");
        let has_summary = self.schema.has_col("nodes", "summary");
        match (has_content, has_summary) {
            (true, true) => {
                conds.push(
                    "(LOWER(n.content) LIKE LOWER(?) ESCAPE '\\' OR LOWER(n.summary) LIKE LOWER(?) ESCAPE '\\')"
                        .to_string(),
                );
                params.push(SqlValue::Text(pattern.clone()));
                params.push(SqlValue::Text(pattern));
            }
            (true, false) => {
                conds.push("LOWER(n.content) LIKE LOWER(?) ESCAPE '\\'".to_string());
                params.push(SqlValue::Text(pattern));
            }
            (false, true) => {
                conds.push("LOWER(n.summary) LIKE LOWER(?) ESCAPE '\\'".to_string());
                params.push(SqlValue::Text(pattern));
            }
            (false, false) => conds.push("0 = 1".to_string()),
        }
        let sql = format!("SELECT COUNT(*) FROM nodes n WHERE {}", conds.join(" AND "));
        self.exec_count_query(&sql, params)
    }

    fn exec_count_query(&self, sql: &str, params: Vec<SqlValue>) -> Result<usize, DbError> {
        let mut stmt = self
            .conn
            .prepare_cached(sql)
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        let count: i64 = stmt
            .query_row(rusqlite::params_from_iter(params), |row| row.get(0))
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        Ok(count.max(0) as usize)
    }

    /// Full-text context items for explicit ids (pinned context packs), in the
    /// order given. Missing ids are skipped.
    pub fn load_context_items_by_ids(
        &self,
        ids: &[String],
    ) -> Result<Vec<ContextPreviewItem>, DbError> {
        if ids.is_empty() || !self.schema.has_table("nodes") {
            return Ok(Vec::new());
        }
        let id_expr = self.schema.node_col_expr("n", "id", "CAST(rowid AS TEXT)");
        let content_expr = self.schema.node_col_expr("n", "content", "''");
        let summary_expr = self.schema.node_col_expr("n", "summary", "''");
        let type_expr = self.schema.node_col_expr("n", "type", "'fact'");
        let ns_expr = self.schema.node_col_expr("n", "namespace", "'default'");
        let tags_expr = self.schema.node_col_expr("n", "tags", "'[]'");
        let updated_expr = self.schema.node_col_expr("n", "updated_at", "0");
        let created_expr = self.schema.node_col_expr("n", "created_at", "0");
        let placeholders = vec!["?"; ids.len()].join(", ");
        let sql = format!(
            "SELECT {id_expr}, {content_expr}, {summary_expr}, {type_expr}, {ns_expr}, \
             {tags_expr}, {updated_expr}, {created_expr} \
             FROM nodes n WHERE {id_expr} IN ({placeholders})"
        );

        let mut stmt = self
            .conn
            .prepare(&sql)
            .map_err(|e| DbError::from_sqlite(&e, false))?;
        let params: Vec<SqlValue> = ids.iter().cloned().map(SqlValue::Text).collect();
        let mut rows = stmt
            .query(rusqlite::params_from_iter(params))
            .map_err(|e| DbError::from_sqlite(&e, false))?;

        let mut by_id: HashMap<String, ContextPreviewItem> = HashMap::with_capacity(ids.len());
        while let Some(row) = rows.next().map_err(|e| DbError::from_sqlite(&e, false))? {
            let id = get_string(row, 0);
            let content = get_string(row, 1);
            let summary = get_string(row, 2);
            let node_type = get_string_or(row, 3, "fact");
            let namespace = get_string_or(row, 4, "default");
            let mut tags = parse_tags_json(&get_string_or(row, 5, "[]"));
            if tags.is_empty() && self.schema.has_table("node_tags") {
                tags = self.load_tags_for_node(&id).unwrap_or_default();
            }
            let updated_at = row.get::<_, Option<i64>>(6).ok().flatten().unwrap_or(0);
            let created_at = row.get::<_, Option<i64>>(7).ok().flatten().unwrap_or(0);
            let short_id = short_citation_id(&id);
            by_id.insert(
                id.clone(),
                ContextPreviewItem {
                    id,
                    short_id,
                    node_type,
                    namespace,
                    content,
                    summary,
                    tags,
                    updated_at: if updated_at > 0 {
                        updated_at
                    } else {
                        created_at
                    },
                },
            );
        }

        let mut ordered = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(item) = by_id.remove(id) {
                ordered.push(item);
            }
        }
        Ok(ordered)
    }
}

fn accumulate_bucket(
    buckets: &mut BTreeMap<String, (usize, i64, bool)>,
    key: &str,
    created_at: i64,
    has_contra: bool,
) {
    if let Some(entry) = buckets.get_mut(key) {
        entry.0 += 1;
        entry.1 = entry.1.max(created_at);
        entry.2 |= has_contra;
    } else {
        buckets.insert(key.to_string(), (1, created_at, has_contra));
    }
}

fn row_str<'a>(row: &'a Row<'_>, idx: usize) -> Option<&'a str> {
    match row.get_ref(idx) {
        Ok(rusqlite::types::ValueRef::Text(bytes)) => std::str::from_utf8(bytes).ok(),
        _ => None,
    }
}

fn intern_slice(cache: &mut HashMap<String, Arc<str>>, slice: &str) -> Arc<str> {
    if let Some(existing) = cache.get(slice) {
        return existing.clone();
    }
    let shared: Arc<str> = Arc::from(slice);
    cache.insert(slice.to_string(), shared.clone());
    shared
}

fn unix_ts_to_year_month(raw_ts: i64) -> Option<(i32, u8)> {
    let secs = if raw_ts < 10_000_000_000 {
        raw_ts
    } else {
        raw_ts.div_euclid(1000)
    };
    let days = secs.div_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    if !(-9999..=9999).contains(&year) {
        return None;
    }
    Some((year as i32, m as u8))
}

fn link_group_chains(
    nodes: &[GraphNodeData],
    edges: &mut Vec<GraphEdgeData>,
    seen_pairs: &mut HashSet<(usize, usize)>,
    relation: &str,
) {
    let mut prev_in_group: HashMap<&str, usize> = HashMap::new();
    for (idx, node) in nodes.iter().enumerate() {
        if node.memory_id.is_none() {
            continue;
        }
        if let Some(prev) = prev_in_group.insert(node.group.as_str(), idx) {
            let key = if prev < idx { (prev, idx) } else { (idx, prev) };
            if seen_pairs.insert(key) {
                edges.push(GraphEdgeData {
                    source_idx: prev,
                    target_idx: idx,
                    relation: relation.to_string(),
                    weight: 0.25,
                    is_contradiction: false,
                });
            }
        }
    }
}

fn cluster_key_for_item(
    mode: GraphMode,
    item: &MemoryListItem,
    entities: &HashMap<String, Vec<Arc<str>>>,
) -> String {
    match mode {
        GraphMode::Namespace | GraphMode::Contradictions => item.namespace.to_string(),
        GraphMode::Tag => item
            .tags
            .first()
            .map(|t| format!("#{t}"))
            .unwrap_or_else(|| "untagged".to_string()),
        GraphMode::Entity => entities
            .get(&item.id)
            .and_then(|list| list.first())
            .map(|s| s.to_string())
            .unwrap_or_else(|| item.namespace.to_string()),
        GraphMode::Temporal => {
            if let Some((year, month)) = unix_ts_to_year_month(item.created_at) {
                format!("{year:04}-{month:02}")
            } else {
                "unknown-date".to_string()
            }
        }
    }
}

fn intern(cache: &mut HashMap<String, Arc<str>>, value: String) -> Arc<str> {
    if let Some(existing) = cache.get(&value) {
        return existing.clone();
    }
    let shared: Arc<str> = Arc::from(value.as_str());
    cache.insert(value, shared.clone());
    shared
}

fn intern_col(
    cache: &mut HashMap<String, Arc<str>>,
    row: &Row<'_>,
    idx: usize,
    default: &str,
) -> Arc<str> {
    let slice = match row.get_ref(idx) {
        Ok(rusqlite::types::ValueRef::Text(bytes)) => match std::str::from_utf8(bytes) {
            Ok(s) if !s.is_empty() => s,
            _ => default,
        },
        _ => default,
    };
    if let Some(existing) = cache.get(slice) {
        return existing.clone();
    }
    let shared: Arc<str> = Arc::from(slice);
    cache.insert(slice.to_string(), shared.clone());
    shared
}

fn first_tag_from_json(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "[]" {
        return None;
    }
    if let Some(after_bracket) = trimmed.strip_prefix('[')
        && let Some(after_quote) = after_bracket.trim_start().strip_prefix('"')
    {
        let mut out = String::new();
        let mut chars = after_quote.chars();
        while let Some(c) = chars.next() {
            match c {
                '"' => {
                    if !out.trim().is_empty() {
                        return Some(out);
                    }
                    break;
                }
                '\\' => {
                    if let Some(esc) = chars.next() {
                        match esc {
                            '\\' | '"' | '/' => out.push(esc),
                            _ => {
                                return parse_tags_json(raw).into_iter().next();
                            }
                        }
                    }
                }
                _ => out.push(c),
            }
        }
    }
    parse_tags_json(raw).into_iter().next()
}

fn classify_tamper_op_for_dream(op: &str) -> crate::core::model::DreamDiffKind {
    use crate::core::model::DreamDiffKind;
    let upper = op.trim().to_ascii_uppercase();
    if upper.contains("MERGE") {
        DreamDiffKind::Merged
    } else if upper.contains("PROMOT") || upper.contains("DREAM") || upper.contains("CONSOLIDAT") {
        DreamDiffKind::Promoted
    } else if upper.contains("DECAY")
        || upper.contains("DEMOT")
        || upper.contains("QUARANTIN")
        || upper.contains("FORGET")
        || upper.contains("EXPIRE")
    {
        DreamDiffKind::Decayed
    } else if upper.contains("CONTRADICT") {
        DreamDiffKind::Contradiction
    } else {
        DreamDiffKind::Updated
    }
}

fn get_string(row: &Row<'_>, idx: usize) -> String {
    row.get::<_, Option<String>>(idx)
        .ok()
        .flatten()
        .unwrap_or_default()
}

fn get_string_or(row: &Row<'_>, idx: usize, default: &str) -> String {
    match row.get::<_, Option<String>>(idx) {
        Ok(Some(s)) if !s.is_empty() => s,
        _ => default.to_string(),
    }
}

fn parse_tags_json(raw: &str) -> Vec<String> {
    if raw.trim().is_empty() || raw.trim() == "[]" {
        return Vec::new();
    }
    serde_json::from_str::<Vec<String>>(raw)
        .unwrap_or_default()
        .into_iter()
        .filter(|t| !t.trim().is_empty())
        .collect()
}

fn escape_like(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

/// Tokenize user query into safe FTS5 search terms (quoted + prefix wildcard for >= 2 chars).
pub fn build_fts_terms(query: &str) -> Vec<String> {
    const STOPWORDS: &[&str] = &[
        "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of",
        "on", "or", "the", "to", "with",
    ];
    let tokens: Vec<String> = query
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(ToOwned::to_owned)
        .collect();

    let non_stop: Vec<String> = tokens
        .iter()
        .filter(|t| t.len() > 1 && !STOPWORDS.contains(&t.as_str()))
        .cloned()
        .collect();
    let effective = if !non_stop.is_empty() {
        non_stop
    } else {
        tokens
    };

    if effective.is_empty() {
        return Vec::new();
    }

    effective
        .into_iter()
        .map(|t| {
            let escaped = t.replace('"', "\"\"");
            if t.len() >= 2 {
                format!("\"{escaped}\"*")
            } else {
                format!("\"{escaped}\"")
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use uuid::Uuid;

    #[test]
    fn opens_read_only_and_rejects_writes() {
        let tmp = env::temp_dir().join(format!("memos-ro-{}.db", Uuid::new_v4()));
        {
            let rw = Connection::open(&tmp).unwrap();
            rw.execute_batch(
                "CREATE TABLE nodes (
                    id TEXT PRIMARY KEY,
                    content TEXT NOT NULL,
                    summary TEXT NOT NULL DEFAULT '',
                    type TEXT NOT NULL DEFAULT 'fact',
                    importance REAL NOT NULL DEFAULT 0.5,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                 );
                 INSERT INTO nodes (id, content, created_at, updated_at)
                 VALUES ('a3f9c2e1-0000-4000-8000-000000000001', 'legacy schema memory', 1700000000000, 1700000000000);",
            )
            .unwrap();
        }

        let store = ReadOnlyStore::open(&tmp).expect("open read-only");
        // Verify PRAGMA query_only is ON and writes fail cleanly.
        let err = store
            .conn
            .execute(
                "INSERT INTO nodes (id, content, created_at, updated_at) VALUES ('x', 'y', 1, 1)",
                [],
            )
            .unwrap_err();
        assert!(matches!(err, rusqlite::Error::SqliteFailure(_, _)));

        // Verify legacy DB missing edges/node_tags/contradictions/nodes_fts still loads!
        let ov = store.load_overview().expect("overview on legacy schema");
        assert_eq!(ov.node_count, 1);
        assert_eq!(ov.edge_count, 0);
        assert!(ov.missing_tables.contains(&"edges".to_string()));
        assert!(ov.missing_tables.contains(&"nodes_fts".to_string()));

        // Verify LIKE fallback search works without nodes_fts!
        let filter = QueryFilter {
            query: "legacy".to_string(),
            ..Default::default()
        };
        let items = store
            .query_nodes(&filter, &ov.contradiction_node_ids, 100)
            .expect("query fallback");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].short_id.as_ref(), "a3f9");

        let detail = store
            .load_node_detail("a3f9c2e1-0000-4000-8000-000000000001")
            .unwrap()
            .unwrap();
        assert_eq!(detail.citation_token, "[mem:a3f9]");

        drop(store);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn lists_pending_review_from_sqlite_without_the_writer() {
        let tmp = env::temp_dir().join(format!("memos-review-{}.db", Uuid::new_v4()));
        {
            let rw = Connection::open(&tmp).unwrap();
            rw.execute_batch(
                "CREATE TABLE nodes (
                    id TEXT PRIMARY KEY,
                    content TEXT NOT NULL,
                    summary TEXT NOT NULL DEFAULT '',
                    type TEXT NOT NULL DEFAULT 'fact',
                    namespace TEXT NOT NULL DEFAULT 'default',
                    created_at INTEGER NOT NULL,
                    metadata TEXT NOT NULL DEFAULT '{}',
                    quarantine_reason TEXT
                 );
                 INSERT INTO nodes (id, content, type, namespace, created_at, metadata) VALUES
                   ('11111111-0000-4000-8000-000000000001', 'queued by an agent', 'decision', 'work', 1700000000000,
                    '{\"reviewStatus\":\"pending\"}'),
                   ('22222222-0000-4000-8000-000000000002', 'queued with spacing', 'fact', 'personal', 1700000001000,
                    '{\"reviewStatus\": \"pending\"}');
                 INSERT INTO nodes (id, content, created_at) VALUES
                   ('33333333-0000-4000-8000-000000000003', 'already settled', 1700000002000);",
            )
            .unwrap();
        }

        let store = ReadOnlyStore::open(&tmp).expect("open read-only");
        assert_eq!(store.count_pending_review().unwrap(), 2);

        let items = store.load_pending_review(10).unwrap();
        assert_eq!(items.len(), 2);
        // Newest first, previews usable, and no MCP writer involved.
        assert_eq!(items[0].id, "22222222-0000-4000-8000-000000000002");
        assert_eq!(items[0].preview, "queued with spacing");
        assert_eq!(items[0].short_id, "2222");
        assert_eq!(items[1].namespace, "work");
        assert!(store.load_pending_review(0).unwrap().is_empty());

        drop(store);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn legacy_tag_filter_matches_json_exactly_without_node_tags() {
        let tmp = env::temp_dir().join(format!("memos-legacy-tags-{}.db", Uuid::new_v4()));
        {
            let rw = Connection::open(&tmp).unwrap();
            rw.execute_batch(
                "CREATE TABLE nodes (
                    id TEXT PRIMARY KEY,
                    content TEXT NOT NULL,
                    summary TEXT NOT NULL DEFAULT '',
                    type TEXT NOT NULL DEFAULT 'fact',
                    tags TEXT NOT NULL DEFAULT '[]',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                 );
                 INSERT INTO nodes (id, content, tags, created_at, updated_at) VALUES
                   ('11111111-0000-4000-8000-000000000001', 'has rust', '[\"rust\",\"gpui\"]', 1700000000000, 1700000000000),
                   ('22222222-0000-4000-8000-000000000002', 'different tag', '[\"rust-lang\"]', 1700000001000, 1700000001000),
                   ('33333333-0000-4000-8000-000000000003', 'percent tag', '[\"100%\"]', 1700000002000, 1700000002000);",
            )
            .unwrap();
        }

        let store = ReadOnlyStore::open(&tmp).expect("open legacy store");
        assert!(!store.schema().has_table("node_tags"));

        let exact = store
            .query_nodes(
                &QueryFilter {
                    tag: Some("rust".to_string()),
                    ..Default::default()
                },
                &HashSet::new(),
                10,
            )
            .expect("exact tag");
        assert_eq!(exact.len(), 1);
        assert_eq!(exact[0].short_id.as_ref(), "1111");
        assert_eq!(
            store
                .count_matching_nodes(&QueryFilter {
                    tag: Some("rust".to_string()),
                    ..Default::default()
                })
                .unwrap(),
            1
        );

        // LIKE wildcards must be literal here.
        let percent = store
            .query_nodes(
                &QueryFilter {
                    tag: Some("100%".to_string()),
                    ..Default::default()
                },
                &HashSet::new(),
                10,
            )
            .expect("percent tag");
        assert_eq!(percent.len(), 1);

        drop(store);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn keyset_pagination_works_without_timestamp_columns() {
        let tmp = env::temp_dir().join(format!("memos-no-ts-{}.db", Uuid::new_v4()));
        {
            let rw = Connection::open(&tmp).unwrap();
            rw.execute_batch(
                "CREATE TABLE nodes (
                    id TEXT PRIMARY KEY,
                    content TEXT NOT NULL
                 );
                 INSERT INTO nodes (id, content) VALUES
                   ('a', 'first'), ('b', 'second'), ('c', 'third');",
            )
            .unwrap();
        }

        let store = ReadOnlyStore::open(&tmp).expect("open legacy store");
        let filter = QueryFilter {
            sort: SortOrder::Recency,
            ..Default::default()
        };
        let page1 = store
            .query_nodes_page(&filter, &HashSet::new(), None, 2)
            .expect("page 1");
        assert_eq!(page1.items.len(), 2);
        assert!(page1.has_more);
        let page2 = store
            .query_nodes_page(&filter, &HashSet::new(), page1.next_cursor.as_ref(), 2)
            .expect("page 2");
        assert_eq!(page2.items.len(), 1);
        assert!(!page2.has_more);
        let all: HashSet<&str> = page1
            .items
            .iter()
            .chain(page2.items.iter())
            .map(|i| i.id.as_str())
            .collect();
        assert_eq!(all.len(), 3, "pages must not duplicate rows");

        drop(store);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn filters_sorts_citation_prefix_details_and_all_five_graph_modes() {
        let tmp = env::temp_dir().join(format!("memos-rich-{}.db", Uuid::new_v4()));
        {
            let mut conn = Connection::open(&tmp).unwrap();
            conn.execute_batch(
                "CREATE TABLE nodes (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    content TEXT NOT NULL,
                    summary TEXT NOT NULL DEFAULT '',
                    importance REAL NOT NULL DEFAULT 0.5,
                    confidence REAL NOT NULL DEFAULT 0.9,
                    evidence_count INTEGER NOT NULL DEFAULT 1,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    access_count INTEGER NOT NULL DEFAULT 0,
                    last_accessed INTEGER NOT NULL DEFAULT 0,
                    valid_from INTEGER,
                    valid_to INTEGER,
                    expires_at INTEGER,
                    metadata TEXT DEFAULT '{}',
                    namespace TEXT NOT NULL DEFAULT 'default',
                    source TEXT NOT NULL DEFAULT 'cli',
                    harness TEXT NOT NULL DEFAULT 'codex',
                    provenance TEXT NOT NULL DEFAULT 'user-verified',
                    trust_score REAL NOT NULL DEFAULT 0.8,
                    quarantined INTEGER NOT NULL DEFAULT 0,
                    quarantined_at INTEGER,
                    quarantine_reason TEXT
                 );
                 CREATE TABLE edges (
                    id TEXT PRIMARY KEY,
                    source_id TEXT NOT NULL,
                    target_id TEXT NOT NULL,
                    relation TEXT NOT NULL,
                    weight REAL DEFAULT 1.0,
                    created_at INTEGER NOT NULL
                 );
                 CREATE TABLE node_tags (node_id TEXT NOT NULL, tag TEXT NOT NULL);
                 CREATE TABLE contradictions (
                    id TEXT PRIMARY KEY,
                    node_a TEXT NOT NULL,
                    node_b TEXT NOT NULL,
                    status TEXT DEFAULT 'open',
                    detected_at INTEGER NOT NULL
                 );
                 CREATE TABLE entity_index (entity TEXT NOT NULL, node_id TEXT NOT NULL);
                 CREATE VIRTUAL TABLE nodes_fts USING fts5(content, summary, content='nodes', content_rowid='rowid');",
            )
            .unwrap();

            let tx = conn.transaction().unwrap();
            for i in 0..2_050 {
                let id = format!("{i:04}abcd-0000-4000-8000-000000000001");
                let ns = if i % 2 == 0 { "work" } else { "personal" };
                let ty = if i % 3 == 0 { "decision" } else { "fact" };
                let prov = if i == 0 {
                    "agent-inferred"
                } else {
                    "user-verified"
                };
                let imp = if i == 1 {
                    0.99
                } else {
                    0.3 + (i % 5) as f32 * 0.1
                };
                let trust = if i == 2 { 0.99 } else { 0.5 };
                let ts = 1_700_000_000_000_i64 + (i as i64) * 100_000;
                tx.execute(
                    "INSERT INTO nodes (id, type, content, summary, importance, trust_score, created_at, updated_at, namespace, provenance)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9)",
                    rusqlite::params![
                        id,
                        ty,
                        format!("Memory content #{i} about Apollo engine"),
                        format!("Summary #{i}"),
                        imp,
                        trust,
                        ts,
                        ns,
                        prov
                    ],
                )
                .unwrap();
                tx.execute(
                    "INSERT INTO node_tags (node_id, tag) VALUES (?1, ?2)",
                    rusqlite::params![id, if i % 2 == 0 { "rust" } else { "sqlite" }],
                )
                .unwrap();
                if i < 10 {
                    tx.execute(
                        "INSERT INTO entity_index (entity, node_id) VALUES (?1, ?2)",
                        rusqlite::params!["Apollo", id],
                    )
                    .unwrap();
                }
            }
            tx.execute(
                "INSERT INTO edges (id, source_id, target_id, relation, weight, created_at)
                 VALUES ('e1', '0000abcd-0000-4000-8000-000000000001', '0001abcd-0000-4000-8000-000000000001', 'supports', 0.9, 1700000000000)",
                [],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO contradictions (id, node_a, node_b, status, detected_at)
                 VALUES ('c1', '0000abcd-0000-4000-8000-000000000001', '0002abcd-0000-4000-8000-000000000001', 'open', 1700000000000)",
                [],
            )
            .unwrap();
            tx.execute_batch("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild');")
                .unwrap();
            tx.commit().unwrap();
        }

        let store = ReadOnlyStore::open(&tmp).unwrap();
        let ov = store.load_overview().unwrap();
        assert_eq!(ov.node_count, 2_050);
        assert_eq!(ov.contradiction_node_ids.len(), 2);

        // Filters & sorts
        let cite = store
            .query_nodes(
                &QueryFilter {
                    query: "[mem:0001]".to_string(),
                    ..Default::default()
                },
                &ov.contradiction_node_ids,
                50,
            )
            .unwrap();
        assert_eq!(cite.len(), 1);
        assert_eq!(cite[0].short_id.as_ref(), "0001");

        let by_imp = store
            .query_nodes(
                &QueryFilter {
                    sort: SortOrder::Importance,
                    namespace: Some("personal".to_string()),
                    ..Default::default()
                },
                &ov.contradiction_node_ids,
                10,
            )
            .unwrap();
        assert_eq!(by_imp[0].short_id.as_ref(), "0001");

        let by_trust = store
            .query_nodes(
                &QueryFilter {
                    sort: SortOrder::Trust,
                    tag: Some("rust".to_string()),
                    ..Default::default()
                },
                &ov.contradiction_node_ids,
                10,
            )
            .unwrap();
        assert_eq!(by_trust[0].short_id.as_ref(), "0002");

        let contras = store
            .query_nodes(
                &QueryFilter {
                    has_contradiction: true,
                    ..Default::default()
                },
                &ov.contradiction_node_ids,
                10,
            )
            .unwrap();
        assert_eq!(contras.len(), 2);

        let prov_filtered = store
            .query_nodes(
                &QueryFilter {
                    provenance: Some("agent-inferred".to_string()),
                    node_type: Some("decision".to_string()),
                    ..Default::default()
                },
                &ov.contradiction_node_ids,
                10,
            )
            .unwrap();
        assert_eq!(prov_filtered.len(), 1);
        assert_eq!(prov_filtered[0].short_id.as_ref(), "0000");

        let detail = store
            .load_node_detail("0000abcd-0000-4000-8000-000000000001")
            .unwrap()
            .unwrap();
        assert_eq!(detail.edges.len(), 1);
        assert_eq!(detail.contradictions.len(), 1);

        // Graph clustering cap & all 5 modes
        for mode in GraphMode::ALL {
            let snap = store
                .load_graph_snapshot(
                    mode,
                    &QueryFilter::default(),
                    &ov.contradiction_node_ids,
                    DEFAULT_GRAPH_NODE_CAP,
                )
                .unwrap();
            assert!(snap.nodes.len() <= DEFAULT_GRAPH_NODE_CAP);
            if mode == GraphMode::Contradictions {
                assert_eq!(snap.total_matching_nodes, 2);
                assert_eq!(snap.clustered_nodes, 0);
            } else {
                assert_eq!(snap.total_matching_nodes, 2_050);
                assert!(snap.clustered_nodes >= 50);
            }
        }

        drop(store);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn unix_ts_to_year_month_matches_offset_datetime() {
        for secs in [
            0i64,
            86_399,
            86_400,
            951_782_400,       // 2000-02-29 leap year
            1_709_164_800,     // 2024-02-29 leap year
            1_709_251_200,     // 2024-03-01
            4_102_444_800,     // 2100-01-01 non-leap century
            1_700_000_000_000, // ms timestamp
        ] {
            let ms = if secs < 10_000_000_000 {
                secs * 1000
            } else {
                secs
            };
            let dt = time::OffsetDateTime::from_unix_timestamp(ms.div_euclid(1000)).unwrap();
            let got = unix_ts_to_year_month(secs).unwrap();
            assert_eq!(got, (dt.year(), u8::from(dt.month())), "for {secs}");
        }
    }

    #[test]
    fn health_stats_and_diagnostic_filters_query_cleanly() {
        let tmp =
            std::env::temp_dir().join(format!("memos_gpui_health_diag_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        {
            let conn = Connection::open(&tmp).unwrap();
            conn.execute_batch(
                "
                CREATE TABLE nodes (
                    id TEXT PRIMARY KEY,
                    type TEXT,
                    namespace TEXT,
                    content TEXT,
                    summary TEXT,
                    importance REAL,
                    trust_score REAL,
                    quarantined INTEGER,
                    provenance TEXT,
                    created_at INTEGER,
                    updated_at INTEGER,
                    expires_at INTEGER
                );
                CREATE TABLE edges (id TEXT PRIMARY KEY, source_id TEXT, target_id TEXT, relation TEXT, weight REAL);
                CREATE TABLE contradictions (id TEXT PRIMARY KEY, node_a TEXT, node_b TEXT, reason TEXT, resolved INTEGER);
                ",
            )
            .unwrap();
            let now = 1_800_000_000_000_i64;
            let old = now - 100 * 86_400_000;
            conn.execute(
                "INSERT INTO nodes VALUES (?1, 'fact', 'default', 'dup body', 'dup', 0.8, 0.9, 0, 'manual', ?2, ?2, NULL)",
                rusqlite::params!["n-1", now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO nodes VALUES (?1, 'fact', 'default', 'dup body', 'dup', 0.8, 0.9, 0, 'manual', ?2, ?2, NULL)",
                rusqlite::params!["n-2", now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO nodes VALUES (?1, 'fact', 'default', 'stale low trust', 'stale', 0.5, 0.25, 0, 'drifted', ?2, ?2, NULL)",
                rusqlite::params!["n-3", old],
            )
            .unwrap();
            conn.execute("UPDATE nodes SET quarantined = 1 WHERE id = 'n-1'", []).unwrap();
        }

        let store = ReadOnlyStore::open(&tmp).unwrap();
        let now = 1_800_000_000_000_i64;
        let cutoff = now - 90 * 86_400_000;
        let raw = store.load_health_raw_stats(now, cutoff).unwrap();
        assert_eq!(raw.duplicate_count, 1);
        assert_eq!(raw.low_trust_count, 1);
        assert_eq!(raw.stale_count, 1);

        let no_contras = std::collections::HashSet::new();
        let dups = store
            .query_nodes(
                &QueryFilter {
                    duplicates_only: true,
                    ..Default::default()
                },
                &no_contras,
                10,
            )
            .unwrap();
        assert_eq!(dups.len(), 2);

        let low_trust = store
            .query_nodes(
                &QueryFilter {
                    max_trust: Some(0.5),
                    ..Default::default()
                },
                &no_contras,
                10,
            )
            .unwrap();
        assert_eq!(low_trust.len(), 1);
        assert_eq!(low_trust[0].id, "n-3");

        let stale = store
            .query_nodes(
                &QueryFilter {
                    stale_before_ms: Some(cutoff),
                    ..Default::default()
                },
                &no_contras,
                10,
            )
            .unwrap();
        assert_eq!(stale.len(), 2);
        let untouched = store.query_nodes(&QueryFilter {
            updated_before_ms: Some(cutoff),
            ..Default::default()
        }, &no_contras, 10).unwrap();
        assert_eq!(untouched.len(), raw.stale_count);
        assert_eq!(untouched[0].id, "n-3");

        drop(store);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn loads_tamper_receipts_and_legacy_schema_gracefully() {
        let tmp = std::env::temp_dir().join(format!(
            "memos_gpui_tamper_receipts_{}.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&tmp);
        {
            let conn = Connection::open(&tmp).unwrap();
            conn.execute_batch(
                "CREATE TABLE nodes (
                    id TEXT PRIMARY KEY,
                    content TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                INSERT INTO nodes VALUES ('node-alpha-001', 'Verified fact', 1000, 2000);",
            )
            .unwrap();
        }

        // Legacy/minimal DB without tamper_log must still return detail with empty receipts.
        let store = ReadOnlyStore::open(&tmp).unwrap();
        let minimal = store.load_node_detail("node-alpha-001").unwrap().unwrap();
        assert!(minimal.receipts.is_empty());
        drop(store);

        // Full schema with tamper_log returns latest receipts newest-first.
        {
            let conn = Connection::open(&tmp).unwrap();
            conn.execute_batch(
                "CREATE TABLE tamper_log (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts INTEGER NOT NULL,
                    op TEXT NOT NULL,
                    node_id TEXT NOT NULL,
                    node_hash TEXT NOT NULL,
                    prev_hash TEXT NOT NULL,
                    entry_hash TEXT NOT NULL
                );
                INSERT INTO tamper_log (ts, op, node_id, node_hash, prev_hash, entry_hash) VALUES
                    (1500, 'INSERT', 'node-alpha-001', 'abcd111122223333', '0000', 'e1111111aaaa'),
                    (2500, 'PROMOTE', 'node-alpha-001', 'efgh444455556666', 'e1111111aaaa', 'e2222222bbbb');",
            )
            .unwrap();
        }

        let store = ReadOnlyStore::open(&tmp).unwrap();
        let detail = store.load_node_detail("node-alpha-001").unwrap().unwrap();
        assert_eq!(detail.receipts.len(), 2);
        assert_eq!(detail.receipts[0].op, "PROMOTE");
        assert_eq!(detail.receipts[0].seq, 2);
        assert_eq!(detail.receipts[1].op, "INSERT");
        assert_eq!(detail.receipts[0].entry_hash, "e2222222bbbb");

        drop(store);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn loads_dream_diff_from_rich_and_legacy_schemas() {
        use crate::core::model::DreamDiffKind;

        let tmp = env::temp_dir().join(format!(
            "memos_gpui_dream_diff_{}_{}.db",
            std::process::id(),
            Uuid::new_v4()
        ));
        let _ = std::fs::remove_file(&tmp);
        {
            let conn = Connection::open(&tmp).unwrap();
            conn.execute_batch(
                "CREATE TABLE nodes (
                    id TEXT PRIMARY KEY,
                    content TEXT NOT NULL,
                    summary TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    quarantined INTEGER NOT NULL DEFAULT 0,
                    quarantined_at INTEGER,
                    quarantine_reason TEXT
                );
                INSERT INTO nodes VALUES
                    ('n-promoted', 'Promoted memory body', 'Promoted summary', 1000, 2000, 0, NULL, NULL),
                    ('n-decayed', 'Old stale claim', 'Old stale claim', 500, 1500, 1, 3500, 'expired source'),
                    ('n-conflict', 'Disputed API port', 'Disputed API port', 1200, 1200, 0, NULL, NULL);",
            )
            .unwrap();
        }

        // Works cleanly with minimal nodes table before tamper_log/edges/contradictions exist.
        let store = ReadOnlyStore::open(&tmp).unwrap();
        let initial = store.load_dream_diff(50).unwrap();
        assert!(
            initial
                .iter()
                .any(|e| e.kind == DreamDiffKind::Decayed && e.node_id == "n-decayed")
        );
        assert!(
            initial
                .iter()
                .any(|e| e.kind == DreamDiffKind::Updated && e.node_id == "n-promoted")
        );
        drop(store);

        // Rich schema combines tamper_log, contradictions, and consolidation edges.
        {
            let conn = Connection::open(&tmp).unwrap();
            conn.execute_batch(
                "CREATE TABLE tamper_log (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts INTEGER NOT NULL,
                    op TEXT NOT NULL,
                    node_id TEXT NOT NULL,
                    node_hash TEXT NOT NULL,
                    prev_hash TEXT NOT NULL,
                    entry_hash TEXT NOT NULL
                );
                CREATE TABLE edges (
                    id TEXT PRIMARY KEY,
                    source_id TEXT NOT NULL,
                    target_id TEXT NOT NULL,
                    relation TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE contradictions (
                    id TEXT PRIMARY KEY,
                    node_a TEXT NOT NULL,
                    node_b TEXT NOT NULL,
                    detected_at INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'unresolved'
                );
                INSERT INTO tamper_log (ts, op, node_id, node_hash, prev_hash, entry_hash) VALUES
                    (4000, 'PROMOTE', 'n-promoted', 'abcd1234ef', '0000', 'e111');
                INSERT INTO edges VALUES
                    ('e1', 'n-promoted', 'n-decayed', 'merged_from', 4500);
                INSERT INTO contradictions VALUES
                    ('c1', 'n-conflict', 'n-promoted', 5000, 'unresolved');",
            )
            .unwrap();
        }

        let store = ReadOnlyStore::open(&tmp).unwrap();
        let rich = store.load_dream_diff(50).unwrap();
        assert_eq!(rich[0].timestamp, 5000);
        assert_eq!(rich[0].kind, DreamDiffKind::Contradiction);
        assert!(
            rich.iter()
                .any(|e| e.kind == DreamDiffKind::Merged && e.node_id == "n-promoted")
        );
        assert!(
            rich.iter()
                .any(|e| e.kind == DreamDiffKind::Promoted && e.node_id == "n-promoted")
        );
        assert!(
            rich.iter()
                .any(|e| e.kind == DreamDiffKind::Decayed && e.node_id == "n-decayed")
        );

        drop(store);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn context_preview_loader_caps_items_preserves_sort_and_reports_total_matching() {
        let tmp = env::temp_dir().join(format!("memos-ctx-loader-{}.db", Uuid::new_v4()));
        {
            let conn = Connection::open(&tmp).unwrap();
            conn.execute_batch(
                "CREATE TABLE nodes (
                    id TEXT PRIMARY KEY,
                    type TEXT,
                    content TEXT,
                    summary TEXT,
                    namespace TEXT,
                    importance REAL,
                    trust_score REAL,
                    created_at INTEGER,
                    updated_at INTEGER
                );",
            )
            .unwrap();
            for i in 0..18 {
                conn.execute(
                    "INSERT INTO nodes (id, type, content, summary, namespace, importance, trust_score, created_at, updated_at)
                     VALUES (?1, 'decision', ?2, ?3, 'auth', ?4, 0.9, ?5, ?5)",
                    rusqlite::params![
                        format!("ctx-{i:04}"),
                        format!("Full content for node {i}"),
                        if i % 2 == 0 {
                            format!("Distinct summary {i}")
                        } else {
                            format!("Full content for node {i}")
                        },
                        0.1 + (i as f64) * 0.04,
                        1_700_000_000_000_i64 + i,
                    ],
                )
                .unwrap();
            }
        }

        let store = ReadOnlyStore::open(&tmp).unwrap();
        let filter = QueryFilter {
            namespace: Some("auth".to_string()),
            sort: SortOrder::Importance,
            ..Default::default()
        };
        let (items, total) = store
            .load_context_items_for_filter(&filter, &HashSet::new(), 12)
            .unwrap();
        assert_eq!(items.len(), 12);
        assert_eq!(total, 18);
        // Highest importance row (ctx-0017) must come first under Importance sort.
        assert_eq!(items[0].content, "Full content for node 17");
        drop(store);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn writer_preflight_detects_missing_edges_metadata_and_accepts_full_schema() {
        let tmp_old = env::temp_dir().join(format!("memos-preflight-old-{}.db", Uuid::new_v4()));
        {
            let conn = Connection::open(&tmp_old).unwrap();
            conn.execute_batch(
                "CREATE TABLE nodes (
                    id TEXT PRIMARY KEY,
                    content TEXT,
                    metadata TEXT DEFAULT '{}',
                    valid_from INTEGER,
                    valid_to INTEGER
                 );
                 CREATE TABLE edges (
                    id TEXT PRIMARY KEY,
                    source_id TEXT,
                    target_id TEXT,
                    relation TEXT,
                    valid_from INTEGER,
                    valid_to INTEGER
                 );
                 CREATE TABLE node_tags (node_id TEXT, tag TEXT);
                 CREATE TABLE contradictions (id TEXT PRIMARY KEY, node_a TEXT, node_b TEXT);",
            )
            .unwrap();
        }
        let store_old = ReadOnlyStore::open(&tmp_old).unwrap();
        let pf_old = store_old.schema().check_writer_preflight();
        assert!(!pf_old.compatible);
        assert_eq!(pf_old.missing, vec!["edges.metadata".to_string()]);
        let msg = pf_old.human_message().unwrap();
        assert!(msg.contains("missing edges.metadata"), "got: {msg}");
        assert!(msg.contains("memos init"), "got: {msg}");
        drop(store_old);
        let _ = std::fs::remove_file(&tmp_old);

        let tmp_ok = env::temp_dir().join(format!("memos-preflight-ok-{}.db", Uuid::new_v4()));
        {
            let conn = Connection::open(&tmp_ok).unwrap();
            conn.execute_batch(
                "CREATE TABLE nodes (
                    id TEXT PRIMARY KEY,
                    content TEXT,
                    metadata TEXT DEFAULT '{}',
                    valid_from INTEGER,
                    valid_to INTEGER
                 );
                 CREATE TABLE edges (
                    id TEXT PRIMARY KEY,
                    source_id TEXT,
                    target_id TEXT,
                    relation TEXT,
                    metadata TEXT DEFAULT '{}',
                    valid_from INTEGER,
                    valid_to INTEGER
                 );
                 CREATE TABLE node_tags (node_id TEXT, tag TEXT);
                 CREATE TABLE contradictions (id TEXT PRIMARY KEY, node_a TEXT, node_b TEXT);",
            )
            .unwrap();
        }
        let store_ok = ReadOnlyStore::open(&tmp_ok).unwrap();
        let pf_ok = store_ok.schema().check_writer_preflight();
        assert!(pf_ok.compatible);
        assert!(pf_ok.human_message().is_none());
        drop(store_ok);
        let _ = std::fs::remove_file(&tmp_ok);
    }

    #[test]
    fn keyset_pagination_has_no_gaps_or_duplicates_across_sorts_and_search() {
        let tmp = env::temp_dir().join(format!("memos-keyset-page-{}.db", Uuid::new_v4()));
        {
            let mut conn = Connection::open(&tmp).unwrap();
            conn.execute_batch(
                "CREATE TABLE nodes (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    content TEXT NOT NULL,
                    summary TEXT,
                    importance REAL,
                    trust_score REAL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    namespace TEXT DEFAULT 'default',
                    provenance TEXT DEFAULT 'user',
                    source TEXT DEFAULT 'cli',
                    harness TEXT DEFAULT 'codex',
                    tags TEXT DEFAULT '[]',
                    quarantined INTEGER DEFAULT 0
                 );
                 CREATE VIRTUAL TABLE nodes_fts USING fts5(content, summary, content='nodes', content_rowid='rowid');",
            )
            .unwrap();
            let tx = conn.transaction().unwrap();
            {
                let mut ins = tx
                    .prepare(
                        "INSERT INTO nodes (id, type, content, summary, importance, trust_score, created_at, updated_at)
                         VALUES (?1, 'fact', ?2, '', ?3, ?4, ?5, ?6)",
                    )
                    .unwrap();
                // Insert 620 nodes with deliberate ties on updated_at, importance, and trust_score.
                for i in 0..620usize {
                    let id = format!("{:08x}-0000-4000-8000-{:012x}", i + 1, i + 1);
                    let topic = if i % 2 == 0 { "apollo" } else { "beacon" };
                    let content = format!("Keyset pagination node {i:04} about {topic}");
                    let imp = ((i % 7) as f64) * 0.15;
                    let trust = 0.25 + ((i % 5) as f64) * 0.15;
                    let ts = 1_700_000_000_000_i64 + ((i / 10) as i64) * 1000;
                    ins.execute(rusqlite::params![id, content, imp, trust, ts, ts])
                        .unwrap();
                }
            }
            tx.execute_batch("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild');")
                .unwrap();
            tx.commit().unwrap();
        }

        let store = ReadOnlyStore::open(&tmp).unwrap();
        let empty = HashSet::new();

        for (sort, query) in [
            (SortOrder::Recency, ""),
            (SortOrder::Importance, ""),
            (SortOrder::Trust, ""),
            (SortOrder::Recency, "apollo"),
            (SortOrder::Importance, "apollo"),
            (SortOrder::Recency, "apollo nonexistenttoken"),
        ] {
            let filter = QueryFilter {
                query: query.to_string(),
                sort,
                ..Default::default()
            };
            let expected = store.count_matching_nodes(&filter).unwrap();
            let mut seen = HashSet::new();
            let mut collected = Vec::new();
            let mut cursor = None;
            let mut first_page = true;
            loop {
                let page_limit = if first_page { 210 } else { 130 };
                first_page = false;
                let page = store
                    .query_nodes_page(&filter, &empty, cursor.as_ref(), page_limit)
                    .unwrap();
                for item in page.items {
                    assert!(
                        seen.insert(item.id.clone()),
                        "duplicate id {} under sort={sort:?} query={query}",
                        item.id
                    );
                    collected.push(item);
                }
                if !page.has_more {
                    assert!(page.next_cursor.is_none());
                    break;
                }
                assert!(page.next_cursor.is_some());
                cursor = page.next_cursor;
            }
            assert_eq!(
                collected.len(),
                expected,
                "row count mismatch under sort={sort:?} query={query}"
            );
            for pair in collected.windows(2) {
                let (a, b) = (&pair[0], &pair[1]);
                let ordered = match sort {
                    SortOrder::Recency => {
                        a.updated_at > b.updated_at || (a.updated_at == b.updated_at && a.id > b.id)
                    }
                    SortOrder::Importance => {
                        a.importance > b.importance
                            || ((a.importance - b.importance).abs() <= f32::EPSILON && a.id > b.id)
                    }
                    SortOrder::Trust => {
                        a.trust_score > b.trust_score
                            || ((a.trust_score - b.trust_score).abs() <= f32::EPSILON
                                && a.id > b.id)
                    }
                };
                assert!(
                    ordered,
                    "sort order broken between {} and {} under {sort:?}",
                    a.id, b.id
                );
            }
        }

        drop(store);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn brief_snapshot_classifies_five_sections_at_fixed_timestamps_and_empty_state() {
        let now_ms = 1_793_577_600_000_i64;
        let tmp = env::temp_dir().join(format!("memos-brief-{}.db", Uuid::new_v4()));
        {
            let conn = Connection::open(&tmp).unwrap();
            conn.execute_batch(
                "CREATE TABLE nodes (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    content TEXT NOT NULL,
                    summary TEXT,
                    importance REAL DEFAULT 0.5,
                    trust_score REAL DEFAULT 1.0,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    expires_at INTEGER,
                    namespace TEXT DEFAULT 'default',
                    provenance TEXT DEFAULT 'user',
                    source TEXT DEFAULT 'cli',
                    harness TEXT DEFAULT 'codex',
                    tags TEXT DEFAULT '[]',
                    quarantined INTEGER DEFAULT 0,
                    quarantine_reason TEXT,
                    metadata TEXT DEFAULT '{}'
                 );
                 CREATE TABLE contradictions (
                    id TEXT PRIMARY KEY,
                    node_a TEXT NOT NULL,
                    node_b TEXT NOT NULL,
                    status TEXT DEFAULT 'open',
                    detected_at INTEGER NOT NULL
                 );",
            )
            .unwrap();

            // 1. Empty store -> empty brief.
            let empty_store = ReadOnlyStore::open(&tmp).unwrap();
            let empty_ov = empty_store.load_overview().unwrap();
            let empty_brief = empty_store
                .load_brief(now_ms, &empty_ov.contradiction_node_ids, 5)
                .unwrap();
            assert!(empty_brief.is_empty());
            assert_eq!(empty_brief.total_count(), 0);
            drop(empty_store);

            // Populate distinct rows testing each section boundary.
            conn.execute(
                "INSERT INTO nodes (id, type, content, created_at, updated_at, provenance, trust_score)
                 VALUES (?1, 'fact', 'Created recently', ?2, ?2, 'user', 0.9)",
                rusqlite::params!["n-new", now_ms - 3_600_000],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO nodes (id, type, content, created_at, updated_at, provenance, trust_score)
                 VALUES (?1, 'fact', 'Edited recently from older memory', ?2, ?3, 'user', 0.9)",
                rusqlite::params!["n-changed", now_ms - 10 * 86_400_000, now_ms - 1_800_000],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO nodes (id, type, content, created_at, updated_at, expires_at, provenance, trust_score)
                 VALUES (?1, 'fact', 'Expires within 3 days', ?2, ?2, ?3, 'user', 0.9)",
                rusqlite::params![
                    "n-expiring",
                    now_ms - 5 * 86_400_000,
                    (now_ms + 3 * 86_400_000) / 1000
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO nodes (id, type, content, created_at, updated_at, expires_at, provenance, trust_score)
                 VALUES (?1, 'fact', 'Expires outside 7d window', ?2, ?2, ?3, 'user', 0.9)",
                rusqlite::params![
                    "n-later",
                    now_ms - 5 * 86_400_000,
                    (now_ms + 20 * 86_400_000) / 1000
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO nodes (id, type, content, created_at, updated_at, provenance, trust_score, metadata)
                 VALUES (?1, 'decision', 'Inferred agent note', ?2, ?2, 'agent-inferred', 0.75, '{\"reviewStatus\":\"pending\"}')",
                rusqlite::params!["n-inferred", now_ms - 4 * 86_400_000],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO nodes (id, type, content, created_at, updated_at, provenance, trust_score)
                 VALUES (?1, 'fact', 'Low trust note', ?2, ?2, 'user', 0.35)",
                rusqlite::params!["n-lowtrust", now_ms - 4 * 86_400_000],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO contradictions (id, node_a, node_b, status, detected_at)
                 VALUES ('c-open', 'n-new', 'n-changed', 'open', ?1)",
                rusqlite::params![now_ms - 600_000],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO contradictions (id, node_a, node_b, status, detected_at)
                 VALUES ('c-closed', 'n-expiring', 'n-later', 'resolved', ?1)",
                rusqlite::params![now_ms - 900_000],
            )
            .unwrap();
        }

        let store = ReadOnlyStore::open(&tmp).unwrap();
        let ov = store.load_overview().unwrap();
        let brief = store
            .load_brief(now_ms, &ov.contradiction_node_ids, 5)
            .unwrap();
        assert!(!brief.is_empty());

        let new_ids: Vec<&str> = brief.new_items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(new_ids, vec!["n-new"]);

        let changed_ids: Vec<&str> = brief.changed_items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(changed_ids, vec!["n-changed"]);

        let expiring_ids: Vec<&str> = brief.expiring_items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(expiring_ids, vec!["n-expiring"]);

        assert_eq!(brief.contradiction_pairs.len(), 1);
        assert_eq!(brief.contradiction_pairs[0].id, "c-open");
        assert_eq!(brief.contradiction_pairs[0].node_a_id, "n-new");
        assert_eq!(brief.contradiction_pairs[0].node_b_id, "n-changed");

        let mut review_ids: Vec<&str> = brief
            .needs_review_items
            .iter()
            .map(|i| i.id.as_str())
            .collect();
        review_ids.sort();
        assert_eq!(review_ids, vec!["n-inferred", "n-lowtrust"]);
        assert_eq!(store.count_pending_review().unwrap(), 1);

        drop(store);
        let _ = std::fs::remove_file(&tmp);
    }
}
