use std::collections::VecDeque;
use std::env;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

pub const DEFAULT_WRITER_COMMAND: &str = "npx -y @mem-os/sdk mcp";
pub const FALLBACK_WRITER_COMMAND: &str = "memos mcp";
pub const MCP_PROTOCOL_VERSION: &str = "2026-07-28";
pub const LEGACY_MCP_PROTOCOL_VERSION: &str = "2025-11-25";
pub const MCP_CLIENT_NAME: &str = "memos-desktop";
pub const MCP_CLIENT_VERSION: &str = "0.1.0";
pub const MCP_META_PROTOCOL_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
pub const MCP_META_CLIENT_INFO: &str = "io.modelcontextprotocol/clientInfo";
pub const MCP_META_CLIENT_CAPABILITIES: &str = "io.modelcontextprotocol/clientCapabilities";
pub const MCP_META_SERVER_INFO: &str = "io.modelcontextprotocol/serverInfo";
pub const DEFAULT_CALL_TIMEOUT: Duration = Duration::from_secs(10);

const MAX_STDERR_LINES: usize = 12;
const MAX_STDERR_BYTES: usize = 2048;

/// Error returned when spawning, negotiating with, or invoking the MemOS MCP stdio server.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum BridgeError {
    #[error("invalid writer command: {reason}")]
    InvalidCommand { reason: String },
    #[error("failed to start writer `{command}`: {reason}")]
    SpawnFailed { command: String, reason: String },
    #[error("MCP protocol negotiation failed: {reason}")]
    NegotiationFailed { reason: String },
    #[error("writer missing tool `{tool}` (exposes {tool_count} tools)")]
    CapabilityMissing { tool: String, tool_count: usize },
    #[error("writer timed out after {timeout_ms} ms")]
    Timeout { timeout_ms: u64 },
    #[error("malformed JSON-RPC line from writer: {detail}")]
    MalformedLine { detail: String },
    #[error("MCP RPC error ({code}): {message}")]
    RpcError { code: i64, message: String },
    #[error("MCP tool error: {message}")]
    ToolError { message: String },
    #[error("writer exited unexpectedly ({status}){trailer}")]
    ProcessExited { status: String, trailer: String },
    #[error("writer I/O error: {reason}")]
    Io { reason: String },
}

pub fn format_capability_missing_message(tool: &str, tool_count: Option<usize>) -> String {
    match tool_count {
        Some(n) => format!(
            "This writer exposes {n} tools and not `{tool}`. Point Writer command at a full MemOS CLI or update `@mem-os/sdk`."
        ),
        None => format!(
            "This writer does not expose `{tool}`. Point Writer command at a full MemOS CLI or update `@mem-os/sdk`."
        ),
    }
}

/// Map raw SQLite / MCP errors to short, actionable user-facing summaries (no raw SQLite text).
pub fn humanize_writer_error(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("tool ")
        && let Some(tool_raw) = rest.strip_suffix(" not found")
    {
        let tool = tool_raw.trim();
        if !tool.is_empty() {
            return format_capability_missing_message(tool, None);
        }
    }
    if lower.contains("has no column named") || lower.contains("no such column") {
        let target = raw
            .split("has no column named ")
            .nth(1)
            .or_else(|| raw.split("no such column: ").nth(1))
            .map(|s| {
                s.trim()
                    .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '.')
            })
            .filter(|s| !s.is_empty());
        if let Some(col) = target {
            return format!(
                "This store predates the writer schema (missing {col}). Run `memos init`/migrate or open a migrated database."
            );
        }
        return "This store predates the writer schema. Run `memos init`/migrate or open a migrated database.".to_string();
    }
    if lower.contains("no such table") {
        let tbl = raw
            .split("no such table: ")
            .nth(1)
            .map(|s| {
                s.trim()
                    .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            })
            .filter(|s| !s.is_empty());
        if let Some(t) = tbl {
            return format!(
                "This store predates the writer schema (missing {t} table). Run `memos init`/migrate or open a migrated database."
            );
        }
        return "This store predates the writer schema. Run `memos init`/migrate or open a migrated database.".to_string();
    }
    if lower.contains("sqlite_busy")
        || lower.contains("database is locked")
        || lower.contains("memos_db_locked")
    {
        return "Store is locked by another process. Wait a moment and retry.".to_string();
    }
    if lower.contains("sqlite_readonly")
        || lower.contains("readonly database")
        || lower.contains("attempt to write a readonly database")
    {
        return "Store file is read-only. Check file permissions or choose a writable DB."
            .to_string();
    }
    if lower.contains("sqlite_cantopen")
        || lower.contains("unable to open database")
        || lower.contains("memos_db_open")
    {
        return "Writer could not open the database. Check the path in Settings.".to_string();
    }
    if lower.contains("sqlite_corrupt")
        || lower.contains("memos_db_corrupt")
        || lower.contains("database disk image is malformed")
    {
        return "Store appears corrupted or unmigrated. Open a healthy database.".to_string();
    }
    if lower.contains("sqlite_") || lower.contains("sqlerror") {
        return "Writer database check failed. Run `memos init`/migrate or check Settings."
            .to_string();
    }
    format!("Write rejected: {}", sanitize_single_line(raw, 160))
}

impl BridgeError {
    /// Concise, user-readable, content-free summary for UI banners and toasts.
    pub fn ui_summary(&self) -> String {
        match self {
            BridgeError::InvalidCommand { reason } => format!("Invalid writer command: {reason}"),
            BridgeError::SpawnFailed { reason, .. } => format!("Could not start writer ({reason})"),
            BridgeError::NegotiationFailed { reason } => {
                format!("Writer protocol negotiation failed ({reason})")
            }
            BridgeError::CapabilityMissing { tool, tool_count } => {
                format_capability_missing_message(tool, Some(*tool_count))
            }
            BridgeError::Timeout { timeout_ms } => {
                format!(
                    "Writer did not respond within {} s",
                    (*timeout_ms).div_ceil(1000)
                )
            }
            BridgeError::MalformedLine { .. } => {
                "Writer emitted a malformed JSON-RPC response".to_string()
            }
            BridgeError::RpcError { code, message } => {
                if (*code == -32602 || *code == -32601)
                    && let Some(tool) = extract_missing_tool_name(message)
                {
                    return format_capability_missing_message(&tool, None);
                }
                let mapped = humanize_writer_error(message);
                if mapped.starts_with("Write rejected:") {
                    format!(
                        "Writer RPC error ({code}): {}",
                        sanitize_single_line(message, 160)
                    )
                } else {
                    mapped
                }
            }
            BridgeError::ToolError { message } => humanize_writer_error(message),
            BridgeError::ProcessExited { status, trailer } => {
                if !trailer.is_empty() {
                    let mapped = humanize_writer_error(trailer);
                    if !mapped.starts_with("Write rejected:") {
                        return mapped;
                    }
                    return format!("Writer exited ({status}){trailer}");
                }
                format!("Writer process exited ({status})")
            }
            BridgeError::Io { reason } => format!("Writer communication failed ({reason})"),
        }
    }

    pub fn is_capability_missing(&self) -> bool {
        match self {
            BridgeError::CapabilityMissing { .. } => true,
            BridgeError::RpcError { code, message } if *code == -32602 || *code == -32601 => {
                extract_missing_tool_name(message).is_some()
            }
            _ => false,
        }
    }
}

fn extract_missing_tool_name(message: &str) -> Option<String> {
    let trimmed = message.trim();
    let lower = trimmed.to_ascii_lowercase();
    let start = lower.find("tool ")?;
    let after = trimmed[start + 5..].trim();
    let lower_after = after.to_ascii_lowercase();
    let end = lower_after.find(" not found")?;
    let name = after[..end]
        .trim()
        .trim_matches(|c| c == '`' || c == '"' || c == '\'');
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// Configuration for [`WriteBridge`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WriteBridgeConfig {
    pub command: String,
    pub db_path: PathBuf,
    pub timeout: Duration,
    pub extra_env: Vec<(String, String)>,
}

impl WriteBridgeConfig {
    pub fn new(command: impl Into<String>, db_path: PathBuf) -> Self {
        Self {
            command: command.into(),
            db_path,
            timeout: DEFAULT_CALL_TIMEOUT,
            extra_env: Vec::new(),
        }
    }
}

/// Input arguments for `memos_store`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoreInput {
    pub content: String,
    pub node_type: Option<String>,
    pub tags: Vec<String>,
    pub namespace: Option<String>,
    pub pool: Option<String>,
    pub context: Option<String>,
}

/// Typed result of `memos_store`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoreResult {
    pub id: String,
}

/// Typed result of `memos_forget`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForgetResult {
    pub id: String,
    pub deleted: bool,
}

/// Typed result of `memos_supersede`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SupersedeResult {
    pub id: String,
    pub replacement_id: Option<String>,
    pub superseded: bool,
}

/// Input arguments for `memos_link`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LinkInput {
    pub source_id: String,
    pub target_id: String,
    pub relation: Option<String>,
    pub weight: Option<f64>,
}

/// Typed result of `memos_link`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkResult {
    pub source_id: String,
    pub target_id: String,
    pub relation: Option<String>,
}

/// Input arguments for `memos_review`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewInput {
    pub action: String,
    pub id: Option<String>,
    pub namespace: Option<String>,
}

/// Typed item in the `memos_review` pending approval queue.
#[derive(Clone, Debug, PartialEq)]
pub struct ReviewQueueItem {
    pub id: String,
    pub short_id: String,
    pub preview: String,
    pub content: String,
    pub node_type: String,
    pub namespace: String,
    pub created_at: i64,
    pub confidence: Option<f32>,
    pub reason: Option<String>,
}

/// Typed result of `memos_review`.
#[derive(Clone, Debug, PartialEq)]
pub struct ReviewResult {
    pub action: String,
    pub summary: String,
    pub items: Vec<ReviewQueueItem>,
}

/// Input arguments for `memos_ingest`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct IngestInput {
    pub path: String,
    pub namespace: Option<String>,
    pub extensions: Vec<String>,
    pub chunk_chars: Option<usize>,
    pub recursive: bool,
}

/// Counts returned by `memos_ingest`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct IngestResult {
    pub added: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub removed: usize,
    pub skipped: usize,
    pub errors: usize,
    pub chunks: usize,
}

impl IngestResult {
    pub fn accumulate(&mut self, other: &Self) {
        self.added = self.added.saturating_add(other.added);
        self.updated = self.updated.saturating_add(other.updated);
        self.unchanged = self.unchanged.saturating_add(other.unchanged);
        self.removed = self.removed.saturating_add(other.removed);
        self.skipped = self.skipped.saturating_add(other.skipped);
        self.errors = self.errors.saturating_add(other.errors);
        self.chunks = self.chunks.saturating_add(other.chunks);
    }

    pub fn format_summary(&self) -> String {
        format!(
            "Added {}, updated {}, unchanged {}, removed {}, skipped {}, errors {}, chunks {}",
            self.added,
            self.updated,
            self.unchanged,
            self.removed,
            self.skipped,
            self.errors,
            self.chunks
        )
    }
}

/// Parse comma- or whitespace-separated extension list (`"md, txt, .pdf"`) into canonical
/// lowercase dot-prefixed extensions (`[".md", ".txt", ".pdf"]`).
pub fn parse_extensions_csv(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    for token in raw.split(|c: char| c == ',' || c.is_whitespace()) {
        let trimmed = token.trim().trim_start_matches('.');
        if trimmed.is_empty() {
            continue;
        }
        let normalized = format!(".{}", trimmed.to_ascii_lowercase());
        if !out.contains(&normalized) {
            out.push(normalized);
        }
    }
    out
}

/// Build the JSON-RPC `arguments` payload for `memos_ingest`.
pub fn build_ingest_tool_args(input: &IngestInput, target_path: &str) -> Value {
    let mut args = Map::new();
    args.insert("path".to_string(), Value::String(target_path.to_string()));
    if let Some(ns) = input
        .namespace
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        args.insert("namespace".to_string(), Value::String(ns.to_string()));
    }
    if let Some(chunk_chars) = input.chunk_chars.filter(|&c| c > 0) {
        args.insert("chunk_chars".to_string(), json!(chunk_chars));
    }
    if !input.extensions.is_empty() {
        args.insert(
            "extensions".to_string(),
            Value::Array(
                input
                    .extensions
                    .iter()
                    .map(|e| Value::String(e.clone()))
                    .collect(),
            ),
        );
    }
    Value::Object(args)
}

/// Negotiated MCP protocol era for the active stdio session.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProtocolEra {
    #[default]
    Modern,
    Legacy,
}

impl ProtocolEra {
    pub fn as_str(self) -> &'static str {
        match self {
            ProtocolEra::Modern => "modern",
            ProtocolEra::Legacy => "legacy",
        }
    }

    pub fn is_legacy(self) -> bool {
        matches!(self, ProtocolEra::Legacy)
    }
}

/// Server identity reported by `server/discover` `_meta` or legacy `initialize`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerInfo {
    pub name: String,
    pub version: Option<String>,
}

/// Parsed response from MCP 2026-07-28 `server/discover`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoverResult {
    pub supported_versions: Vec<String>,
    pub capabilities: Value,
    pub server_info: Option<ServerInfo>,
    pub ttl_ms: Option<u64>,
    pub cache_scope: Option<String>,
    pub result_type: Option<String>,
}

/// Build the per-request `_meta` envelope required by MCP 2026-07-28.
pub fn modern_meta_envelope() -> Value {
    json!({
        MCP_META_PROTOCOL_VERSION: MCP_PROTOCOL_VERSION,
        MCP_META_CLIENT_INFO: {
            "name": MCP_CLIENT_NAME,
            "version": MCP_CLIENT_VERSION,
        },
        MCP_META_CLIENT_CAPABILITIES: {},
    })
}

/// Result of connecting (`server/discover` or legacy fallback) + `tools/list`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PingResult {
    pub protocol_version: String,
    pub era: ProtocolEra,
    pub tool_count: usize,
    pub tool_names: Vec<String>,
    pub has_review: bool,
    pub has_ingest: bool,
    pub has_audit: bool,
    pub has_explain: bool,
    pub server_info: Option<ServerInfo>,
    pub cache_ttl_ms: Option<u64>,
    pub cache_scope: Option<String>,
}

impl PingResult {
    pub fn from_tools(
        protocol_version: String,
        era: ProtocolEra,
        tool_names: Vec<String>,
        server_info: Option<ServerInfo>,
        cache_ttl_ms: Option<u64>,
        cache_scope: Option<String>,
    ) -> Self {
        let has = |target: &str| tool_names.iter().any(|t| t == target);
        let has_review = has("memos_review");
        let has_ingest = has("memos_ingest");
        let has_audit = has("memos_audit_answer") || has("memos_audit");
        let has_explain = has("memos_explain_recall") || has("memos_explain");
        let tool_count = tool_names.len();
        Self {
            protocol_version,
            era,
            tool_count,
            tool_names,
            has_review,
            has_ingest,
            has_audit,
            has_explain,
            server_info,
            cache_ttl_ms,
            cache_scope,
        }
    }

    pub fn supports_tool(&self, tool_name: &str) -> bool {
        self.tool_names.iter().any(|t| t == tool_name)
    }

    pub fn format_settings_status(&self) -> String {
        let review_mark = if self.has_review { "✓" } else { "✗" };
        let rev = if self.era == ProtocolEra::Legacy {
            format!("{} (legacy)", self.protocol_version)
        } else {
            self.protocol_version.clone()
        };
        format!(
            "Connected · MCP {rev} · {} tools · review {review_mark}",
            self.tool_count
        )
    }

    pub fn settings_footer_mode(write_mode: bool, connected: Option<&PingResult>) -> String {
        if !write_mode {
            return "Read-only".to_string();
        }
        match connected {
            Some(info) if info.era == ProtocolEra::Legacy => {
                format!(
                    "Write mode enabled (MCP {} · legacy)",
                    info.protocol_version
                )
            }
            Some(info) => format!("Write mode enabled (MCP {})", info.protocol_version),
            None => "Write mode enabled (MCP)".to_string(),
        }
    }
}

#[derive(Debug)]
enum StdoutMsg {
    Line(String),
    Eof,
    IoError(String),
}

/// Shared bounded buffer holding trailing stderr lines from the writer subprocess.
#[derive(Clone, Default)]
pub struct StderrTrailer {
    lines: Arc<Mutex<VecDeque<String>>>,
}

impl StderrTrailer {
    pub fn push_line(&self, raw: &str) {
        let cleaned = sanitize_single_line(raw, 220);
        if cleaned.is_empty() {
            return;
        }
        if let Ok(mut guard) = self.lines.lock() {
            guard.push_back(cleaned);
            while guard.len() > MAX_STDERR_LINES {
                guard.pop_front();
            }
            while guard.iter().map(String::len).sum::<usize>() > MAX_STDERR_BYTES && guard.len() > 1
            {
                guard.pop_front();
            }
        }
    }

    pub fn format_trailer(&self) -> String {
        let Ok(guard) = self.lines.lock() else {
            return String::new();
        };
        if guard.is_empty() {
            return String::new();
        }
        let joined = guard.iter().cloned().collect::<Vec<_>>().join(" | ");
        format!(" — {}", sanitize_single_line(&joined, 260))
    }
}

/// Transport-neutral JSON-RPC 2.0 MCP session over line-delimited streams.
pub struct JsonRpcSession {
    writer: Box<dyn Write + Send>,
    rx: Receiver<StdoutMsg>,
    stderr_trailer: StderrTrailer,
    child: Option<Child>,
    next_id: u64,
    server_protocol: String,
    era: ProtocolEra,
    negotiated: bool,
    discover_info: Option<DiscoverResult>,
    server_info: Option<ServerInfo>,
    cached_tools: Option<Vec<String>>,
    config_command: String,
    config_db_path: PathBuf,
}

impl JsonRpcSession {
    /// Build a session from raw `Write` + stdout `Read` + optional stderr `Read` streams (no OS shell).
    pub fn from_streams<W, R, E>(
        writer: W,
        stdout: R,
        stderr: Option<E>,
        child: Option<Child>,
        command: String,
        db_path: PathBuf,
    ) -> Self
    where
        W: Write + Send + 'static,
        R: std::io::Read + Send + 'static,
        E: std::io::Read + Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        thread::Builder::new()
            .name("memos-mcp-stdout".to_string())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                let mut buf = String::new();
                loop {
                    buf.clear();
                    match reader.read_line(&mut buf) {
                        Ok(0) => {
                            let _ = tx.send(StdoutMsg::Eof);
                            break;
                        }
                        Ok(_) => {
                            let line = buf.trim_end_matches(['\r', '\n']).to_string();
                            if tx.send(StdoutMsg::Line(line)).is_err() {
                                break;
                            }
                        }
                        Err(err) => {
                            let _ = tx.send(StdoutMsg::IoError(err.to_string()));
                            break;
                        }
                    }
                }
            })
            .ok();

        let stderr_trailer = StderrTrailer::default();
        if let Some(err_stream) = stderr {
            let trailer = stderr_trailer.clone();
            thread::Builder::new()
                .name("memos-mcp-stderr".to_string())
                .spawn(move || {
                    let mut reader = BufReader::new(err_stream);
                    let mut buf = String::new();
                    loop {
                        buf.clear();
                        match reader.read_line(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(_) => trailer.push_line(&buf),
                        }
                    }
                })
                .ok();
        }

        Self {
            writer: Box::new(writer),
            rx,
            stderr_trailer,
            child,
            next_id: 2,
            server_protocol: MCP_PROTOCOL_VERSION.to_string(),
            era: ProtocolEra::Modern,
            negotiated: false,
            discover_info: None,
            server_info: None,
            cached_tools: None,
            config_command: command,
            config_db_path: db_path,
        }
    }

    pub fn kill_and_wait(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    pub fn era(&self) -> ProtocolEra {
        self.era
    }

    pub fn protocol_version(&self) -> &str {
        &self.server_protocol
    }

    /// Discover MCP 2026-07-28 capabilities via `server/discover` + `_meta`, falling back to
    /// the legacy `initialize` handshake (`2025-11-25`) only when required by the server.
    pub fn connect(&mut self, timeout: Duration) -> Result<(), BridgeError> {
        if self.negotiated {
            return Ok(());
        }
        let req_id = 1u64;
        let payload = json!({
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "server/discover",
            "params": {
                "_meta": modern_meta_envelope(),
            }
        });
        self.write_json_line(&payload).map_err(|e| match e {
            BridgeError::Io { reason } => BridgeError::NegotiationFailed { reason },
            other => other,
        })?;
        match self.read_response_for_id(req_id, timeout) {
            Ok(resp) => {
                let discover = parse_discover_result(&resp)?;
                if discover
                    .supported_versions
                    .iter()
                    .any(|v| v == MCP_PROTOCOL_VERSION)
                {
                    self.era = ProtocolEra::Modern;
                    self.server_protocol = MCP_PROTOCOL_VERSION.to_string();
                    self.server_info = discover.server_info.clone();
                    self.discover_info = Some(discover);
                    self.negotiated = true;
                    return Ok(());
                }
                self.legacy_initialize(timeout)
            }
            Err(err) if should_fallback_to_legacy_initialize(&err) => {
                self.legacy_initialize(timeout)
            }
            Err(err) => Err(err),
        }
    }

    fn legacy_initialize(&mut self, timeout: Duration) -> Result<(), BridgeError> {
        let req_id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        let payload = json!({
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "initialize",
            "params": {
                "protocolVersion": LEGACY_MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {
                    "name": MCP_CLIENT_NAME,
                    "version": MCP_CLIENT_VERSION,
                }
            }
        });
        self.write_json_line(&payload).map_err(|e| match e {
            BridgeError::Io { reason } => BridgeError::NegotiationFailed { reason },
            other => other,
        })?;
        let resp = self.read_response_for_id(req_id, timeout)?;
        self.era = ProtocolEra::Legacy;
        self.discover_info = None;
        self.server_protocol = resp
            .get("protocolVersion")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(LEGACY_MCP_PROTOCOL_VERSION)
            .to_string();
        self.server_info = parse_server_info(resp.get("serverInfo"));

        let notif = json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        });
        self.write_json_line(&notif).map_err(|e| match e {
            BridgeError::Io { reason } => BridgeError::NegotiationFailed { reason },
            other => other,
        })?;
        self.negotiated = true;
        Ok(())
    }

    pub fn list_tools(&mut self, timeout: Duration) -> Result<Vec<String>, BridgeError> {
        if !self.negotiated {
            self.connect(timeout)?;
        }
        let mut params = Map::new();
        if self.era == ProtocolEra::Modern {
            params.insert("_meta".to_string(), modern_meta_envelope());
        }
        let res = self.request("tools/list", Value::Object(params), timeout)?;
        let tools = res.get("tools").and_then(|v| v.as_array()).ok_or_else(|| {
            BridgeError::MalformedLine {
                detail: "tools/list response missing `tools` array".to_string(),
            }
        })?;
        let names: Vec<String> = tools
            .iter()
            .filter_map(|t| {
                t.get("name")
                    .and_then(|n| n.as_str())
                    .map(ToOwned::to_owned)
            })
            .collect();
        self.cached_tools = Some(names.clone());
        Ok(names)
    }

    pub fn ensure_tool_available(
        &mut self,
        tool_name: &str,
        timeout: Duration,
    ) -> Result<(), BridgeError> {
        if self.cached_tools.is_none() {
            self.list_tools(timeout)?;
        }
        let Some(tools) = self.cached_tools.as_ref() else {
            return Ok(());
        };
        if tools.iter().any(|t| t == tool_name) {
            Ok(())
        } else {
            Err(BridgeError::CapabilityMissing {
                tool: tool_name.to_string(),
                tool_count: tools.len(),
            })
        }
    }

    pub fn ping_info(&mut self, timeout: Duration) -> Result<PingResult, BridgeError> {
        let tool_names = self.list_tools(timeout)?;
        Ok(PingResult::from_tools(
            self.server_protocol.clone(),
            self.era,
            tool_names,
            self.server_info.clone(),
            self.discover_info.as_ref().and_then(|d| d.ttl_ms),
            self.discover_info
                .as_ref()
                .and_then(|d| d.cache_scope.clone()),
        ))
    }

    pub fn call_tool(
        &mut self,
        tool_name: &str,
        arguments: Value,
        timeout: Duration,
    ) -> Result<Value, BridgeError> {
        if !self.negotiated {
            self.connect(timeout)?;
        }
        let mut params = Map::new();
        params.insert("name".to_string(), Value::String(tool_name.to_string()));
        params.insert("arguments".to_string(), arguments);
        if self.era == ProtocolEra::Modern {
            params.insert("_meta".to_string(), modern_meta_envelope());
        }
        let res = self.request("tools/call", Value::Object(params), timeout)?;
        if res.get("isError").and_then(|v| v.as_bool()) == Some(true) {
            let msg = extract_tool_text(&res)
                .unwrap_or_else(|| format!("Tool `{tool_name}` reported an error"));
            return Err(BridgeError::ToolError {
                message: sanitize_single_line(&msg, 220),
            });
        }
        Ok(res)
    }

    fn request(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, BridgeError> {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        self.write_json_line(&payload)?;
        self.read_response_for_id(id, timeout)
    }

    fn write_json_line(&mut self, value: &Value) -> Result<(), BridgeError> {
        let mut line = serde_json::to_string(value).map_err(|e| BridgeError::Io {
            reason: sanitize_single_line(&e.to_string(), 160),
        })?;
        line.push('\n');
        self.writer
            .write_all(line.as_bytes())
            .and_then(|()| self.writer.flush())
            .map_err(|e| BridgeError::Io {
                reason: sanitize_single_line(&e.to_string(), 160),
            })
    }

    fn read_response_for_id(
        &mut self,
        expected_id: u64,
        timeout: Duration,
    ) -> Result<Value, BridgeError> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(BridgeError::Timeout {
                    timeout_ms: timeout.as_millis() as u64,
                });
            }
            match self.rx.recv_timeout(remaining) {
                Ok(StdoutMsg::Line(line)) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let msg: Value =
                        serde_json::from_str(trimmed).map_err(|e| BridgeError::MalformedLine {
                            detail: sanitize_single_line(&e.to_string(), 140),
                        })?;
                    let Some(obj) = msg.as_object() else {
                        return Err(BridgeError::MalformedLine {
                            detail: "response must be a JSON object".to_string(),
                        });
                    };
                    // Skip asynchronous notifications / unrelated server messages cleanly.
                    let msg_id = match obj.get("id") {
                        Some(Value::Number(n)) => n.as_u64(),
                        Some(Value::Null) | None => continue,
                        Some(_) => continue,
                    };
                    if msg_id != Some(expected_id) {
                        continue;
                    }
                    if let Some(err_val) = obj.get("error").filter(|v| !v.is_null()) {
                        let code = err_val
                            .get("code")
                            .and_then(|c| c.as_i64())
                            .unwrap_or(-32000);
                        let message = err_val
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("unknown RPC error")
                            .to_string();
                        return Err(BridgeError::RpcError {
                            code,
                            message: sanitize_single_line(&message, 220),
                        });
                    }
                    if let Some(res) = obj.get("result") {
                        return Ok(res.clone());
                    }
                    return Err(BridgeError::MalformedLine {
                        detail: "JSON-RPC response contained neither `result` nor `error`"
                            .to_string(),
                    });
                }
                Ok(StdoutMsg::Eof) => {
                    return Err(self.process_exited_error());
                }
                Ok(StdoutMsg::IoError(reason)) => {
                    return Err(BridgeError::Io {
                        reason: sanitize_single_line(&reason, 160),
                    });
                }
                Err(RecvTimeoutError::Timeout) => {
                    return Err(BridgeError::Timeout {
                        timeout_ms: timeout.as_millis() as u64,
                    });
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(self.process_exited_error());
                }
            }
        }
    }

    fn process_exited_error(&mut self) -> BridgeError {
        let status = if let Some(ref mut child) = self.child {
            match child.try_wait() {
                Ok(Some(code)) => format!("{code}"),
                Ok(None) => match child.wait() {
                    Ok(code) => format!("{code}"),
                    Err(_) => "closed stdout".to_string(),
                },
                Err(_) => "closed stdout".to_string(),
            }
        } else {
            "EOF".to_string()
        };
        BridgeError::ProcessExited {
            status,
            trailer: self.stderr_trailer.format_trailer(),
        }
    }
}

impl Drop for JsonRpcSession {
    fn drop(&mut self) {
        self.kill_and_wait();
    }
}

struct BridgeInner {
    config: WriteBridgeConfig,
    session: Option<JsonRpcSession>,
    last_ping: Option<PingResult>,
}

/// Persistent stdio MCP client delegating all MemOS writes to an external writer process.
///
/// The desktop Rust layer keeps SQLite strictly read-only; this bridge spawns a single child
/// process over stdin/stdout JSON-RPC 2.0 and kills it cleanly on error or drop.
pub struct WriteBridge {
    inner: Mutex<BridgeInner>,
}

impl WriteBridge {
    pub fn new(command: impl Into<String>, db_path: PathBuf) -> Self {
        Self::with_config(WriteBridgeConfig::new(command, db_path))
    }

    pub fn with_config(config: WriteBridgeConfig) -> Self {
        Self {
            inner: Mutex::new(BridgeInner {
                config,
                session: None,
                last_ping: None,
            }),
        }
    }

    pub fn configure(&self, command: &str, db_path: &Path) {
        if let Ok(mut guard) = self.inner.lock() {
            let trimmed = command.trim();
            let effective = if trimmed.is_empty() {
                recommended_writer_command()
            } else {
                trimmed.to_string()
            };
            if guard.config.command != effective || guard.config.db_path != db_path {
                guard.config.command = effective;
                guard.config.db_path = db_path.to_path_buf();
                guard.last_ping = None;
                if let Some(mut sess) = guard.session.take() {
                    sess.kill_and_wait();
                }
            }
        }
    }

    pub fn command_string(&self) -> String {
        self.inner
            .lock()
            .map(|g| g.config.command.clone())
            .unwrap_or_else(|_| recommended_writer_command())
    }

    /// Cached capability summary for the active session, if connected or previously probed.
    pub fn connected_info(&self) -> Option<PingResult> {
        self.inner.lock().ok().and_then(|g| g.last_ping.clone())
    }

    /// Check cached tool list for `tool_name` without spawning if not yet connected.
    pub fn cached_supports_tool(&self, tool_name: &str) -> Option<Result<(), BridgeError>> {
        let guard = self.inner.lock().ok()?;
        let ping = guard.last_ping.as_ref()?;
        if ping.tool_names.is_empty() {
            return None;
        }
        if ping.supports_tool(tool_name) {
            Some(Ok(()))
        } else {
            Some(Err(BridgeError::CapabilityMissing {
                tool: tool_name.to_string(),
                tool_count: ping.tool_count,
            }))
        }
    }

    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.last_ping = None;
            if let Some(mut sess) = guard.session.take() {
                sess.kill_and_wait();
            }
        }
    }

    /// Ensure the child process is connected (`server/discover` or legacy fallback) and responds to `tools/list`.
    pub fn ping(&self) -> Result<PingResult, BridgeError> {
        self.with_session(|sess, timeout| sess.ping_info(timeout))
    }

    /// Verify a capability (e.g. `memos_review`, `memos_ingest`, `memos_audit_answer`,
    /// `memos_explain_recall`) is registered on the active writer, returning a human capability
    /// error instead of a JSON-RPC `-32602` code when absent.
    pub fn ensure_capability(&self, tool_name: &str) -> Result<(), BridgeError> {
        self.with_session(|sess, timeout| sess.ensure_tool_available(tool_name, timeout))
    }

    /// Call `memos_store` and return the created memory node ID.
    pub fn store(&self, input: StoreInput) -> Result<StoreResult, BridgeError> {
        let mut args = Map::new();
        args.insert("content".to_string(), Value::String(input.content));
        if let Some(node_type) = input.node_type.filter(|s| !s.trim().is_empty()) {
            args.insert(
                "type".to_string(),
                Value::String(node_type.trim().to_string()),
            );
        }
        let tags: Vec<Value> = input
            .tags
            .into_iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .map(Value::String)
            .collect();
        if !tags.is_empty() {
            args.insert("tags".to_string(), Value::Array(tags));
        }
        if let Some(ns) = input.namespace.filter(|s| !s.trim().is_empty()) {
            args.insert(
                "namespace".to_string(),
                Value::String(ns.trim().to_string()),
            );
        }
        if let Some(pool) = input.pool.filter(|s| !s.trim().is_empty()) {
            args.insert("pool".to_string(), Value::String(pool.trim().to_string()));
        }
        if let Some(ctx) = input.context.filter(|s| !s.trim().is_empty()) {
            args.insert("context".to_string(), Value::String(ctx.trim().to_string()));
        }

        self.with_session(|sess, timeout| {
            let res = sess.call_tool("memos_store", Value::Object(args), timeout)?;
            parse_store_result(&res)
        })
    }

    /// Call `memos_forget` for a memory ID.
    pub fn forget(&self, id: &str) -> Result<ForgetResult, BridgeError> {
        let target_id = id.to_string();
        self.with_session(|sess, timeout| {
            let res = sess.call_tool("memos_forget", json!({ "id": target_id }), timeout)?;
            parse_forget_result(id, &res)
        })
    }

    /// Call `memos_supersede` to mark `id` superseded by `replacement_id`.
    pub fn supersede(
        &self,
        id: &str,
        replacement_id: Option<&str>,
    ) -> Result<SupersedeResult, BridgeError> {
        let mut args = Map::new();
        args.insert("id".to_string(), Value::String(id.to_string()));
        if let Some(rep) = replacement_id.filter(|s| !s.trim().is_empty()) {
            args.insert("replacementId".to_string(), Value::String(rep.to_string()));
        }
        self.with_session(|sess, timeout| {
            let res = sess.call_tool("memos_supersede", Value::Object(args), timeout)?;
            parse_supersede_result(id, replacement_id, &res)
        })
    }

    /// Call `memos_link` between two memories.
    pub fn link(&self, input: LinkInput) -> Result<LinkResult, BridgeError> {
        let mut args = Map::new();
        args.insert(
            "sourceId".to_string(),
            Value::String(input.source_id.clone()),
        );
        args.insert(
            "targetId".to_string(),
            Value::String(input.target_id.clone()),
        );
        if let Some(rel) = input.relation.as_deref().filter(|s| !s.trim().is_empty()) {
            args.insert(
                "relation".to_string(),
                Value::String(rel.trim().to_string()),
            );
        }
        if let Some(weight) = input.weight {
            args.insert("weight".to_string(), json!(weight));
        }
        self.with_session(|sess, timeout| {
            let res = sess.call_tool("memos_link", Value::Object(args), timeout)?;
            Ok(parse_link_result(&input, &res))
        })
    }

    /// Call `memos_review` (`list`, `approve`, or `reject`) after confirming tool availability.
    pub fn review(&self, input: ReviewInput) -> Result<ReviewResult, BridgeError> {
        let mut args = Map::new();
        args.insert("action".to_string(), Value::String(input.action.clone()));
        if let Some(id) = input.id.as_deref().filter(|s| !s.trim().is_empty()) {
            args.insert("id".to_string(), Value::String(id.to_string()));
        }
        if let Some(ns) = input.namespace.as_deref().filter(|s| !s.trim().is_empty()) {
            args.insert("namespace".to_string(), Value::String(ns.to_string()));
        }
        self.with_session(|sess, timeout| {
            sess.ensure_tool_available("memos_review", timeout)?;
            let res = sess.call_tool("memos_review", Value::Object(args), timeout)?;
            Ok(parse_review_result(&input.action, &res))
        })
    }

    /// Call `memos_ingest` for a file or folder through the MCP child process (never reads or
    /// parses file contents in Rust).
    pub fn ingest(&self, input: IngestInput) -> Result<IngestResult, BridgeError> {
        let target = input.path.trim();
        if target.is_empty() {
            return Err(BridgeError::ToolError {
                message: "Select a file or folder to ingest.".to_string(),
            });
        }

        let ingest_timeout = Duration::from_secs(60);
        self.ensure_capability("memos_ingest")?;

        let target_path = PathBuf::from(target);
        if !input.recursive && target_path.is_dir() {
            let entries = std::fs::read_dir(&target_path).map_err(|e| BridgeError::ToolError {
                message: format!("Could not open folder: {e}"),
            })?;
            let allowed: Option<Vec<String>> = if input.extensions.is_empty() {
                None
            } else {
                Some(
                    input
                        .extensions
                        .iter()
                        .map(|e| e.to_ascii_lowercase())
                        .collect(),
                )
            };
            let mut file_paths = Vec::new();
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                if let Some(exts) = &allowed {
                    let matches_ext = path
                        .extension()
                        .and_then(|s| s.to_str())
                        .map(|s| format!(".{}", s.to_ascii_lowercase()))
                        .is_some_and(|dot_ext| {
                            exts.iter().any(|allowed_ext| allowed_ext == &dot_ext)
                        });
                    if !matches_ext {
                        continue;
                    }
                }
                file_paths.push(path.to_string_lossy().to_string());
            }
            if file_paths.is_empty() {
                return Ok(IngestResult::default());
            }
            let mut combined = IngestResult::default();
            for file_path in file_paths {
                let args = build_ingest_tool_args(&input, &file_path);
                let partial = self.with_session_timeout(Some(ingest_timeout), |sess, t| {
                    let res = sess.call_tool("memos_ingest", args, t)?;
                    parse_ingest_result(&res)
                })?;
                combined.accumulate(&partial);
            }
            return Ok(combined);
        }

        let args = build_ingest_tool_args(&input, target);
        self.with_session_timeout(Some(ingest_timeout), |sess, t| {
            let res = sess.call_tool("memos_ingest", args, t)?;
            parse_ingest_result(&res)
        })
    }

    fn with_session<T, F>(&self, op: F) -> Result<T, BridgeError>
    where
        F: FnOnce(&mut JsonRpcSession, Duration) -> Result<T, BridgeError>,
    {
        self.with_session_timeout(None, op)
    }

    fn with_session_timeout<T, F>(
        &self,
        timeout_override: Option<Duration>,
        op: F,
    ) -> Result<T, BridgeError>
    where
        F: FnOnce(&mut JsonRpcSession, Duration) -> Result<T, BridgeError>,
    {
        let mut guard = self.inner.lock().map_err(|_| BridgeError::Io {
            reason: "write bridge lock poisoned".to_string(),
        })?;
        let config = guard.config.clone();

        let needs_spawn = match guard.session.as_mut() {
            None => true,
            Some(sess) => {
                if sess.config_command != config.command || sess.config_db_path != config.db_path {
                    true
                } else if let Some(ref mut child) = sess.child {
                    matches!(child.try_wait(), Ok(Some(_)) | Err(_))
                } else {
                    false
                }
            }
        };
        if needs_spawn {
            if let Some(mut old) = guard.session.take() {
                old.kill_and_wait();
            }
            guard.last_ping = None;
            let mut sess = spawn_stdio_session(&config)?;
            if let Err(err) = sess.connect(config.timeout) {
                sess.kill_and_wait();
                return Err(err);
            }
            guard.session = Some(sess);
        }

        let timeout = timeout_override.unwrap_or(config.timeout);
        let res = {
            let Some(sess) = guard.session.as_mut() else {
                return Err(BridgeError::Io {
                    reason: "session unavailable".to_string(),
                });
            };
            op(sess, timeout)
        };
        if let Some(sess) = guard.session.as_ref()
            && res.is_ok()
        {
            let cached_tools = sess.cached_tools.clone().unwrap_or_default();
            guard.last_ping = Some(PingResult::from_tools(
                sess.server_protocol.clone(),
                sess.era,
                cached_tools,
                sess.server_info.clone(),
                sess.discover_info.as_ref().and_then(|d| d.ttl_ms),
                sess.discover_info
                    .as_ref()
                    .and_then(|d| d.cache_scope.clone()),
            ));
        }
        if matches!(
            &res,
            Err(BridgeError::Timeout { .. }
                | BridgeError::MalformedLine { .. }
                | BridgeError::ProcessExited { .. }
                | BridgeError::Io { .. }
                | BridgeError::NegotiationFailed { .. })
        ) {
            guard.last_ping = None;
            if let Some(mut dead) = guard.session.take() {
                dead.kill_and_wait();
            }
        }
        res
    }
}

impl Drop for WriteBridge {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Split a command string into executable + arguments without invoking an OS shell.
pub fn parse_command_tokens(raw: &str) -> Result<Vec<String>, BridgeError> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut token_started = false;
    let mut chars = raw.chars().peekable();

    while let Some(ch) = chars.next() {
        if in_single {
            if ch == '\'' {
                in_single = false;
            } else {
                current.push(ch);
            }
            continue;
        }
        if in_double {
            if ch == '"' {
                in_double = false;
            } else if ch == '\\' {
                if let Some(&next) = chars.peek()
                    && (next == '"' || next == '\\')
                {
                    current.push(next);
                    chars.next();
                } else {
                    current.push('\\');
                }
            } else {
                current.push(ch);
            }
            continue;
        }
        match ch {
            c if c.is_whitespace() => {
                if token_started {
                    tokens.push(std::mem::take(&mut current));
                    token_started = false;
                }
            }
            '\'' => {
                in_single = true;
                token_started = true;
            }
            '"' => {
                in_double = true;
                token_started = true;
            }
            _ => {
                current.push(ch);
                token_started = true;
            }
        }
    }

    if in_single || in_double {
        return Err(BridgeError::InvalidCommand {
            reason: "unclosed quote in writer command".to_string(),
        });
    }
    if token_started {
        tokens.push(current);
    }
    if tokens.is_empty() {
        return Err(BridgeError::InvalidCommand {
            reason: "writer command cannot be empty".to_string(),
        });
    }
    Ok(tokens)
}

fn resolve_executable(prog: &str, path_env: Option<&OsString>) -> PathBuf {
    let candidate = Path::new(prog);
    #[cfg(target_os = "windows")]
    {
        if candidate.is_file() {
            return candidate.to_path_buf();
        }
        if candidate.extension().is_none() && !prog.contains('\\') && !prog.contains('/') {
            if let Some(path_var) = path_env {
                let exts = [".exe", ".cmd", ".bat"];
                for dir in env::split_paths(path_var) {
                    for ext in exts {
                        let full = dir.join(format!("{prog}{ext}"));
                        if full.is_file() {
                            return full;
                        }
                    }
                }
            }
            if prog.eq_ignore_ascii_case("node") {
                for env_key in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
                    if let Some(base) = env::var_os(env_key) {
                        let cand = PathBuf::from(base).join("nodejs").join("node.exe");
                        if cand.is_file() {
                            return cand;
                        }
                    }
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = path_env;
    candidate.to_path_buf()
}

/// Parse a writer command and append `--db <db_path>` for MemOS `mcp` invocations unless overridden.
pub fn build_writer_args(
    raw: &str,
    db_path: &Path,
) -> Result<(String, Vec<OsString>), BridgeError> {
    let tokens = parse_command_tokens(raw)?;
    let prog = tokens[0].clone();
    let mut args: Vec<OsString> = tokens[1..].iter().map(OsString::from).collect();
    let is_memos_mcp = tokens[1..].iter().any(|t| t == "mcp")
        || Path::new(&prog)
            .file_stem()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("memos-mcp"));
    let has_db_flag = tokens[1..]
        .iter()
        .any(|t| t == "--db" || t.starts_with("--db="));
    if is_memos_mcp && !has_db_flag {
        args.push(OsString::from("--db"));
        args.push(db_path.as_os_str().to_os_string());
    }
    Ok((prog, args))
}

fn spawn_stdio_session(config: &WriteBridgeConfig) -> Result<JsonRpcSession, BridgeError> {
    let (prog_raw, args) = build_writer_args(&config.command, &config.db_path)?;
    let program = resolve_executable(&prog_raw, env::var_os("PATH").as_ref());

    let mut cmd = Command::new(&program);
    cmd.args(args)
        .env("MEMOS_DB_PATH", &config.db_path)
        .env("MEMOS_MCP_TOOLS", "all")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in &config.extra_env {
        cmd.env(k, v);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| BridgeError::SpawnFailed {
        command: config.command.clone(),
        reason: sanitize_single_line(&e.to_string(), 180),
    })?;
    let stdin = child.stdin.take().ok_or_else(|| BridgeError::SpawnFailed {
        command: config.command.clone(),
        reason: "child stdin pipe unavailable".to_string(),
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| BridgeError::SpawnFailed {
            command: config.command.clone(),
            reason: "child stdout pipe unavailable".to_string(),
        })?;
    let stderr = child.stderr.take();

    Ok(JsonRpcSession::from_streams(
        stdin,
        stdout,
        stderr,
        Some(child),
        config.command.clone(),
        config.db_path.clone(),
    ))
}

fn extract_tool_text(res: &Value) -> Option<String> {
    let arr = res.get("content")?.as_array()?;
    let parts: Vec<String> = arr
        .iter()
        .filter_map(|item| {
            item.get("text")
                .and_then(|t| t.as_str())
                .map(ToOwned::to_owned)
        })
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn parse_store_result(res: &Value) -> Result<StoreResult, BridgeError> {
    if let Some(sc) = res.get("structuredContent") {
        if sc.get("skipped").and_then(|v| v.as_bool()) == Some(true) {
            let reason = sc
                .get("reason")
                .and_then(|r| r.as_str())
                .unwrap_or("skipped by salience filter");
            return Err(BridgeError::ToolError {
                message: format!("Memory was not stored ({reason})"),
            });
        }
        if let Some(id) = sc
            .get("node")
            .and_then(|n| n.get("id"))
            .and_then(|v| v.as_str())
            .or_else(|| sc.get("id").and_then(|v| v.as_str()))
            && !id.trim().is_empty()
        {
            return Ok(StoreResult { id: id.to_string() });
        }
    }
    if let Some(text) = extract_tool_text(res) {
        if let Ok(parsed) = serde_json::from_str::<Value>(&text)
            && let Some(id) = parsed
                .get("node")
                .and_then(|n| n.get("id"))
                .and_then(|v| v.as_str())
                .or_else(|| parsed.get("id").and_then(|v| v.as_str()))
        {
            return Ok(StoreResult { id: id.to_string() });
        }
        if let Some(rest) = text.trim().strip_prefix("Stored memory ") {
            let id = rest.trim_end_matches('.').trim();
            if !id.is_empty() {
                return Ok(StoreResult { id: id.to_string() });
            }
        }
    }
    Err(BridgeError::MalformedLine {
        detail: "memos_store response missing created node id".to_string(),
    })
}

fn parse_forget_result(expected_id: &str, res: &Value) -> Result<ForgetResult, BridgeError> {
    if let Some(sc) = res.get("structuredContent") {
        let id = sc
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or(expected_id)
            .to_string();
        let deleted = sc.get("deleted").and_then(|v| v.as_bool()).unwrap_or(true);
        return Ok(ForgetResult { id, deleted });
    }
    Ok(ForgetResult {
        id: expected_id.to_string(),
        deleted: true,
    })
}

fn parse_supersede_result(
    id: &str,
    replacement_id: Option<&str>,
    res: &Value,
) -> Result<SupersedeResult, BridgeError> {
    if let Some(sc) = res.get("structuredContent") {
        let superseded = sc.get("node").is_some_and(|n| !n.is_null());
        if !superseded {
            return Err(BridgeError::ToolError {
                message: format!("Memory {id} not found to supersede"),
            });
        }
        return Ok(SupersedeResult {
            id: id.to_string(),
            replacement_id: replacement_id.map(ToOwned::to_owned),
            superseded: true,
        });
    }
    Ok(SupersedeResult {
        id: id.to_string(),
        replacement_id: replacement_id.map(ToOwned::to_owned),
        superseded: true,
    })
}

fn parse_link_result(input: &LinkInput, res: &Value) -> LinkResult {
    let sc = res.get("structuredContent").and_then(|s| s.get("edge"));
    let relation = sc
        .and_then(|e| e.get("relation"))
        .and_then(|v| v.as_str())
        .map(ToOwned::to_owned)
        .or_else(|| input.relation.clone());
    LinkResult {
        source_id: input.source_id.clone(),
        target_id: input.target_id.clone(),
        relation,
    }
}

fn parse_review_result(action: &str, res: &Value) -> ReviewResult {
    let summary = extract_tool_text(res).unwrap_or_else(|| action.to_string());
    let items_arr = res
        .get("structuredContent")
        .and_then(|sc| {
            sc.get("result")
                .and_then(|r| r.get("items"))
                .or_else(|| sc.get("items"))
        })
        .and_then(|v| v.as_array());

    let mut items = Vec::new();
    if let Some(arr) = items_arr {
        for raw in arr {
            let Some(id) = raw.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            let content = raw
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let raw_summary = raw.get("summary").and_then(|v| v.as_str()).unwrap_or("");
            let preview_src = if !raw_summary.trim().is_empty() {
                raw_summary
            } else {
                &content
            };
            let preview = crate::core::model::make_single_line_preview(preview_src, 180);
            let node_type = raw
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("fact")
                .to_string();
            let namespace = raw
                .get("namespace")
                .and_then(|v| v.as_str())
                .unwrap_or("default")
                .to_string();
            let created_at = raw.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);
            let meta = raw.get("metadata");
            let confidence = meta
                .and_then(|m| m.get("confidence"))
                .and_then(|v| v.as_f64())
                .map(|c| c as f32);
            let reason = meta
                .and_then(|m| {
                    m.get("reviewReason")
                        .or_else(|| m.get("reason"))
                        .and_then(|v| v.as_str())
                })
                .or_else(|| {
                    raw.get("quarantineReason")
                        .and_then(|v| v.as_str())
                        .filter(|s| *s != "review:pending")
                })
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned);

            items.push(ReviewQueueItem {
                short_id: crate::core::model::short_citation_id(id),
                id: id.to_string(),
                preview,
                content,
                node_type,
                namespace,
                created_at,
                confidence,
                reason,
            });
        }
    }

    ReviewResult {
        action: action.to_string(),
        summary,
        items,
    }
}

fn parse_ingest_result(res: &Value) -> Result<IngestResult, BridgeError> {
    let sc = res.get("structuredContent");
    let parsed_text = extract_tool_text(res).and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let obj = sc
        .or(parsed_text.as_ref())
        .ok_or_else(|| BridgeError::MalformedLine {
            detail: "memos_ingest response missing result counts".to_string(),
        })?;
    let get_count = |key: &str| {
        obj.get(key)
            .and_then(|v| v.as_u64())
            .map(|n| n as usize)
            .unwrap_or(0)
    };
    Ok(IngestResult {
        added: get_count("added"),
        updated: get_count("updated"),
        unchanged: get_count("unchanged"),
        removed: get_count("removed"),
        skipped: get_count("skipped"),
        errors: get_count("errors"),
        chunks: get_count("chunks"),
    })
}

/// Whether a failed `server/discover` attempt should fall back to legacy `initialize` (`2025-11-25`).
pub fn should_fallback_to_legacy_initialize(err: &BridgeError) -> bool {
    match err {
        BridgeError::RpcError { code, message } => {
            *code == -32022 || *code == -32601 || *code == -32602 || *code == -32600 || {
                let lower = message.to_ascii_lowercase();
                lower.contains("_meta")
                    || lower.contains("envelope")
                    || lower.contains("unsupported protocol")
                    || lower.contains("method not found")
            }
        }
        _ => false,
    }
}

fn parse_server_info(val: Option<&Value>) -> Option<ServerInfo> {
    let obj = val?.as_object()?;
    let name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();
    let version = obj
        .get("version")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    Some(ServerInfo { name, version })
}

pub fn parse_discover_result(res: &Value) -> Result<DiscoverResult, BridgeError> {
    let arr = res
        .get("supportedVersions")
        .and_then(|v| v.as_array())
        .ok_or_else(|| BridgeError::MalformedLine {
            detail: "server/discover response missing `supportedVersions` array".to_string(),
        })?;
    let supported_versions: Vec<String> = arr
        .iter()
        .filter_map(|v| v.as_str().map(str::trim).filter(|s| !s.is_empty()))
        .map(ToOwned::to_owned)
        .collect();
    let capabilities = res.get("capabilities").cloned().unwrap_or(Value::Null);
    let server_info = parse_server_info(
        res.get("_meta")
            .and_then(|m| m.get(MCP_META_SERVER_INFO))
            .or_else(|| res.get("serverInfo")),
    );
    let ttl_ms = res.get("ttlMs").and_then(|v| v.as_u64());
    let cache_scope = res
        .get("cacheScope")
        .and_then(|v| v.as_str())
        .map(ToOwned::to_owned);
    let result_type = res
        .get("resultType")
        .and_then(|v| v.as_str())
        .map(ToOwned::to_owned);
    Ok(DiscoverResult {
        supported_versions,
        capabilities,
        server_info,
        ttl_ms,
        cache_scope,
        result_type,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalWriterSource {
    PathBinary,
    RepoDistCli,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DetectedLocalWriter {
    pub command: String,
    pub display_path: String,
    pub source: LocalWriterSource,
}

pub fn quote_command_arg(arg: &str) -> String {
    if !arg.is_empty()
        && !arg
            .chars()
            .any(|c| c.is_whitespace() || c == '"' || c == '\'')
    {
        return arg.to_string();
    }
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    for ch in arg.chars() {
        if ch == '\\' || ch == '"' {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('"');
    out
}

fn is_cargo_target_binary(path: &Path) -> bool {
    let mut comps = path.ancestors().skip(1);
    if let Some(profile_dir) = comps.next()
        && let Some(profile_name) = profile_dir.file_name().and_then(|s| s.to_str())
        && (profile_name.eq_ignore_ascii_case("debug")
            || profile_name.eq_ignore_ascii_case("release"))
        && let Some(parent_dir) = profile_dir.parent()
        && let Some(parent_name) = parent_dir.file_name().and_then(|s| s.to_str())
    {
        return parent_name.eq_ignore_ascii_case("target")
            || parent_name.to_ascii_lowercase().contains("cargo-target");
    }
    false
}

fn find_memos_binary_on_path(path_env: Option<&OsString>) -> Option<PathBuf> {
    let path_var = path_env?;
    #[cfg(target_os = "windows")]
    let candidates = ["memos.cmd", "memos.bat", "memos.exe", "memos"];
    #[cfg(not(target_os = "windows"))]
    let candidates = ["memos"];

    for dir in env::split_paths(path_var) {
        for name in candidates {
            let full = dir.join(name);
            if full.is_file() && !is_cargo_target_binary(&full) {
                return Some(full);
            }
        }
    }
    None
}

fn candidate_dist_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let mut push_unique = |p: PathBuf| {
        if !roots.contains(&p) {
            roots.push(p);
        }
    };
    if let Ok(exe) = env::current_exe()
        && let Some(parent) = exe.parent()
    {
        push_unique(parent.to_path_buf());
    }
    if let Ok(cwd) = env::current_dir() {
        push_unique(cwd);
    }
    push_unique(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    roots
}

/// Detect a local MemOS MCP entrypoint without hardcoding any user directory:
/// 1) `memos` binary on `PATH` -> `memos mcp`
/// 2) `dist/cli.js` relative to the app executable, working directory, or source tree -> `node <cli.js> mcp`
pub fn detect_local_writer_in(
    path_env: Option<&OsString>,
    search_roots: &[PathBuf],
) -> Option<DetectedLocalWriter> {
    if let Some(bin) = find_memos_binary_on_path(path_env) {
        return Some(DetectedLocalWriter {
            command: FALLBACK_WRITER_COMMAND.to_string(),
            display_path: bin.to_string_lossy().to_string(),
            source: LocalWriterSource::PathBinary,
        });
    }
    for root in search_roots {
        for ancestor in root.ancestors() {
            let cli_js = ancestor.join("dist").join("cli.js");
            if cli_js.is_file() {
                let path_str = cli_js.to_string_lossy().to_string();
                return Some(DetectedLocalWriter {
                    command: format!("node {} mcp", quote_command_arg(&path_str)),
                    display_path: path_str,
                    source: LocalWriterSource::RepoDistCli,
                });
            }
        }
    }
    None
}

pub fn detect_local_writer() -> Option<DetectedLocalWriter> {
    detect_local_writer_in(env::var_os("PATH").as_ref(), &candidate_dist_roots())
}

/// Preferred writer command: local `memos` on PATH -> repo `dist/cli.js mcp` -> `npx -y @mem-os/sdk mcp`.
pub fn recommended_writer_command() -> String {
    detect_local_writer()
        .map(|d| d.command)
        .unwrap_or_else(|| DEFAULT_WRITER_COMMAND.to_string())
}

fn sanitize_single_line(raw: &str, max_chars: usize) -> String {
    let compact: String = raw
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut out = String::new();
    for (ix, ch) in compact.chars().enumerate() {
        if ix >= max_chars {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::Sender;

    struct ChannelWriter {
        tx: Sender<String>,
        buf: Vec<u8>,
    }

    impl ChannelWriter {
        fn new(tx: Sender<String>) -> Self {
            Self {
                tx,
                buf: Vec::new(),
            }
        }
    }

    impl Write for ChannelWriter {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.buf.extend_from_slice(data);
            while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
                let line = String::from_utf8_lossy(&self.buf[..pos]).to_string();
                self.buf.drain(..=pos);
                let _ = self.tx.send(line);
            }
            Ok(data.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct DuplexServerHandle {
        to_server_rx: Receiver<String>,
        from_server_tx: Sender<Vec<u8>>,
        err_tx: Sender<Vec<u8>>,
    }

    struct ChannelReader {
        rx: Receiver<Vec<u8>>,
        cur: Vec<u8>,
        pos: usize,
    }

    impl ChannelReader {
        fn new(rx: Receiver<Vec<u8>>) -> Self {
            Self {
                rx,
                cur: Vec::new(),
                pos: 0,
            }
        }
    }

    impl std::io::Read for ChannelReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            while self.pos >= self.cur.len() {
                match self.rx.recv() {
                    Ok(chunk) if chunk.is_empty() => return Ok(0),
                    Ok(chunk) => {
                        self.cur = chunk;
                        self.pos = 0;
                    }
                    Err(_) => return Ok(0),
                }
            }
            let avail = &self.cur[self.pos..];
            let n = avail.len().min(buf.len());
            buf[..n].copy_from_slice(&avail[..n]);
            self.pos += n;
            Ok(n)
        }
    }

    fn make_pipe_session() -> (JsonRpcSession, DuplexServerHandle) {
        let (to_srv_tx, to_srv_rx) = mpsc::channel();
        let (from_srv_tx, from_srv_rx) = mpsc::channel();
        let (err_tx, err_rx) = mpsc::channel();
        let session = JsonRpcSession::from_streams(
            ChannelWriter::new(to_srv_tx),
            ChannelReader::new(from_srv_rx),
            Some(ChannelReader::new(err_rx)),
            None,
            "fake-mcp".to_string(),
            PathBuf::from("fake.db"),
        );
        let handle = DuplexServerHandle {
            to_server_rx: to_srv_rx,
            from_server_tx: from_srv_tx,
            err_tx,
        };
        (session, handle)
    }

    fn send_json_line(tx: &Sender<Vec<u8>>, val: &Value) {
        let mut s = serde_json::to_string(val).unwrap();
        s.push('\n');
        let _ = tx.send(s.into_bytes());
    }

    #[test]
    fn command_tokenizer_preserves_quotes_and_windows_paths() {
        assert_eq!(
            parse_command_tokens("npx -y @mem-os/sdk mcp").unwrap(),
            vec!["npx", "-y", "@mem-os/sdk", "mcp"]
        );
        assert_eq!(
            parse_command_tokens(r#""C:\Program Files\nodejs\node.exe" 'dist\cli.js' mcp"#)
                .unwrap(),
            vec![r"C:\Program Files\nodejs\node.exe", r"dist\cli.js", "mcp"]
        );
        assert_eq!(
            parse_command_tokens(r"C:\Users\marki\memos.exe mcp").unwrap(),
            vec![r"C:\Users\marki\memos.exe", "mcp"]
        );
        assert!(matches!(
            parse_command_tokens("   "),
            Err(BridgeError::InvalidCommand { .. })
        ));
        assert!(matches!(
            parse_command_tokens("npx \"unterminated"),
            Err(BridgeError::InvalidCommand { .. })
        ));
    }

    #[test]
    fn writer_args_append_resolved_db_for_memos_mcp() {
        let db = Path::new("/tmp/custom memos.db");
        let (prog, args) = build_writer_args("npx -y @mem-os/sdk mcp", db).unwrap();
        assert_eq!(prog, "npx");
        assert_eq!(
            args,
            vec![
                OsString::from("-y"),
                OsString::from("@mem-os/sdk"),
                OsString::from("mcp"),
                OsString::from("--db"),
                OsString::from("/tmp/custom memos.db"),
            ]
        );

        let (prog2, args2) =
            build_writer_args("memos mcp --db /override.db", Path::new("/ignored.db")).unwrap();
        assert_eq!(prog2, "memos");
        assert_eq!(
            args2,
            vec![
                OsString::from("mcp"),
                OsString::from("--db"),
                OsString::from("/override.db"),
            ]
        );

        let (prog3, args3) = build_writer_args("python mock_writer.py", db).unwrap();
        assert_eq!(prog3, "python");
        assert_eq!(args3, vec![OsString::from("mock_writer.py")]);
    }

    fn make_bridge_from_session(sess: JsonRpcSession) -> WriteBridge {
        WriteBridge {
            inner: Mutex::new(BridgeInner {
                config: WriteBridgeConfig::new("fake-mcp", PathBuf::from("fake.db")),
                session: Some(sess),
                last_ping: None,
            }),
        }
    }

    fn assert_modern_meta(req: &Value) {
        let meta = &req["params"]["_meta"];
        assert_eq!(meta[MCP_META_PROTOCOL_VERSION], MCP_PROTOCOL_VERSION);
        assert_eq!(meta[MCP_META_CLIENT_INFO]["name"], MCP_CLIENT_NAME);
        assert_eq!(meta[MCP_META_CLIENT_INFO]["version"], MCP_CLIENT_VERSION);
        assert_eq!(meta[MCP_META_CLIENT_CAPABILITIES], json!({}));
    }

    fn sample_discover_ok() -> Value {
        json!({
            "supportedVersions": [MCP_PROTOCOL_VERSION],
            "capabilities": { "tools": { "listChanged": true } },
            "resultType": "complete",
            "ttlMs": 600000,
            "cacheScope": "private",
            "_meta": {
                "io.modelcontextprotocol/serverInfo": {
                    "name": "memos",
                    "version": "1.6.27"
                }
            }
        })
    }

    #[test]
    fn modern_discover_frame_and_meta_on_tools_list_and_call() {
        let (mut sess, srv) = make_pipe_session();
        let server_thread = thread::spawn(move || {
            let disc_raw = srv.to_server_rx.recv().unwrap();
            let disc: Value = serde_json::from_str(&disc_raw).unwrap();
            assert_eq!(disc["method"], "server/discover");
            assert_modern_meta(&disc);
            // Emit a server notification before server/discover response to verify framing.
            send_json_line(
                &srv.from_server_tx,
                &json!({"jsonrpc":"2.0","method":"notifications/progress","params":{"step":1}}),
            );
            send_json_line(
                &srv.from_server_tx,
                &json!({"jsonrpc":"2.0","id":disc["id"],"result":sample_discover_ok()}),
            );

            // 1. tools/list must include modern _meta
            let list_req: Value = serde_json::from_str(&srv.to_server_rx.recv().unwrap()).unwrap();
            assert_eq!(list_req["method"], "tools/list");
            assert_modern_meta(&list_req);
            send_json_line(
                &srv.from_server_tx,
                &json!({"jsonrpc":"2.0","id":list_req["id"],"result":{"tools":[
                    {"name":"memos_store"},
                    {"name":"memos_forget"},
                    {"name":"memos_supersede"},
                    {"name":"memos_link"},
                    {"name":"memos_review"},
                    {"name":"memos_ingest"},
                    {"name":"memos_audit_answer"},
                    {"name":"memos_explain_recall"}
                ]}}),
            );

            // 2. memos_store (with _meta)
            let store_req: Value = serde_json::from_str(&srv.to_server_rx.recv().unwrap()).unwrap();
            assert_eq!(store_req["method"], "tools/call");
            assert_modern_meta(&store_req);
            assert_eq!(store_req["params"]["name"], "memos_store");
            assert_eq!(
                store_req["params"]["arguments"]["content"],
                "Dark mode default"
            );
            send_json_line(
                &srv.from_server_tx,
                &json!({"jsonrpc":"2.0","id":store_req["id"],"result":{"content":[{"type":"text","text":"Stored memory id-new-1."}],"structuredContent":{"node":{"id":"id-new-1"}}}}),
            );

            // 3. memos_supersede (with _meta)
            let sup_req: Value = serde_json::from_str(&srv.to_server_rx.recv().unwrap()).unwrap();
            assert_modern_meta(&sup_req);
            assert_eq!(sup_req["params"]["name"], "memos_supersede");
            send_json_line(
                &srv.from_server_tx,
                &json!({"jsonrpc":"2.0","id":sup_req["id"],"result":{"content":[{"type":"text","text":"Superseded id-old-0."}],"structuredContent":{"node":{"id":"id-old-0"}}}}),
            );

            // 4. memos_link (with _meta)
            let link_req: Value = serde_json::from_str(&srv.to_server_rx.recv().unwrap()).unwrap();
            assert_modern_meta(&link_req);
            assert_eq!(link_req["params"]["name"], "memos_link");
            send_json_line(
                &srv.from_server_tx,
                &json!({"jsonrpc":"2.0","id":link_req["id"],"result":{"structuredContent":{"edge":{"relation":"supports"}}}}),
            );

            // 5. memos_review (with _meta)
            let rev_req: Value = serde_json::from_str(&srv.to_server_rx.recv().unwrap()).unwrap();
            assert_modern_meta(&rev_req);
            assert_eq!(rev_req["params"]["name"], "memos_review");
            send_json_line(
                &srv.from_server_tx,
                &json!({"jsonrpc":"2.0","id":rev_req["id"],"result":{"content":[{"type":"text","text":"0 items"}]}}),
            );

            // 6. memos_forget (with _meta)
            let fgt_req: Value = serde_json::from_str(&srv.to_server_rx.recv().unwrap()).unwrap();
            assert_modern_meta(&fgt_req);
            assert_eq!(fgt_req["params"]["name"], "memos_forget");
            send_json_line(
                &srv.from_server_tx,
                &json!({"jsonrpc":"2.0","id":fgt_req["id"],"result":{"structuredContent":{"id":"id-new-1","deleted":true}}}),
            );
        });

        sess.connect(Duration::from_secs(2)).unwrap();
        assert_eq!(sess.era(), ProtocolEra::Modern);
        let bridge = make_bridge_from_session(sess);

        let ping = bridge.ping().unwrap();
        assert_eq!(ping.era, ProtocolEra::Modern);
        assert_eq!(ping.tool_count, 8);
        assert_eq!(ping.protocol_version, MCP_PROTOCOL_VERSION);
        assert!(ping.has_review && ping.has_ingest && ping.has_audit && ping.has_explain);
        assert_eq!(ping.cache_ttl_ms, Some(600000));
        assert_eq!(ping.cache_scope.as_deref(), Some("private"));
        assert_eq!(
            ping.server_info.as_ref().map(|s| s.name.as_str()),
            Some("memos")
        );
        assert_eq!(
            ping.format_settings_status(),
            "Connected · MCP 2026-07-28 · 8 tools · review ✓"
        );
        assert_eq!(
            PingResult::settings_footer_mode(true, Some(&ping)),
            "Write mode enabled (MCP 2026-07-28)"
        );

        let stored = bridge
            .store(StoreInput {
                content: "Dark mode default".to_string(),
                node_type: Some("preference".to_string()),
                tags: vec!["ui".to_string(), "theme".to_string()],
                namespace: Some("app".to_string()),
                pool: Some("note".to_string()),
                context: Some("settings check".to_string()),
            })
            .unwrap();
        assert_eq!(stored.id, "id-new-1");

        let sup = bridge.supersede("id-old-0", Some("id-new-1")).unwrap();
        assert!(sup.superseded);
        assert_eq!(sup.replacement_id.as_deref(), Some("id-new-1"));

        let lnk = bridge
            .link(LinkInput {
                source_id: "id-new-1".to_string(),
                target_id: "id-peer-2".to_string(),
                relation: Some("supports".to_string()),
                weight: Some(0.9),
            })
            .unwrap();
        assert_eq!(lnk.relation.as_deref(), Some("supports"));

        let rev = bridge
            .review(ReviewInput {
                action: "list".to_string(),
                id: None,
                namespace: Some("app".to_string()),
            })
            .unwrap();
        assert_eq!(rev.summary, "0 items");

        let fgt = bridge.forget("id-new-1").unwrap();
        assert!(fgt.deleted);
        server_thread.join().unwrap();
    }

    #[test]
    fn legacy_fallbacks_trigger_for_unsupported_version_method_not_found_and_envelope_error() {
        for (code, msg) in [
            (-32022_i64, "Unsupported protocol version: 2026-07-28"),
            (-32601_i64, "Method not found"),
            (
                -32602_i64,
                "Invalid _meta envelope for protocol revision 2026-07-28: missing",
            ),
        ] {
            let (mut sess, srv) = make_pipe_session();
            let err_msg = msg.to_string();
            let server_thread = thread::spawn(move || {
                let disc: Value = serde_json::from_str(&srv.to_server_rx.recv().unwrap()).unwrap();
                assert_eq!(disc["method"], "server/discover");
                send_json_line(
                    &srv.from_server_tx,
                    &json!({"jsonrpc":"2.0","id":disc["id"],"error":{"code":code,"message":err_msg}}),
                );

                let init: Value = serde_json::from_str(&srv.to_server_rx.recv().unwrap()).unwrap();
                assert_eq!(init["method"], "initialize");
                assert_eq!(
                    init["params"]["protocolVersion"],
                    LEGACY_MCP_PROTOCOL_VERSION
                );
                send_json_line(
                    &srv.from_server_tx,
                    &json!({"jsonrpc":"2.0","id":init["id"],"result":{"protocolVersion":LEGACY_MCP_PROTOCOL_VERSION,"capabilities":{},"serverInfo":{"name":"memos-legacy","version":"1.5.0"}}}),
                );

                let notif: Value = serde_json::from_str(&srv.to_server_rx.recv().unwrap()).unwrap();
                assert_eq!(notif["method"], "notifications/initialized");

                let list_req: Value =
                    serde_json::from_str(&srv.to_server_rx.recv().unwrap()).unwrap();
                assert_eq!(list_req["method"], "tools/list");
                assert!(list_req["params"].get("_meta").is_none());
                send_json_line(
                    &srv.from_server_tx,
                    &json!({"jsonrpc":"2.0","id":list_req["id"],"result":{"tools":[{"name":"memos_store"}]}}),
                );
            });

            sess.connect(Duration::from_secs(2)).unwrap();
            assert_eq!(sess.era(), ProtocolEra::Legacy);
            let bridge = make_bridge_from_session(sess);
            let ping = bridge.ping().unwrap();
            assert_eq!(ping.era, ProtocolEra::Legacy);
            assert_eq!(ping.protocol_version, LEGACY_MCP_PROTOCOL_VERSION);
            assert_eq!(ping.tool_count, 1);
            assert!(!ping.has_review);
            assert_eq!(
                ping.format_settings_status(),
                "Connected · MCP 2025-11-25 (legacy) · 1 tools · review ✗"
            );
            server_thread.join().unwrap();
        }
    }

    #[test]
    fn malformed_discover_and_wire_responses_do_not_fallback() {
        // 1. Discover missing supportedVersions array -> MalformedLine
        let (mut sess1, srv1) = make_pipe_session();
        let t1 = thread::spawn(move || {
            let disc: Value = serde_json::from_str(&srv1.to_server_rx.recv().unwrap()).unwrap();
            send_json_line(
                &srv1.from_server_tx,
                &json!({"jsonrpc":"2.0","id":disc["id"],"result":{"capabilities":{}}}),
            );
        });
        assert!(matches!(
            sess1.connect(Duration::from_secs(2)),
            Err(BridgeError::MalformedLine { .. })
        ));
        t1.join().unwrap();

        // 2. Corrupted non-JSON line on server/discover -> MalformedLine
        let (mut sess2, srv2) = make_pipe_session();
        let t2 = thread::spawn(move || {
            let _ = srv2.to_server_rx.recv().unwrap();
            let _ = srv2.from_server_tx.send(b"{not-valid-json\n".to_vec());
        });
        assert!(matches!(
            sess2.connect(Duration::from_secs(2)),
            Err(BridgeError::MalformedLine { .. })
        ));
        t2.join().unwrap();
    }

    #[test]
    fn capability_gating_returns_human_message_for_review_ingest_audit_and_explain() {
        let (mut sess, srv) = make_pipe_session();
        let server_thread = thread::spawn(move || {
            let disc: Value = serde_json::from_str(&srv.to_server_rx.recv().unwrap()).unwrap();
            send_json_line(
                &srv.from_server_tx,
                &json!({"jsonrpc":"2.0","id":disc["id"],"result":sample_discover_ok()}),
            );
            let list_req: Value = serde_json::from_str(&srv.to_server_rx.recv().unwrap()).unwrap();
            let tools: Vec<Value> = (0..24)
                .map(|i| json!({"name": format!("memos_tool_{i}")}))
                .collect();
            send_json_line(
                &srv.from_server_tx,
                &json!({"jsonrpc":"2.0","id":list_req["id"],"result":{"tools":tools}}),
            );
        });

        sess.connect(Duration::from_secs(2)).unwrap();
        let bridge = make_bridge_from_session(sess);

        let rev_err = bridge
            .review(ReviewInput {
                action: "list".to_string(),
                id: None,
                namespace: None,
            })
            .unwrap_err();
        assert_eq!(
            rev_err,
            BridgeError::CapabilityMissing {
                tool: "memos_review".to_string(),
                tool_count: 24,
            }
        );
        assert_eq!(
            rev_err.ui_summary(),
            "This writer exposes 24 tools and not `memos_review`. Point Writer command at a full MemOS CLI or update `@mem-os/sdk`."
        );

        let ing_err = bridge
            .ingest(IngestInput {
                path: "notes.md".to_string(),
                ..Default::default()
            })
            .unwrap_err();
        assert!(matches!(
            ing_err,
            BridgeError::CapabilityMissing { tool_count: 24, .. }
        ));
        assert!(ing_err.ui_summary().contains("memos_ingest"));

        let audit_err = bridge.ensure_capability("memos_audit_answer").unwrap_err();
        assert!(audit_err.ui_summary().contains("memos_audit_answer"));

        let explain_err = bridge
            .ensure_capability("memos_explain_recall")
            .unwrap_err();
        assert!(explain_err.ui_summary().contains("memos_explain_recall"));

        server_thread.join().unwrap();
    }

    #[test]
    fn local_writer_discovery_prefers_path_then_dist_cli_then_none() {
        let base = env::temp_dir().join(format!("memos-local-detect-{}", std::process::id()));
        let bin_dir = base.join("bin");
        let repo_dir = base.join("repo with spaces");
        let dist_dir = repo_dir.join("dist");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&bin_dir).unwrap();
        std::fs::create_dir_all(&dist_dir).unwrap();
        let cli_js = dist_dir.join("cli.js");
        std::fs::write(&cli_js, "// stub\n").unwrap();

        #[cfg(target_os = "windows")]
        let bin_name = "memos.cmd";
        #[cfg(not(target_os = "windows"))]
        let bin_name = "memos";
        let bin_path = bin_dir.join(bin_name);
        std::fs::write(&bin_path, "echo ok\n").unwrap();

        let path_os = OsString::from(bin_dir.as_os_str());
        let first =
            detect_local_writer_in(Some(&path_os), std::slice::from_ref(&repo_dir)).unwrap();
        assert_eq!(first.source, LocalWriterSource::PathBinary);
        assert_eq!(first.command, "memos mcp");

        // Without memos on PATH, falls back cleanly to <repo>/dist/cli.js with safe quoting
        let empty_path = OsString::from("");
        let second =
            detect_local_writer_in(Some(&empty_path), &[repo_dir.join("apps/desktop")]).unwrap();
        assert_eq!(second.source, LocalWriterSource::RepoDistCli);
        let tokens = parse_command_tokens(&second.command).unwrap();
        assert_eq!(tokens[0], "node");
        assert_eq!(PathBuf::from(&tokens[1]), cli_js);
        assert_eq!(tokens[2], "mcp");

        // With neither present, returns None (caller uses npx -y @mem-os/sdk mcp)
        assert!(
            detect_local_writer_in(Some(&empty_path), std::slice::from_ref(&bin_dir)).is_none()
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn live_local_cli_discover_and_client_revision_match_2026_07_28() {
        let Some(detected) = detect_local_writer() else {
            return;
        };
        if detected.source != LocalWriterSource::RepoDistCli {
            return;
        }
        let db_path =
            env::temp_dir().join(format!("memos-desktop-parity-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&db_path);
        let bridge = WriteBridge::new(detected.command, db_path.clone());
        let ping = bridge
            .ping()
            .expect("local dist/cli.js mcp should reply to server/discover 2026-07-28");
        assert_eq!(ping.era, ProtocolEra::Modern);
        assert_eq!(ping.protocol_version, MCP_PROTOCOL_VERSION);
        assert_eq!(ping.protocol_version, "2026-07-28");
        assert_eq!(ping.tool_count, 42);
        assert!(ping.has_review && ping.has_ingest && ping.has_audit && ping.has_explain);
        assert_eq!(
            ping.format_settings_status(),
            "Connected · MCP 2026-07-28 · 42 tools · review ✓"
        );
        bridge.shutdown();
        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn review_queue_items_and_ingest_requests_and_results_parse_cleanly() {
        let exts = parse_extensions_csv("md, txt, .HTML, pdf, .md");
        assert_eq!(exts, vec![".md", ".txt", ".html", ".pdf"]);

        let ingest_in = IngestInput {
            path: "C:\\notes\\docs".to_string(),
            namespace: Some("documents".to_string()),
            extensions: exts.clone(),
            chunk_chars: Some(900),
            recursive: true,
        };
        let args = build_ingest_tool_args(&ingest_in, &ingest_in.path);
        assert_eq!(args["path"], "C:\\notes\\docs");
        assert_eq!(args["namespace"], "documents");
        assert_eq!(args["chunk_chars"], 900);
        assert_eq!(args["extensions"], json!([".md", ".txt", ".html", ".pdf"]));

        let (mut sess, srv) = make_pipe_session();
        let server_thread = thread::spawn(move || {
            let disc: Value = serde_json::from_str(&srv.to_server_rx.recv().unwrap()).unwrap();
            send_json_line(
                &srv.from_server_tx,
                &json!({"jsonrpc":"2.0","id":disc["id"],"result":sample_discover_ok()}),
            );

            let tools_list: Value =
                serde_json::from_str(&srv.to_server_rx.recv().unwrap()).unwrap();
            assert_modern_meta(&tools_list);
            send_json_line(
                &srv.from_server_tx,
                &json!({"jsonrpc":"2.0","id":tools_list["id"],"result":{"tools":[{"name":"memos_review"},{"name":"memos_ingest"}]}}),
            );

            // 1. memos_review list
            let list_req: Value = serde_json::from_str(&srv.to_server_rx.recv().unwrap()).unwrap();
            assert_modern_meta(&list_req);
            assert_eq!(list_req["params"]["name"], "memos_review");
            assert_eq!(list_req["params"]["arguments"]["action"], "list");
            send_json_line(
                &srv.from_server_tx,
                &json!({
                    "jsonrpc": "2.0",
                    "id": list_req["id"],
                    "result": {
                        "content": [{"type": "text", "text": "rev-1 · decision · Pending API rule"}],
                        "structuredContent": {
                            "result": {
                                "count": 1,
                                "items": [{
                                    "id": "rev-1-0000-4000-8000-000000000001",
                                    "content": "Pending API rule for OAuth PKCE",
                                    "summary": "",
                                    "type": "decision",
                                    "namespace": "work",
                                    "createdAt": 1700000000000_i64,
                                    "quarantineReason": "review:pending",
                                    "metadata": {"confidence": 0.62, "reviewReason": "Agent inferred from chat"}
                                }]
                            }
                        }
                    }
                }),
            );

            // 2. memos_review approve
            let app_req: Value = serde_json::from_str(&srv.to_server_rx.recv().unwrap()).unwrap();
            assert_modern_meta(&app_req);
            assert_eq!(app_req["params"]["name"], "memos_review");
            assert_eq!(app_req["params"]["arguments"]["action"], "approve");
            send_json_line(
                &srv.from_server_tx,
                &json!({"jsonrpc":"2.0","id":app_req["id"],"result":{"content":[{"type":"text","text":"Approved rev-1."}]}}),
            );

            // 3. memos_ingest
            let ing_req: Value = serde_json::from_str(&srv.to_server_rx.recv().unwrap()).unwrap();
            assert_modern_meta(&ing_req);
            assert_eq!(ing_req["params"]["name"], "memos_ingest");
            assert_eq!(ing_req["params"]["arguments"]["path"], "C:\\notes\\docs");
            assert_eq!(ing_req["params"]["arguments"]["namespace"], "documents");
            assert_eq!(ing_req["params"]["arguments"]["chunk_chars"], 900);
            send_json_line(
                &srv.from_server_tx,
                &json!({
                    "jsonrpc": "2.0",
                    "id": ing_req["id"],
                    "result": {
                        "content": [{"type": "text", "text": "{\"added\":3,\"updated\":1,\"unchanged\":2,\"removed\":0,\"skipped\":1,\"errors\":0,\"chunks\":7}"}],
                        "structuredContent": {"added":3,"updated":1,"unchanged":2,"removed":0,"skipped":1,"errors":0,"chunks":7}
                    }
                }),
            );
        });

        sess.connect(Duration::from_secs(2)).unwrap();
        let bridge = make_bridge_from_session(sess);

        let listed = bridge
            .review(ReviewInput {
                action: "list".to_string(),
                id: None,
                namespace: None,
            })
            .unwrap();
        assert_eq!(listed.items.len(), 1);
        assert_eq!(listed.items[0].node_type, "decision");
        assert_eq!(listed.items[0].namespace, "work");
        assert_eq!(listed.items[0].confidence, Some(0.62));
        assert_eq!(
            listed.items[0].reason.as_deref(),
            Some("Agent inferred from chat")
        );

        let approved = bridge
            .review(ReviewInput {
                action: "approve".to_string(),
                id: Some("rev-1-0000-4000-8000-000000000001".to_string()),
                namespace: None,
            })
            .unwrap();
        assert_eq!(approved.action, "approve");
        assert!(approved.summary.contains("Approved"));

        let ingested = bridge.ingest(ingest_in).unwrap();
        assert_eq!(ingested.added, 3);
        assert_eq!(ingested.updated, 1);
        assert_eq!(ingested.unchanged, 2);
        assert_eq!(ingested.skipped, 1);
        assert_eq!(ingested.chunks, 7);
        assert_eq!(
            ingested.format_summary(),
            "Added 3, updated 1, unchanged 2, removed 0, skipped 1, errors 0, chunks 7"
        );
        server_thread.join().unwrap();
    }

    #[test]
    fn bridge_maps_spawn_timeout_rpc_tool_malformed_and_exit_errors() {
        // 1. Spawn failure
        let bad = WriteBridge::new(
            "memos_definitely_missing_writer_bin_99999 mcp",
            PathBuf::from("fake.db"),
        );
        let spawn_err = bad.ping().unwrap_err();
        assert!(matches!(spawn_err, BridgeError::SpawnFailed { .. }));

        // 2. Timeout
        let (mut sess_t, _srv_t) = make_pipe_session();
        let timeout_err = sess_t.connect(Duration::from_millis(60)).unwrap_err();
        assert!(matches!(timeout_err, BridgeError::Timeout { .. }));

        // 3. RPC error object + MCP tool isError + malformed JSON line + EOF w/ stderr trailer
        let (mut sess, srv) = make_pipe_session();
        let handle = thread::spawn(move || {
            let disc: Value = serde_json::from_str(&srv.to_server_rx.recv().unwrap()).unwrap();
            send_json_line(
                &srv.from_server_tx,
                &json!({"jsonrpc":"2.0","id":disc["id"],"result":sample_discover_ok()}),
            );

            let rpc_req: Value = serde_json::from_str(&srv.to_server_rx.recv().unwrap()).unwrap();
            send_json_line(
                &srv.from_server_tx,
                &json!({"jsonrpc":"2.0","id":rpc_req["id"],"error":{"code":-32601,"message":"Method not found"}}),
            );

            let tool_req: Value = serde_json::from_str(&srv.to_server_rx.recv().unwrap()).unwrap();
            send_json_line(
                &srv.from_server_tx,
                &json!({"jsonrpc":"2.0","id":tool_req["id"],"result":{"isError":true,"content":[{"type":"text","text":"DB is locked"}]}}),
            );

            let _bad_line_req = srv.to_server_rx.recv().unwrap();
            let _ = srv.from_server_tx.send(b"not-valid-json\n".to_vec());

            let _eof_req = srv.to_server_rx.recv().unwrap();
            let _ = srv
                .err_tx
                .send(b"fatal: SQLITE_CANTOPEN on test.db\n".to_vec());
            let _ = srv.err_tx.send(Vec::new());
            thread::sleep(Duration::from_millis(20));
            let _ = srv.from_server_tx.send(Vec::new());
        });

        sess.connect(Duration::from_secs(2)).unwrap();
        let err_rpc = sess.list_tools(Duration::from_secs(2)).unwrap_err();
        assert!(matches!(
            err_rpc,
            BridgeError::RpcError { code: -32601, .. }
        ));

        let err_tool = sess
            .call_tool("memos_forget", json!({"id": "x"}), Duration::from_secs(2))
            .unwrap_err();
        assert!(matches!(err_tool, BridgeError::ToolError { .. }));
        assert!(err_tool.ui_summary().contains("DB is locked"));

        let err_malformed = sess.list_tools(Duration::from_secs(2)).unwrap_err();
        assert!(matches!(err_malformed, BridgeError::MalformedLine { .. }));

        let err_exit = sess.list_tools(Duration::from_secs(2)).unwrap_err();
        match err_exit {
            BridgeError::ProcessExited { trailer, .. } => {
                assert!(trailer.contains("SQLITE_CANTOPEN"));
            }
            other => panic!("expected ProcessExited, got {other:?}"),
        }
        handle.join().unwrap();
    }

    #[test]
    fn writer_errors_map_raw_sqlite_messages_to_human_guidance() {
        let schema_err = BridgeError::ToolError {
            message: "SQLITE_ERROR: table edges has no column named metadata".to_string(),
        };
        let s = schema_err.ui_summary();
        assert!(s.contains("missing metadata"), "got: {s}");
        assert!(s.contains("memos init"), "got: {s}");
        assert!(!s.contains("SQLITE_ERROR"), "leaked raw sqlite: {s}");

        let lock_err = BridgeError::ToolError {
            message: "SQLITE_BUSY: database is locked".to_string(),
        };
        let l = lock_err.ui_summary();
        assert!(l.contains("locked"), "got: {l}");
        assert!(!l.contains("SQLITE_BUSY"), "leaked raw sqlite: {l}");

        let rpc_tool_err = BridgeError::RpcError {
            code: -32602,
            message: "Tool memos_review not found".to_string(),
        };
        assert!(rpc_tool_err.is_capability_missing());
        assert!(rpc_tool_err.ui_summary().contains("memos_review"));
    }
}
