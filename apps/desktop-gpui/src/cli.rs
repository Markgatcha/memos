use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::core::db::{
    DEFAULT_GRAPH_NODE_CAP, LIST_PAGE_SIZE, NodeLookup, ReadOnlyStore, sqlite_version,
};
use crate::core::harness::{self, Detection};
use crate::core::health::{StoreHealthReport, assess_store_health, now_unix_ms};
use crate::core::model::{
    EdgeDirection, GraphMode, GraphSnapshot, MemoryDetail, MemoryListItem, QueryFilter, SortOrder,
    format_relative_age, format_timestamp_ms,
};
use crate::core::settings::{AppSettings, ResolvedDbPath, resolve_db_path_with_settings};

pub const CLI_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_LIST_LIMIT: usize = 20;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Version,
    Help,
    List {
        filter: QueryOptions,
    },
    Search {
        query: String,
        filter: QueryOptions,
    },
    Show {
        id: String,
    },
    Graph {
        mode: GraphMode,
        limit: usize,
        namespace: Option<String>,
        tag: Option<String>,
    },
    Health,
    Harness,
    Doctor,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryOptions {
    pub limit: usize,
    pub namespace: Option<String>,
    pub tag: Option<String>,
    pub node_type: Option<String>,
    pub provenance: Option<String>,
    pub has_contradiction: bool,
    pub quarantined_only: bool,
    pub sort: SortOrder,
}

impl Default for QueryOptions {
    fn default() -> Self {
        Self {
            limit: DEFAULT_LIST_LIMIT,
            namespace: None,
            tag: None,
            node_type: None,
            provenance: None,
            has_contradiction: false,
            quarantined_only: false,
            sort: SortOrder::Recency,
        }
    }
}

impl QueryOptions {
    fn to_filter(&self, query: String) -> QueryFilter {
        QueryFilter {
            query,
            namespace: self.namespace.clone(),
            tag: self.tag.clone(),
            node_type: self.node_type.clone(),
            provenance: self.provenance.clone(),
            has_contradiction: self.has_contradiction,
            quarantined_only: self.quarantined_only,
            sort: self.sort,
            ..Default::default()
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedCli {
    pub db_path: Option<PathBuf>,
    pub json: bool,
    pub command: Command,
}

#[derive(Debug, Serialize)]
struct VersionOutput {
    name: &'static str,
    version: &'static str,
    sqlite_version: &'static str,
    read_only: bool,
}

#[derive(Debug, Serialize)]
struct ListItemJson {
    id: String,
    short_id: String,
    citation: String,
    #[serde(rename = "type")]
    node_type: String,
    namespace: String,
    provenance: String,
    source: String,
    harness: String,
    tags: Vec<String>,
    importance: f32,
    trust_score: f32,
    created_at: i64,
    updated_at: i64,
    has_contradiction: bool,
    quarantined: bool,
    preview: String,
}

impl ListItemJson {
    fn from_item(item: &MemoryListItem) -> Self {
        Self {
            id: item.id.clone(),
            short_id: item.short_id.to_string(),
            citation: format!("[mem:{}]", item.short_id),
            node_type: item.node_type.to_string(),
            namespace: item.namespace.to_string(),
            provenance: item.provenance.to_string(),
            source: item.source.to_string(),
            harness: item.harness.to_string(),
            tags: item.tags.iter().map(|t| t.to_string()).collect(),
            importance: item.importance,
            trust_score: item.trust_score,
            created_at: item.created_at,
            updated_at: item.updated_at,
            has_contradiction: item.has_contradiction,
            quarantined: item.quarantined,
            preview: item.preview.to_string(),
        }
    }
}

#[derive(Debug, Serialize)]
struct ListOutput {
    db_path: PathBuf,
    total_memories: usize,
    returned: usize,
    limit: usize,
    sort: &'static str,
    items: Vec<ListItemJson>,
}

#[derive(Debug, Serialize)]
struct ShowEdgeJson {
    id: String,
    direction: &'static str,
    relation: String,
    weight: f32,
    peer_id: String,
    peer_short_id: String,
    peer_preview: String,
    peer_type: String,
    created_at: i64,
    valid_from: Option<i64>,
    valid_to: Option<i64>,
}

#[derive(Debug, Serialize)]
struct ShowContradictionJson {
    id: String,
    status: String,
    detected_at: i64,
    peer_id: String,
    peer_short_id: String,
    peer_preview: String,
}

#[derive(Debug, Serialize)]
struct ShowOutput {
    id: String,
    short_id: String,
    citation: String,
    #[serde(rename = "type")]
    node_type: String,
    namespace: String,
    provenance: String,
    source: String,
    pool: String,
    harness: String,
    importance: f32,
    trust_score: f32,
    confidence: Option<f32>,
    evidence_count: Option<u64>,
    created_at: i64,
    updated_at: i64,
    access_count: i64,
    last_accessed: i64,
    valid_from: Option<i64>,
    valid_to: Option<i64>,
    expires_at: Option<i64>,
    quarantined: bool,
    quarantined_at: Option<i64>,
    quarantine_reason: Option<String>,
    tags: Vec<String>,
    entities: Vec<String>,
    metadata_json: String,
    summary: String,
    content: String,
    edges: Vec<ShowEdgeJson>,
    contradictions: Vec<ShowContradictionJson>,
}

impl ShowOutput {
    fn from_detail(detail: MemoryDetail) -> Self {
        Self {
            id: detail.id,
            short_id: detail.short_id,
            citation: detail.citation_token,
            node_type: detail.node_type,
            namespace: detail.namespace,
            provenance: detail.provenance,
            source: detail.source,
            pool: detail.pool,
            harness: detail.harness,
            importance: detail.importance,
            trust_score: detail.trust_score,
            confidence: detail.confidence,
            evidence_count: detail.evidence_count,
            created_at: detail.created_at,
            updated_at: detail.updated_at,
            access_count: detail.access_count,
            last_accessed: detail.last_accessed,
            valid_from: detail.valid_from,
            valid_to: detail.valid_to,
            expires_at: detail.expires_at,
            quarantined: detail.quarantined,
            quarantined_at: detail.quarantined_at,
            quarantine_reason: detail.quarantine_reason,
            tags: detail.tags,
            entities: detail.entities,
            metadata_json: detail.metadata_json,
            summary: detail.summary,
            content: detail.content,
            edges: detail
                .edges
                .into_iter()
                .map(|e| ShowEdgeJson {
                    id: e.id,
                    direction: match e.direction {
                        EdgeDirection::Outgoing => "outgoing",
                        EdgeDirection::Incoming => "incoming",
                    },
                    relation: e.relation,
                    weight: e.weight,
                    peer_id: e.peer_id,
                    peer_short_id: e.peer_short_id,
                    peer_preview: e.peer_preview,
                    peer_type: e.peer_type,
                    created_at: e.created_at,
                    valid_from: e.valid_from,
                    valid_to: e.valid_to,
                })
                .collect(),
            contradictions: detail
                .contradictions
                .into_iter()
                .map(|c| ShowContradictionJson {
                    id: c.id,
                    status: c.status,
                    detected_at: c.detected_at,
                    peer_id: c.peer_id,
                    peer_short_id: c.peer_short_id,
                    peer_preview: c.peer_preview,
                })
                .collect(),
        }
    }
}

#[derive(Debug, Serialize)]
struct GraphNodeJson {
    key: String,
    memory_id: Option<String>,
    label: String,
    group: String,
    #[serde(rename = "type")]
    node_type: String,
    importance: f32,
    created_at: i64,
    cluster_count: usize,
    has_contradiction: bool,
}

#[derive(Debug, Serialize)]
struct GraphEdgeJson {
    source_idx: usize,
    target_idx: usize,
    relation: String,
    weight: f32,
    is_contradiction: bool,
}

#[derive(Debug, Serialize)]
struct GraphOutput {
    db_path: PathBuf,
    mode: &'static str,
    total_matching_nodes: usize,
    clustered_nodes: usize,
    node_count: usize,
    edge_count: usize,
    nodes: Vec<GraphNodeJson>,
    edges: Vec<GraphEdgeJson>,
}

impl GraphOutput {
    fn from_snapshot(db_path: PathBuf, snap: GraphSnapshot) -> Self {
        Self {
            db_path,
            mode: graph_mode_key(snap.mode),
            total_matching_nodes: snap.total_matching_nodes,
            clustered_nodes: snap.clustered_nodes,
            node_count: snap.nodes.len(),
            edge_count: snap.edges.len(),
            nodes: snap
                .nodes
                .into_iter()
                .map(|n| GraphNodeJson {
                    key: n.key,
                    memory_id: n.memory_id,
                    label: n.label,
                    group: n.group,
                    node_type: n.node_type,
                    importance: n.importance,
                    created_at: n.created_at,
                    cluster_count: n.cluster_count,
                    has_contradiction: n.has_contradiction,
                })
                .collect(),
            edges: snap
                .edges
                .into_iter()
                .map(|e| GraphEdgeJson {
                    source_idx: e.source_idx,
                    target_idx: e.target_idx,
                    relation: e.relation,
                    weight: e.weight,
                    is_contradiction: e.is_contradiction,
                })
                .collect(),
        }
    }
}

#[derive(Debug, Serialize)]
struct HarnessOutput {
    detected_count: usize,
    total_count: usize,
    harnesses: Vec<Detection>,
}

#[derive(Debug, Serialize)]
struct DoctorOutput {
    cli_version: &'static str,
    sqlite_version: &'static str,
    read_only: bool,
    db_path: PathBuf,
    db_source: &'static str,
    db_exists: bool,
    db_ok: bool,
    db_error: Option<String>,
    settings_path: PathBuf,
    settings_exists: bool,
    crash_reporting_consent: Option<bool>,
    harnesses_detected: usize,
    harnesses_total: usize,
    health: Option<StoreHealthReport>,
}

pub fn help_text() -> String {
    format!(
        "memos {CLI_VERSION} — read-only CLI for the MemOS memory store\n\
         \n\
         USAGE:\n\
         \x20 memos [--db <path>] [--json] <command> [options]\n\
         \n\
         COMMANDS:\n\
         \x20 list                         List recent memories\n\
         \x20 search <query>               Full-text / citation search ([mem:xxxx] or keywords)\n\
         \x20 show <id>                    Show full details for an ID, prefix, or [mem:xxxx]\n\
         \x20 graph [--mode <mode>]        Build a graph snapshot (namespace|tag|entity|temporal|contradictions)\n\
         \x20 health                       Assess store health and schema state\n\
         \x20 harness                      Detect installed AI coding harnesses & MemOS MCP config\n\
         \x20 doctor                       Run read-only environment & database checks\n\
         \x20 version                      Print CLI and SQLite versions\n\
         \n\
         GLOBAL FLAGS:\n\
         \x20 --db <path>                  Override database path (else MEMOS_DB, saved setting, ~/.memos/memos.db)\n\
         \x20 --json                       Emit stable machine-readable JSON\n\
         \x20 -h, --help                   Show this help message\n\
         \x20 -V, --version                Show version information\n\
         \n\
         LIST / SEARCH OPTIONS:\n\
         \x20 --limit <n>                  Maximum rows (default {DEFAULT_LIST_LIMIT}, max {LIST_PAGE_SIZE})\n\
         \x20 --namespace <ns>             Filter by namespace\n\
         \x20 --tag <tag>                  Filter by tag\n\
         \x20 --type <type>                Filter by memory type\n\
         \x20 --provenance <prov>          Filter by provenance\n\
         \x20 --sort <recency|importance|trust>\n\
         \x20 --contradictions             Only memories with contradictions\n\
         \x20 --quarantined                Only quarantined memories"
    )
}

fn graph_mode_key(mode: GraphMode) -> &'static str {
    match mode {
        GraphMode::Namespace => "namespace",
        GraphMode::Tag => "tag",
        GraphMode::Entity => "entity",
        GraphMode::Temporal => "temporal",
        GraphMode::Contradictions => "contradictions",
    }
}

fn sort_order_key(sort: SortOrder) -> &'static str {
    match sort {
        SortOrder::Recency => "recency",
        SortOrder::Importance => "importance",
        SortOrder::Trust => "trust",
    }
}

fn parse_graph_mode(raw: &str) -> Result<GraphMode, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "namespace" | "ns" => Ok(GraphMode::Namespace),
        "tag" | "tags" => Ok(GraphMode::Tag),
        "entity" | "entities" => Ok(GraphMode::Entity),
        "temporal" | "time" => Ok(GraphMode::Temporal),
        "contradictions" | "contradiction" => Ok(GraphMode::Contradictions),
        _ => Err(
            "invalid graph mode; expected one of: namespace, tag, entity, temporal, contradictions"
                .to_string(),
        ),
    }
}

fn parse_sort_order(raw: &str) -> Result<SortOrder, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "recency" | "recent" => Ok(SortOrder::Recency),
        "importance" | "important" => Ok(SortOrder::Importance),
        "trust" | "trust_score" => Ok(SortOrder::Trust),
        _ => Err("invalid --sort value; expected recency, importance, or trust".to_string()),
    }
}

fn next_flag_value<'a>(
    flag: &str,
    iter: &mut std::slice::Iter<'a, String>,
) -> Result<&'a str, String> {
    iter.next()
        .map(String::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("{flag} requires a value"))
}

pub fn parse_args_from<I, S>(args: I) -> Result<ParsedCli, String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let raw: Vec<String> = args
        .into_iter()
        .map(|s| s.into().to_string_lossy().into_owned())
        .collect();

    let mut db_path: Option<PathBuf> = None;
    let mut json = false;
    let mut help = false;
    let mut version_flag = false;
    let mut remaining: Vec<String> = Vec::with_capacity(raw.len());

    let mut i = 0usize;
    while i < raw.len() {
        let arg = &raw[i];
        if arg == "--" {
            remaining.extend_from_slice(&raw[i + 1..]);
            break;
        } else if arg == "--db" {
            let val = raw
                .get(i + 1)
                .filter(|v| !v.is_empty())
                .ok_or_else(|| "--db requires a file path".to_string())?;
            db_path = Some(PathBuf::from(val));
            i += 2;
        } else if let Some(val) = arg.strip_prefix("--db=") {
            if val.is_empty() {
                return Err("--db= requires a file path".to_string());
            }
            db_path = Some(PathBuf::from(val));
            i += 1;
        } else if arg == "--json" {
            json = true;
            i += 1;
        } else if arg == "-h" || arg == "--help" {
            help = true;
            i += 1;
        } else if arg == "-V" || arg == "--version" {
            version_flag = true;
            i += 1;
        } else {
            remaining.push(arg.clone());
            i += 1;
        }
    }

    if help {
        return Ok(ParsedCli {
            db_path,
            json,
            command: Command::Help,
        });
    }

    if version_flag && remaining.is_empty() {
        return Ok(ParsedCli {
            db_path,
            json,
            command: Command::Version,
        });
    }

    let Some(subcmd) = remaining.first().map(String::as_str) else {
        return Err("missing command (run `memos --help` for usage)".to_string());
    };
    let tail = &remaining[1..];

    let command = match subcmd {
        "help" => {
            if !tail.is_empty() {
                return Err("`help` takes no extra arguments".to_string());
            }
            Command::Help
        }
        "version" => {
            if !tail.is_empty() {
                return Err("`version` takes no extra arguments".to_string());
            }
            Command::Version
        }
        "health" => {
            if !tail.is_empty() {
                return Err(format!("unknown argument for `health`: {}", tail[0]));
            }
            Command::Health
        }
        "harness" => {
            if !tail.is_empty() {
                return Err(format!("unknown argument for `harness`: {}", tail[0]));
            }
            Command::Harness
        }
        "doctor" => {
            if !tail.is_empty() {
                return Err(format!("unknown argument for `doctor`: {}", tail[0]));
            }
            Command::Doctor
        }
        "show" => parse_show_args(tail)?,
        "list" => {
            let (opts, positionals) = parse_query_options(tail, LIST_PAGE_SIZE)?;
            if !positionals.is_empty() {
                return Err(
                    "`list` does not take positional arguments; use `search <query>` to filter by text"
                        .to_string(),
                );
            }
            Command::List { filter: opts }
        }
        "search" => {
            let (opts, positionals) = parse_query_options(tail, LIST_PAGE_SIZE)?;
            let query = positionals.join(" ").trim().to_string();
            if query.is_empty() {
                return Err("`search` requires a non-empty query".to_string());
            }
            Command::Search {
                query,
                filter: opts,
            }
        }
        "graph" => parse_graph_args(tail)?,
        other => {
            return Err(format!(
                "unknown command `{other}` (run `memos --help` for available commands)"
            ));
        }
    };

    Ok(ParsedCli {
        db_path,
        json,
        command,
    })
}

fn parse_show_args(tail: &[String]) -> Result<Command, String> {
    if let Some(first) = tail.first() {
        if first.starts_with('-') {
            return Err(format!("unknown flag for `show`: {first}"));
        }
        if tail.len() > 1 {
            return Err(format!("unexpected extra argument for `show`: {}", tail[1]));
        }
        let id = first.trim();
        if id.is_empty() {
            return Err("`show` requires a non-empty memory ID or [mem:xxxx] token".to_string());
        }
        Ok(Command::Show { id: id.to_string() })
    } else {
        Err("`show` requires a memory ID or [mem:xxxx] citation".to_string())
    }
}

fn parse_query_options(
    tail: &[String],
    max_limit: usize,
) -> Result<(QueryOptions, Vec<String>), String> {
    let mut opts = QueryOptions::default();
    let mut positionals = Vec::new();
    let mut iter = tail.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--limit" | "-n" => {
                let raw_val = next_flag_value(arg, &mut iter)?;
                let n: usize = raw_val
                    .parse()
                    .map_err(|_| format!("invalid integer for {arg}: {raw_val}"))?;
                if n == 0 {
                    return Err("--limit must be at least 1".to_string());
                }
                opts.limit = n.min(max_limit);
            }
            _ if arg.starts_with("--limit=") => {
                let raw_val = &arg["--limit=".len()..];
                let n: usize = raw_val
                    .parse()
                    .map_err(|_| format!("invalid integer for --limit: {raw_val}"))?;
                if n == 0 {
                    return Err("--limit must be at least 1".to_string());
                }
                opts.limit = n.min(max_limit);
            }
            "--namespace" => {
                opts.namespace = Some(next_flag_value("--namespace", &mut iter)?.to_string());
            }
            _ if arg.starts_with("--namespace=") => {
                let v = &arg["--namespace=".len()..];
                if v.is_empty() {
                    return Err("--namespace= requires a value".to_string());
                }
                opts.namespace = Some(v.to_string());
            }
            "--tag" => {
                opts.tag = Some(next_flag_value("--tag", &mut iter)?.to_string());
            }
            _ if arg.starts_with("--tag=") => {
                let v = &arg["--tag=".len()..];
                if v.is_empty() {
                    return Err("--tag= requires a value".to_string());
                }
                opts.tag = Some(v.to_string());
            }
            "--type" => {
                opts.node_type = Some(next_flag_value("--type", &mut iter)?.to_string());
            }
            _ if arg.starts_with("--type=") => {
                let v = &arg["--type=".len()..];
                if v.is_empty() {
                    return Err("--type= requires a value".to_string());
                }
                opts.node_type = Some(v.to_string());
            }
            "--provenance" => {
                opts.provenance = Some(next_flag_value("--provenance", &mut iter)?.to_string());
            }
            _ if arg.starts_with("--provenance=") => {
                let v = &arg["--provenance=".len()..];
                if v.is_empty() {
                    return Err("--provenance= requires a value".to_string());
                }
                opts.provenance = Some(v.to_string());
            }
            "--sort" => {
                opts.sort = parse_sort_order(next_flag_value("--sort", &mut iter)?)?;
            }
            _ if arg.starts_with("--sort=") => {
                opts.sort = parse_sort_order(&arg["--sort=".len()..])?;
            }
            "--contradictions" => {
                opts.has_contradiction = true;
            }
            "--quarantined" => {
                opts.quarantined_only = true;
            }
            _ if arg.starts_with('-') => {
                return Err(format!("unknown flag: {arg}"));
            }
            _ => positionals.push(arg.clone()),
        }
    }
    Ok((opts, positionals))
}

fn parse_graph_args(tail: &[String]) -> Result<Command, String> {
    let mut mode = GraphMode::Namespace;
    let mut limit = DEFAULT_GRAPH_NODE_CAP;
    let mut namespace = None;
    let mut tag = None;

    let mut iter = tail.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--mode" => {
                mode = parse_graph_mode(next_flag_value("--mode", &mut iter)?)?;
            }
            _ if arg.starts_with("--mode=") => {
                mode = parse_graph_mode(&arg["--mode=".len()..])?;
            }
            "--limit" | "-n" => {
                let raw_val = next_flag_value(arg, &mut iter)?;
                let n: usize = raw_val
                    .parse()
                    .map_err(|_| format!("invalid integer for {arg}: {raw_val}"))?;
                if n == 0 {
                    return Err("--limit must be at least 1".to_string());
                }
                limit = n.clamp(16, DEFAULT_GRAPH_NODE_CAP);
            }
            _ if arg.starts_with("--limit=") => {
                let raw_val = &arg["--limit=".len()..];
                let n: usize = raw_val
                    .parse()
                    .map_err(|_| format!("invalid integer for --limit: {raw_val}"))?;
                if n == 0 {
                    return Err("--limit must be at least 1".to_string());
                }
                limit = n.clamp(16, DEFAULT_GRAPH_NODE_CAP);
            }
            "--namespace" => {
                namespace = Some(next_flag_value("--namespace", &mut iter)?.to_string());
            }
            _ if arg.starts_with("--namespace=") => {
                let v = &arg["--namespace=".len()..];
                if v.is_empty() {
                    return Err("--namespace= requires a value".to_string());
                }
                namespace = Some(v.to_string());
            }
            "--tag" => {
                tag = Some(next_flag_value("--tag", &mut iter)?.to_string());
            }
            _ if arg.starts_with("--tag=") => {
                let v = &arg["--tag=".len()..];
                if v.is_empty() {
                    return Err("--tag= requires a value".to_string());
                }
                tag = Some(v.to_string());
            }
            _ => return Err(format!("unknown argument for `graph`: {arg}")),
        }
    }

    Ok(Command::Graph {
        mode,
        limit,
        namespace,
        tag,
    })
}

fn resolve_cli_db(cli_db: Option<&Path>) -> ResolvedDbPath {
    if cli_db.is_some()
        || env::var("MEMOS_DB")
            .ok()
            .is_some_and(|v| !v.trim().is_empty())
    {
        resolve_db_path_with_settings(cli_db, &AppSettings::default())
    } else {
        let settings = AppSettings::load();
        resolve_db_path_with_settings(None, &settings)
    }
}

fn open_read_only_store(path: &Path) -> Result<ReadOnlyStore, String> {
    if !path.is_file() {
        return Err(format!("database not found at {}", path.display()));
    }
    ReadOnlyStore::open(path).map_err(|e| e.to_string())
}

fn print_json<T: Serialize>(value: &T) -> Result<(), String> {
    let serialized =
        serde_json::to_string_pretty(value).map_err(|e| format!("JSON encoding error: {e}"))?;
    println!("{serialized}");
    Ok(())
}

pub fn run_from_env() -> Result<(), String> {
    let parsed = parse_args_from(env::args_os().skip(1))?;
    execute(parsed)
}

pub fn execute(parsed: ParsedCli) -> Result<(), String> {
    match parsed.command {
        Command::Help => {
            println!("{}", help_text());
            Ok(())
        }
        Command::Version => {
            if parsed.json {
                print_json(&VersionOutput {
                    name: "memos",
                    version: CLI_VERSION,
                    sqlite_version: sqlite_version(),
                    read_only: true,
                })
            } else {
                println!(
                    "memos {CLI_VERSION} (read-only CLI, sqlite {})",
                    sqlite_version()
                );
                Ok(())
            }
        }
        Command::List { filter } => {
            let resolved = resolve_cli_db(parsed.db_path.as_deref());
            let store = open_read_only_store(&resolved.path)?;
            let (total, contradiction_ids) =
                store.load_list_fast_meta().map_err(|e| e.to_string())?;
            let items = store
                .query_nodes(
                    &filter.to_filter(String::new()),
                    &contradiction_ids,
                    filter.limit,
                )
                .map_err(|e| e.to_string())?;
            if parsed.json {
                let out = ListOutput {
                    db_path: resolved.path,
                    total_memories: total,
                    returned: items.len(),
                    limit: filter.limit,
                    sort: sort_order_key(filter.sort),
                    items: items.iter().map(ListItemJson::from_item).collect(),
                };
                print_json(&out)
            } else {
                render_list_text(&resolved.path, total, &items);
                Ok(())
            }
        }
        Command::Search { query, filter } => {
            let resolved = resolve_cli_db(parsed.db_path.as_deref());
            let store = open_read_only_store(&resolved.path)?;
            let (total, contradiction_ids) =
                store.load_list_fast_meta().map_err(|e| e.to_string())?;
            let items = store
                .query_nodes(&filter.to_filter(query), &contradiction_ids, filter.limit)
                .map_err(|e| e.to_string())?;
            if parsed.json {
                let out = ListOutput {
                    db_path: resolved.path,
                    total_memories: total,
                    returned: items.len(),
                    limit: filter.limit,
                    sort: sort_order_key(filter.sort),
                    items: items.iter().map(ListItemJson::from_item).collect(),
                };
                print_json(&out)
            } else {
                render_list_text(&resolved.path, total, &items);
                Ok(())
            }
        }
        Command::Show { id } => {
            let resolved = resolve_cli_db(parsed.db_path.as_deref());
            let store = open_read_only_store(&resolved.path)?;
            let resolved_id = match store.resolve_node_id(&id).map_err(|e| e.to_string())? {
                NodeLookup::Exact(full) => full,
                NodeLookup::NotFound => return Err("memory not found".to_string()),
                NodeLookup::Ambiguous(candidates) => {
                    return Err(format!(
                        "ambiguous memory id prefix ({} candidates match); provide a longer prefix",
                        candidates.len()
                    ));
                }
            };
            let detail = store
                .load_node_detail(&resolved_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "memory not found".to_string())?;
            if parsed.json {
                print_json(&ShowOutput::from_detail(detail))
            } else {
                render_show_text(&detail);
                Ok(())
            }
        }
        Command::Graph {
            mode,
            limit,
            namespace,
            tag,
        } => {
            let resolved = resolve_cli_db(parsed.db_path.as_deref());
            let store = open_read_only_store(&resolved.path)?;
            let (_total, contradiction_ids) =
                store.load_list_fast_meta().map_err(|e| e.to_string())?;
            let filter = QueryFilter {
                namespace,
                tag,
                ..Default::default()
            };
            let snap = store
                .load_graph_snapshot(mode, &filter, &contradiction_ids, limit)
                .map_err(|e| e.to_string())?;
            if parsed.json {
                print_json(&GraphOutput::from_snapshot(resolved.path, snap))
            } else {
                render_graph_text(&resolved.path, &snap);
                Ok(())
            }
        }
        Command::Health => {
            let resolved = resolve_cli_db(parsed.db_path.as_deref());
            let store = open_read_only_store(&resolved.path)?;
            let overview = store.load_overview().map_err(|e| e.to_string())?;
            let report =
                assess_store_health(&store, &overview, now_unix_ms()).map_err(|e| e.to_string())?;
            if parsed.json {
                print_json(&report)
            } else {
                render_health_text(&report);
                Ok(())
            }
        }
        Command::Harness => {
            let detected = harness::detect_all();
            let detected_count = detected.iter().filter(|d| d.installed).count();
            let total_count = detected.len();
            if parsed.json {
                print_json(&HarnessOutput {
                    detected_count,
                    total_count,
                    harnesses: detected,
                })
            } else {
                render_harness_text(&detected, detected_count, total_count);
                Ok(())
            }
        }
        Command::Doctor => run_doctor(parsed.db_path.as_deref(), parsed.json),
    }
}

fn run_doctor(cli_db: Option<&Path>, json: bool) -> Result<(), String> {
    let settings_path = AppSettings::config_path();
    let settings_exists = settings_path.is_file();
    let settings = AppSettings::load();
    let resolved = resolve_db_path_with_settings(cli_db, &settings);
    let db_exists = resolved.path.is_file();

    let harnesses = harness::detect_all();
    let harnesses_detected = harnesses.iter().filter(|h| h.installed).count();
    let harnesses_total = harnesses.len();

    let mut db_error: Option<String> = None;
    let health = match open_read_only_store(&resolved.path) {
        Ok(store) => match store.load_overview() {
            Ok(overview) => match assess_store_health(&store, &overview, now_unix_ms()) {
                Ok(report) => Some(report),
                Err(e) => {
                    db_error = Some(e.to_string());
                    None
                }
            },
            Err(e) => {
                db_error = Some(e.to_string());
                None
            }
        },
        Err(e) => {
            db_error = Some(e);
            None
        }
    };

    let db_ok = health.is_some();
    let output = DoctorOutput {
        cli_version: CLI_VERSION,
        sqlite_version: sqlite_version(),
        read_only: true,
        db_path: resolved.path.clone(),
        db_source: resolved.source.label(),
        db_exists,
        db_ok,
        db_error: db_error.clone(),
        settings_path,
        settings_exists,
        crash_reporting_consent: settings.crash_reporting_consent,
        harnesses_detected,
        harnesses_total,
        health,
    };

    if json {
        print_json(&output)?;
    } else {
        println!(
            "MemOS Doctor (cli {CLI_VERSION}, sqlite {}, read-only)",
            output.sqlite_version
        );
        println!(
            "Database:   {} ({}, {})",
            output.db_path.display(),
            output.db_source,
            if output.db_ok {
                "ok"
            } else {
                output.db_error.as_deref().unwrap_or("unavailable")
            }
        );
        println!(
            "Settings:   {} ({})",
            output.settings_path.display(),
            if output.settings_exists {
                "present"
            } else {
                "not created"
            }
        );
        println!(
            "Crash opt:  {}",
            match output.crash_reporting_consent {
                Some(true) => "opted in",
                Some(false) => "declined",
                None => "not prompted (off)",
            }
        );
        println!(
            "Harnesses:  {}/{} detected",
            output.harnesses_detected, output.harnesses_total
        );
        if let Some(h) = &output.health {
            println!(
                "Store:      {} ({} memories, {} edges, {} contradictions, FTS5={})",
                h.status.as_str(),
                h.node_count,
                h.edge_count,
                h.contradiction_count,
                if h.has_fts5 { "yes" } else { "no" }
            );
        }
    }

    if let Some(err) = db_error {
        Err(err)
    } else {
        Ok(())
    }
}

fn render_list_text(db_path: &Path, total: usize, items: &[MemoryListItem]) {
    let now_ms = now_unix_ms();
    println!(
        "{} memories (showing {} of {}, read-only: {})",
        total,
        items.len(),
        total,
        db_path.display()
    );
    if items.is_empty() {
        println!("(no matching memories)");
        return;
    }
    for item in items {
        let flag = if item.quarantined {
            " [quarantined]"
        } else if item.has_contradiction {
            " [contradiction]"
        } else {
            ""
        };
        let age = format_relative_age(item.created_at, now_ms);
        println!(
            "[mem:{}] {:<10} {:<12} imp={:.2} {:>4}{}  {}",
            item.short_id, item.node_type, item.namespace, item.importance, age, flag, item.preview
        );
    }
}

fn render_show_text(d: &MemoryDetail) {
    println!("{}  id={}", d.citation_token, d.id);
    println!(
        "Type:       {} | Namespace: {} | Provenance: {}",
        d.node_type, d.namespace, d.provenance
    );
    println!(
        "Source:     {} | Harness: {} | Pool: {}",
        d.source, d.harness, d.pool
    );
    println!(
        "Importance: {:.2} | Trust: {:.2} | Accesses: {}",
        d.importance, d.trust_score, d.access_count
    );
    println!(
        "Created:    {} | Updated: {}",
        format_timestamp_ms(d.created_at),
        format_timestamp_ms(d.updated_at)
    );
    println!(
        "Last read:  {}",
        if d.last_accessed <= 0 {
            "Never recalled".to_string()
        } else {
            format_timestamp_ms(d.last_accessed)
        }
    );
    if !d.tags.is_empty() {
        println!("Tags:       {}", d.tags.join(", "));
    }
    if !d.entities.is_empty() {
        println!("Entities:   {}", d.entities.join(", "));
    }
    if d.quarantined {
        println!(
            "Quarantine: YES ({})",
            d.quarantine_reason.as_deref().unwrap_or("unspecified")
        );
    }
    if !d.summary.trim().is_empty() {
        println!("\nSummary:\n{}", d.summary);
    }
    println!("\nContent:\n{}", d.content);
    if !d.edges.is_empty() {
        println!("\nEdges ({}):", d.edges.len());
        for e in &d.edges {
            let dir = match e.direction {
                EdgeDirection::Outgoing => "->",
                EdgeDirection::Incoming => "<-",
            };
            println!(
                "  {dir} [mem:{}] ({}, w={:.2}) {}",
                e.peer_short_id, e.relation, e.weight, e.peer_preview
            );
        }
    }
    if !d.contradictions.is_empty() {
        println!("\nContradictions ({}):", d.contradictions.len());
        for c in &d.contradictions {
            println!(
                "  ! [mem:{}] ({}) {}",
                c.peer_short_id, c.status, c.peer_preview
            );
        }
    }
}

fn render_graph_text(db_path: &Path, snap: &GraphSnapshot) {
    println!(
        "Graph mode={} nodes={} edges={} matching={} clustered={} ({})",
        graph_mode_key(snap.mode),
        snap.nodes.len(),
        snap.edges.len(),
        snap.total_matching_nodes,
        snap.clustered_nodes,
        db_path.display()
    );
    for (idx, node) in snap.nodes.iter().take(40).enumerate() {
        let flag = if node.has_contradiction { " !" } else { "" };
        println!(
            "  [{idx:>2}] {:<12} ({}) {} x{}{}",
            node.group, node.node_type, node.label, node.cluster_count, flag
        );
    }
    if snap.nodes.len() > 40 {
        println!("  ... and {} more nodes", snap.nodes.len() - 40);
    }
    if !snap.edges.is_empty() {
        println!("Edges (showing up to 25 of {}):", snap.edges.len());
        for edge in snap.edges.iter().take(25) {
            let src = snap
                .nodes
                .get(edge.source_idx)
                .map(|n| n.label.as_str())
                .unwrap_or("?");
            let dst = snap
                .nodes
                .get(edge.target_idx)
                .map(|n| n.label.as_str())
                .unwrap_or("?");
            println!(
                "  {src} --[{} ({:.2})]--> {dst}",
                edge.relation, edge.weight
            );
        }
    }
}

fn render_health_text(h: &StoreHealthReport) {
    println!(
        "Health:     {} ({}, score {}/100)",
        h.status.as_str(),
        h.status.label(),
        h.score
    );
    println!("Database:   {}", h.db_path.display());
    println!(
        "Counts:     {} memories, {} edges, {} contradictions, {} quarantined, {} expired, {} drifted, {} duplicate copies, {} low-trust",
        h.node_count,
        h.edge_count,
        h.contradiction_count,
        h.quarantined_count,
        h.expired_count,
        h.drifted_source_count,
        h.duplicate_count,
        h.low_trust_count
    );
    println!(
        "FTS5 index: {}",
        if h.has_fts5 { "present" } else { "absent" }
    );
    if !h.missing_tables.is_empty() {
        println!("Missing:    {}", h.missing_tables.join(", "));
    }
    if let Some(ts) = h.newest_updated_at {
        println!("Newest upd: {}", format_timestamp_ms(ts));
    }
    for note in &h.notes {
        println!("Note:       {note}");
    }
}

fn render_harness_text(detected: &[Detection], installed_count: usize, total: usize) {
    println!("Harnesses ({installed_count}/{total} installed):");
    for h in detected {
        let state = if h.installed {
            "installed"
        } else {
            "not found"
        };
        let mcp = if h.memos_configured {
            "memos-mcp=yes"
        } else {
            "memos-mcp=no"
        };
        let ver = h.version.as_deref().unwrap_or("-");
        let mode = if h.print_only { " [print-only]" } else { "" };
        println!(
            "  {:<12} {:<24} {:<10} {} ver={}{}",
            h.id, h.display_name, state, mcp, ver, mode
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_cli_commands_without_clap() {
        let p = parse_args_from(["--db", "/tmp/a.db", "--json", "list", "--limit", "5"]).unwrap();
        assert_eq!(p.db_path, Some(PathBuf::from("/tmp/a.db")));
        assert!(p.json);
        match p.command {
            Command::List { filter } => assert_eq!(filter.limit, 5),
            other => panic!("unexpected: {other:?}"),
        }

        let g = parse_args_from(["graph", "--mode", "contradictions"]).unwrap();
        assert_eq!(
            g.command,
            Command::Graph {
                mode: GraphMode::Contradictions,
                limit: DEFAULT_GRAPH_NODE_CAP,
                namespace: None,
                tag: None,
            }
        );

        let s = parse_args_from(["search", "rust", "ownership", "--sort=importance"]).unwrap();
        match s.command {
            Command::Search { query, filter } => {
                assert_eq!(query, "rust ownership");
                assert_eq!(filter.sort, SortOrder::Importance);
            }
            other => panic!("unexpected: {other:?}"),
        }

        assert!(parse_args_from(["graph", "--mode", "bogus"]).is_err());
        assert!(parse_args_from(["search"]).is_err());
        assert!(parse_args_from(["show"]).is_err());
        assert!(parse_args_from(["unknown-cmd"]).is_err());
        assert!(parse_args_from(Vec::<String>::new()).is_err());
    }
}
