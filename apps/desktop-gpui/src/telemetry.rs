use std::collections::{BTreeMap, VecDeque};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::panic;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, Once, OnceLock, RwLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use directories::{BaseDirs, ProjectDirs};
use sentry::protocol::{Context as SentryContext, Event, User, Value as SentryValue};
use sentry::types::Dsn;
use serde::Serialize;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

use crate::core::harness::Detection;
use crate::core::model::DbOverview;
use crate::core::settings::{AppSettings, ResolvedDbPath};

pub const APP_NAME: &str = "memos-desktop";
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const GPUI_VERSION: &str = "1.29.2";
pub const LOG_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
pub const LOG_MAX_FILES: usize = 5;
const LOG_BASENAME: &str = "memos-desktop.log";
const MAX_TRACKED_SENSITIVE_SAMPLES: usize = 64;

static TRACING_INIT: Once = Once::new();
static PANIC_HOOK_INIT: Once = Once::new();
static SENSITIVE_REGISTRY: OnceLock<RwLock<SensitiveData>> = OnceLock::new();
static CRASH_TEST_REPORT_CAPTURE: OnceLock<Mutex<Option<String>>> = OnceLock::new();

#[derive(Default)]
struct SensitiveData {
    active_query: Option<String>,
    samples: VecDeque<String>,
}

fn registry() -> &'static RwLock<SensitiveData> {
    SENSITIVE_REGISTRY.get_or_init(|| RwLock::new(SensitiveData::default()))
}

/// Register the active search query so crash scrubbers always strip it if it appears anywhere.
pub fn set_active_query(query: &str) {
    let trimmed = query.trim();
    if let Ok(mut guard) = registry().write() {
        guard.active_query = if trimmed.len() >= 3 {
            Some(trimmed.to_string())
        } else {
            None
        };
    }
}

/// Register a sensitive string (e.g., inspected memory text or test secret) in the bounded scrubber ring.
pub fn register_sensitive_text(text: &str) {
    let trimmed = text.trim();
    if trimmed.len() < 4 {
        return;
    }
    if let Ok(mut guard) = registry().write() {
        if guard.samples.iter().any(|existing| existing == trimmed) {
            return;
        }
        if guard.samples.len() >= MAX_TRACKED_SENSITIVE_SAMPLES {
            guard.samples.pop_front();
        }
        guard.samples.push_back(trimmed.to_string());
    }
}

/// Clear tracked sensitive strings (primarily for unit tests).
pub fn clear_sensitive_text() {
    if let Ok(mut guard) = registry().write() {
        guard.active_query = None;
        guard.samples.clear();
    }
}

fn snapshot_sensitive_terms() -> Vec<String> {
    let mut terms = Vec::new();
    if let Ok(guard) = registry().read() {
        if let Some(q) = &guard.active_query {
            terms.push(q.clone());
        }
        for s in &guard.samples {
            terms.push(s.clone());
            // Also register the first line / trimmed slice in case only a prefix was formatted.
            if let Some(first_line) = s.lines().next() {
                let first_trimmed = first_line.trim();
                if first_trimmed.len() >= 6 && first_trimmed != s {
                    terms.push(first_trimmed.to_string());
                }
            }
        }
    }
    terms.sort_by_key(|t| std::cmp::Reverse(t.len()));
    terms.dedup();
    terms
}

/// Platform log directory (`5 files × 2 MB` rotating logs + local crash reports).
/// Honors `MEMOS_DESKTOP_HOME` when set for isolated test/onboarding runs.
pub fn log_dir() -> PathBuf {
    if let Some(home) = env::var_os("MEMOS_DESKTOP_HOME") {
        let path = PathBuf::from(home);
        if !path.as_os_str().is_empty() {
            return path.join("logs");
        }
    }

    #[cfg(target_os = "macos")]
    if let Some(base) = BaseDirs::new() {
        return base
            .home_dir()
            .join("Library")
            .join("Logs")
            .join("MemOS Desktop");
    }

    if let Some(proj) = ProjectDirs::from("ai", "memos", "MemOS Desktop") {
        proj.data_local_dir().join("logs")
    } else if let Some(base) = BaseDirs::new() {
        base.home_dir().join(".memos").join("desktop-logs")
    } else {
        PathBuf::from("memos-desktop-logs")
    }
}

/// Resolve Sentry DSN from runtime env `MEMOS_DESKTOP_SENTRY_DSN` or compile-time env.
/// Returns `None` for local-only mode.
pub fn resolve_dsn() -> Option<String> {
    if let Ok(val) = env::var("MEMOS_DESKTOP_SENTRY_DSN") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    option_env!("MEMOS_DESKTOP_SENTRY_DSN")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

/// Size-rotating file writer keeping `max_files` files of at most `max_bytes` each.
pub struct SizeRotatingFileWriter {
    dir: PathBuf,
    base_name: String,
    max_bytes: u64,
    max_files: usize,
    current_bytes: u64,
    file: Option<File>,
}

#[cfg(unix)]
fn restrict_dir(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn restrict_dir(_path: &Path) -> io::Result<()> {
    // Windows inherits the user-profile ACL, which is already user-scoped.
    Ok(())
}

#[cfg(unix)]
fn restrict_file(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn restrict_file(_path: &Path) -> io::Result<()> {
    Ok(())
}

impl SizeRotatingFileWriter {
    pub fn new(
        dir: PathBuf,
        base_name: impl Into<String>,
        max_bytes: u64,
        max_files: usize,
    ) -> io::Result<Self> {
        fs::create_dir_all(&dir)?;
        let _ = restrict_dir(&dir);
        let base_name = base_name.into();
        let active_path = dir.join(&base_name);
        let current_bytes = fs::metadata(&active_path).map(|m| m.len()).unwrap_or(0);
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&active_path)?;
        let _ = restrict_file(&active_path);
        Ok(Self {
            dir,
            base_name,
            max_bytes: max_bytes.max(1024),
            max_files: max_files.max(1),
            current_bytes,
            file: Some(file),
        })
    }

    fn rotated_path(&self, idx: usize) -> PathBuf {
        if idx == 0 {
            self.dir.join(&self.base_name)
        } else {
            self.dir.join(format!("{}.{}", self.base_name, idx))
        }
    }

    fn rotate(&mut self) -> io::Result<()> {
        if let Some(mut f) = self.file.take() {
            let _ = f.flush();
        }
        let oldest = self.rotated_path(self.max_files - 1);
        if oldest.exists() {
            let _ = fs::remove_file(&oldest);
        }
        for idx in (0..self.max_files - 1).rev() {
            let src = self.rotated_path(idx);
            let dst = self.rotated_path(idx + 1);
            if src.exists() {
                let _ = fs::rename(&src, &dst);
            }
        }
        let fresh = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(self.rotated_path(0))?;
        let _ = restrict_file(&self.rotated_path(0));
        self.current_bytes = 0;
        self.file = Some(fresh);
        Ok(())
    }
}

impl Write for SizeRotatingFileWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.current_bytes + buf.len() as u64 > self.max_bytes {
            self.rotate()?;
        }
        if let Some(file) = self.file.as_mut() {
            let written = file.write(buf)?;
            self.current_bytes += written as u64;
            Ok(written)
        } else {
            Err(io::Error::other("log file closed"))
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        if let Some(file) = self.file.as_mut() {
            file.flush()
        } else {
            Ok(())
        }
    }
}

/// Context passed into the crash-report scrubber.
#[derive(Clone, Debug)]
pub struct ScrubContext {
    pub install_id: String,
    pub usernames: Vec<String>,
    pub hostnames: Vec<String>,
    pub home_dirs: Vec<String>,
    pub sensitive_terms: Vec<String>,
}

impl ScrubContext {
    pub fn from_environment(install_id: impl Into<String>) -> Self {
        let mut usernames = Vec::new();
        for key in ["USERNAME", "USER", "LOGNAME"] {
            if let Ok(val) = env::var(key) {
                let trimmed = val.trim();
                if trimmed.len() >= 2
                    && !usernames
                        .iter()
                        .any(|u: &String| u.eq_ignore_ascii_case(trimmed))
                {
                    usernames.push(trimmed.to_string());
                }
            }
        }

        let mut home_dirs = Vec::new();
        if let Some(base) = BaseDirs::new() {
            let home = base.home_dir();
            if let Some(leaf) = home.file_name().and_then(|s| s.to_str())
                && leaf.len() >= 2
                && !usernames.iter().any(|u| u.eq_ignore_ascii_case(leaf))
            {
                usernames.push(leaf.to_string());
            }
            home_dirs.push(home.to_string_lossy().to_string());
        }
        for key in ["USERPROFILE", "HOME"] {
            if let Ok(val) = env::var(key) {
                let trimmed = val.trim();
                if !trimmed.is_empty() && !home_dirs.iter().any(|h| h == trimmed) {
                    home_dirs.push(trimmed.to_string());
                }
            }
        }

        let mut hostnames = Vec::new();
        for key in ["COMPUTERNAME", "HOSTNAME"] {
            if let Ok(val) = env::var(key) {
                let trimmed = val.trim();
                if trimmed.len() >= 2
                    && !hostnames
                        .iter()
                        .any(|h: &String| h.eq_ignore_ascii_case(trimmed))
                {
                    hostnames.push(trimmed.to_string());
                }
            }
        }

        Self {
            install_id: install_id.into(),
            usernames,
            hostnames,
            home_dirs,
            sensitive_terms: snapshot_sensitive_terms(),
        }
    }

    pub fn with_extra_sensitive(mut self, term: impl Into<String>) -> Self {
        let term = term.into();
        if term.len() >= 4 {
            self.sensitive_terms.push(term);
            self.sensitive_terms
                .sort_by_key(|t| std::cmp::Reverse(t.len()));
            self.sensitive_terms.dedup();
        }
        self
    }
}

/// Scrub sensitive content, search queries, file paths, usernames, and hostnames from free text.
pub fn scrub_text(input: &str, ctx: &ScrubContext) -> String {
    let mut out = input.to_string();

    // 1. Strip explicitly registered memory content, queries, and test secrets first.
    for term in &ctx.sensitive_terms {
        if term.len() >= 4 && out.contains(term) {
            out = out.replace(term, "<redacted-memory>");
        }
    }

    // 2. Strip known home directories before general path scrubbing.
    for home in &ctx.home_dirs {
        if !home.is_empty() {
            out = replace_case_insensitive(&out, home, "<redacted-home>");
        }
    }

    // 3. Strip full Windows/Unix filesystem paths.
    out = scrub_filesystem_paths(&out);

    // 4. Strip structured query/content markers if any slipped into debug strings.
    out = scrub_keyed_markers(&out);

    // 5. Strip usernames and hostnames (case-insensitive, whole-ish tokens).
    for host in &ctx.hostnames {
        out = replace_identifier_case_insensitive(&out, host, "<redacted-host>");
    }
    for user in &ctx.usernames {
        out = replace_identifier_case_insensitive(&out, user, "<redacted-user>");
    }

    out
}

fn replace_case_insensitive(haystack: &str, needle: &str, replacement: &str) -> String {
    if needle.is_empty() || haystack.len() < needle.len() {
        return haystack.to_string();
    }
    let hay_lower = haystack.to_ascii_lowercase();
    let needle_lower = needle.to_ascii_lowercase();
    let mut out = String::with_capacity(haystack.len());
    let mut i = 0usize;
    while let Some(rel) = hay_lower[i..].find(&needle_lower) {
        let pos = i + rel;
        // Ensure char boundary alignment on original string when lengths match ASCII.
        if haystack.is_char_boundary(pos) && haystack.is_char_boundary(pos + needle.len()) {
            out.push_str(&haystack[i..pos]);
            out.push_str(replacement);
            i = pos + needle.len();
        } else {
            out.push_str(&haystack[i..=pos]);
            i = pos + 1;
        }
    }
    out.push_str(&haystack[i..]);
    out
}

fn replace_identifier_case_insensitive(haystack: &str, needle: &str, replacement: &str) -> String {
    if needle.len() < 2 || haystack.len() < needle.len() {
        return haystack.to_string();
    }
    let hay_lower = haystack.to_ascii_lowercase();
    let needle_lower = needle.to_ascii_lowercase();
    let bytes = haystack.as_bytes();
    let mut out = String::with_capacity(haystack.len());
    let mut i = 0usize;
    while let Some(rel) = hay_lower[i..].find(&needle_lower) {
        let pos = i + rel;
        let end = pos + needle.len();
        let left_ok = pos == 0 || !is_ident_char(bytes[pos - 1]);
        let right_ok = end >= bytes.len() || !is_ident_char(bytes[end]);
        if left_ok && right_ok && haystack.is_char_boundary(pos) && haystack.is_char_boundary(end) {
            out.push_str(&haystack[i..pos]);
            out.push_str(replacement);
            i = end;
        } else {
            let next = pos + 1;
            let safe_next = if haystack.is_char_boundary(next) {
                next
            } else {
                haystack.len()
            };
            out.push_str(&haystack[i..safe_next]);
            i = safe_next;
        }
    }
    out.push_str(&haystack[i..]);
    out
}

fn is_ident_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn scrub_filesystem_paths(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        // Windows drive path: e.g. C:\foo or C:/foo
        let is_win_drive = i + 2 < bytes.len()
            && bytes[i].is_ascii_alphabetic()
            && bytes[i + 1] == b':'
            && (bytes[i + 2] == b'\\' || bytes[i + 2] == b'/')
            && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric());

        // UNC path: \\server\share
        let is_unc = i + 2 < bytes.len()
            && bytes[i] == b'\\'
            && bytes[i + 1] == b'\\'
            && !bytes[i + 2].is_ascii_whitespace()
            && (i == 0
                || bytes[i - 1].is_ascii_whitespace()
                || bytes[i - 1] == b'"'
                || bytes[i - 1] == b'\'');

        // Unix home/system paths: ~/..., /Users/..., /home/..., /var/..., /tmp/..., /etc/..., /opt/..., /root/...
        let rest = &input[i..];
        let is_unix_path = (i == 0
            || !bytes[i - 1].is_ascii_alphanumeric()
                && bytes[i - 1] != b':'
                && bytes[i - 1] != b'/')
            && (rest.starts_with("~/")
                || rest.starts_with("~\\")
                || rest.starts_with("/Users/")
                || rest.starts_with("/home/")
                || rest.starts_with("/var/")
                || rest.starts_with("/tmp/")
                || rest.starts_with("/etc/")
                || rest.starts_with("/opt/")
                || rest.starts_with("/root/"));

        if is_win_drive || is_unc || is_unix_path {
            let mut end = i;
            while end < bytes.len() {
                let b = bytes[end];
                if b.is_ascii_whitespace()
                    || matches!(b, b'"' | b'\'' | b')' | b']' | b'>' | b',' | b';')
                {
                    break;
                }
                end += 1;
            }
            out.push_str("<redacted-path>");
            i = end;
        } else {
            let ch = input[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

fn scrub_keyed_markers(input: &str) -> String {
    let mut out = input.to_string();
    for key in ["content=", "summary=", "query=", "nodes_fts MATCH "] {
        let mut cursor = 0usize;
        while cursor < out.len()
            && let Some(rel) = out[cursor..].find(key)
        {
            let pos = cursor + rel;
            let val_start = pos + key.len();
            let rest = &out[val_start..];
            let val_end = if let Some(after_quote) = rest.strip_prefix('"') {
                after_quote
                    .find('"')
                    .map(|idx| val_start + 1 + idx + 1)
                    .unwrap_or(out.len())
            } else {
                rest.find(['\n', '\r', ';', ','])
                    .map(|idx| val_start + idx)
                    .unwrap_or(out.len())
            };
            let replacement = if key.starts_with("query") || key.starts_with("nodes_fts") {
                "<redacted-query>"
            } else {
                "<redacted-memory>"
            };
            out.replace_range(val_start..val_end, replacement);
            cursor = val_start + replacement.len();
        }
    }
    out
}

/// Sentry `before_send` scrubber:
/// strips memory content, search queries, full file paths, usernames, and hostnames,
/// while keeping app version, OS, GPUI version, error kind, and random install id.
pub fn scrub_sentry_event(mut event: Event<'static>, ctx: &ScrubContext) -> Option<Event<'static>> {
    // Whole-event pass first: catches nested fields the targeted scrubbers
    // below do not enumerate (contexts, spans, debug_meta, attachments…).
    // If the round-trip fails we keep the original event and still run the
    // explicit field scrubbers, so this can only add coverage.
    if let Ok(mut value) = serde_json::to_value(&event) {
        scrub_json_value(&mut value, ctx);
        if let Ok(cleaned) = serde_json::from_value::<Event<'static>>(value) {
            event = cleaned;
        }
    }

    event.server_name = None;
    event.request = None;
    event.user = Some(User {
        id: Some(ctx.install_id.clone()),
        ..Default::default()
    });

    if let Some(msg) = event.message.as_mut() {
        *msg = scrub_text(msg, ctx);
    }
    if let Some(culprit) = event.culprit.as_mut() {
        *culprit = scrub_text(culprit, ctx);
    }
    if let Some(tx) = event.transaction.as_mut() {
        *tx = scrub_text(tx, ctx);
    }
    if let Some(entry) = event.logentry.as_mut() {
        entry.message = scrub_text(&entry.message, ctx);
        entry.params.clear();
    }

    let mut error_kind = None::<String>;
    for exc in event.exception.values.iter_mut() {
        if error_kind.is_none() && !exc.ty.is_empty() {
            error_kind = Some(exc.ty.clone());
        }
        exc.ty = scrub_text(&exc.ty, ctx);
        if let Some(val) = exc.value.as_mut() {
            *val = scrub_text(val, ctx);
        }
        if let Some(st) = exc.stacktrace.as_mut() {
            scrub_stacktrace(st, ctx);
        }
        if let Some(st) = exc.raw_stacktrace.as_mut() {
            scrub_stacktrace(st, ctx);
        }
    }
    if let Some(st) = event.stacktrace.as_mut() {
        scrub_stacktrace(st, ctx);
    }
    for thread in event.threads.values.iter_mut() {
        thread.name = None;
        if let Some(st) = thread.stacktrace.as_mut() {
            scrub_stacktrace(st, ctx);
        }
    }

    // Strip device/hostname fields from contexts while keeping OS metadata.
    if let Some(SentryContext::Device(device)) = event.contexts.get_mut("device") {
        device.name = None;
        device.model = None;
    }

    // Scrub breadcrumbs (strip query/content/path metadata).
    for bc in event.breadcrumbs.values.iter_mut() {
        if let Some(msg) = bc.message.as_mut() {
            *msg = scrub_text(msg, ctx);
        }
        let keys: Vec<String> = bc.data.keys().cloned().collect();
        for k in keys {
            if is_sensitive_key(&k) {
                bc.data.remove(&k);
            } else if let Some(SentryValue::String(s)) = bc.data.get_mut(&k) {
                *s = scrub_text(s, ctx);
            }
        }
    }

    // Scrub extra map.
    let extra_keys: Vec<String> = event.extra.keys().cloned().collect();
    for k in extra_keys {
        if is_sensitive_key(&k) {
            event.extra.remove(&k);
        } else if let Some(val) = event.extra.get_mut(&k) {
            scrub_json_value(val, ctx);
        }
    }

    // Scrub existing tags, then stamp required metadata tags.
    let tag_keys: Vec<String> = event.tags.keys().cloned().collect();
    for k in tag_keys {
        if is_sensitive_key(&k) {
            event.tags.remove(&k);
        } else if let Some(v) = event.tags.get_mut(&k) {
            *v = scrub_text(v, ctx);
        }
    }

    event
        .tags
        .insert("app_version".to_string(), APP_VERSION.to_string());
    event
        .tags
        .insert("os".to_string(), env::consts::OS.to_string());
    event
        .tags
        .insert("gpui_version".to_string(), GPUI_VERSION.to_string());
    event
        .tags
        .insert("install_id".to_string(), ctx.install_id.clone());
    event.tags.insert(
        "error_kind".to_string(),
        error_kind.unwrap_or_else(|| "runtime_error".to_string()),
    );

    Some(event)
}

fn scrub_stacktrace(st: &mut sentry::protocol::Stacktrace, ctx: &ScrubContext) {
    for frame in st.frames.iter_mut() {
        frame.abs_path = None;
        frame.vars.clear();
        frame.pre_context.clear();
        frame.context_line = None;
        frame.post_context.clear();
        if let Some(filename) = frame.filename.take() {
            let basename = Path::new(&filename)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("<redacted-file>");
            frame.filename = Some(scrub_text(basename, ctx));
        }
    }
}

fn scrub_json_value(val: &mut SentryValue, ctx: &ScrubContext) {
    match val {
        SentryValue::String(s) => *s = scrub_text(s, ctx),
        SentryValue::Array(arr) => {
            for item in arr {
                scrub_json_value(item, ctx);
            }
        }
        SentryValue::Object(map) => {
            let keys: Vec<String> = map.keys().cloned().collect();
            for k in keys {
                if is_sensitive_key(&k) {
                    map.remove(&k);
                } else if let Some(v) = map.get_mut(&k) {
                    scrub_json_value(v, ctx);
                }
            }
        }
        _ => {}
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "content"
            | "content_preview"
            | "preview"
            | "summary"
            | "description"
            | "detail"
            | "reason"
            | "memory"
            | "memory_text"
            | "prompt"
            | "response"
            | "payload"
            | "query"
            | "search_query"
            | "metadata"
            | "command"
            | "env"
            | "db"
            | "database"
            | "db_path"
            | "path"
            | "abs_path"
            | "filename"
            | "tags"
            | "username"
            | "user"
            | "hostname"
            | "host"
            | "server_name"
            | "home"
    )
}

/// Write a scrubbed local crash report to `<log_dir>/crash-<unix_secs>.txt`.
pub fn write_local_crash_report(
    dir: &Path,
    install_id: &str,
    message: &str,
    location: Option<&str>,
    backtrace: &str,
) -> io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let _ = restrict_dir(dir);
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let report_path = dir.join(format!("crash-{now_secs}.txt"));

    let ctx = ScrubContext::from_environment(install_id);
    let scrubbed_message = scrub_text(message, &ctx);
    let scrubbed_location = location.map(|loc| scrub_text(loc, &ctx));
    let scrubbed_bt = scrub_text(backtrace, &ctx);

    let report = format!(
        "MemOS Desktop Crash Report\n\
         app_version: {APP_VERSION}\n\
         gpui_version: {GPUI_VERSION}\n\
         os: {os} ({arch})\n\
         install_id: {install_id}\n\
         timestamp_unix_s: {now_secs}\n\
         error_kind: panic\n\
         location: {loc}\n\
         message: {scrubbed_message}\n\
         \n\
         backtrace:\n\
         {scrubbed_bt}\n",
        os = env::consts::OS,
        arch = env::consts::ARCH,
        loc = scrubbed_location.as_deref().unwrap_or("unknown"),
    );

    fs::write(&report_path, &report)?;
    let _ = restrict_file(&report_path);
    if let Some(cell) = CRASH_TEST_REPORT_CAPTURE.get()
        && let Ok(mut guard) = cell.lock()
    {
        *guard = Some(report);
    }
    Ok(report_path)
}

/// Enable capture of the most recent local crash report body for in-process verification tests.
pub fn enable_test_crash_capture() {
    let cell = CRASH_TEST_REPORT_CAPTURE.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = cell.lock() {
        *guard = None;
    }
}

pub fn take_captured_crash_report() -> Option<String> {
    CRASH_TEST_REPORT_CAPTURE
        .get()
        .and_then(|cell| cell.lock().ok())
        .and_then(|mut guard| guard.take())
}

/// Holds the active background tracing worker and optional Sentry client guard.
pub struct TelemetryHandle {
    pub log_dir: PathBuf,
    _log_guard: Option<WorkerGuard>,
    sentry_guard: Mutex<Option<sentry::ClientInitGuard>>,
}

impl TelemetryHandle {
    /// Initialize non-blocking rotating file logs (`5 × 2 MB`) and install the local panic hook.
    /// Does NOT initialize Sentry unless `settings.crash_reporting_enabled()` is true and a DSN exists.
    pub fn init(settings: &AppSettings) -> Self {
        let dir = log_dir();
        let mut guard_slot = None;

        TRACING_INIT.call_once(|| {
            if let Ok(writer) = SizeRotatingFileWriter::new(
                dir.clone(),
                LOG_BASENAME,
                LOG_MAX_FILE_BYTES,
                LOG_MAX_FILES,
            ) {
                let (non_blocking, worker_guard) = tracing_appender::non_blocking(writer);
                let filter = EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| EnvFilter::new("memos_desktop=info,warn"));
                let _ = tracing_subscriber::registry()
                    .with(filter)
                    .with(
                        tracing_subscriber::fmt::layer()
                            .with_writer(non_blocking)
                            .with_ansi(false),
                    )
                    .try_init();
                guard_slot = Some(worker_guard);
            }
        });

        install_panic_hook(dir.clone(), settings.install_id.clone());

        let handle = Self {
            log_dir: dir,
            _log_guard: guard_slot,
            sentry_guard: Mutex::new(None),
        };
        handle.sync_sentry_from_settings(settings);
        handle
    }

    /// Enable or disable the Sentry client when user consent changes.
    pub fn sync_sentry_from_settings(&self, settings: &AppSettings) {
        let Ok(mut guard) = self.sentry_guard.lock() else {
            return;
        };
        if !settings.crash_reporting_enabled() {
            *guard = None;
            return;
        }
        if guard.is_some() {
            return;
        }
        let Some(dsn_raw) = resolve_dsn() else {
            tracing::info!(
                install_id = %settings.install_id,
                "crash reporting opted in but no DSN configured; staying in local-only mode"
            );
            return;
        };
        match dsn_raw.parse::<Dsn>() {
            Ok(parsed_dsn) => {
                let install_id = settings.install_id.clone();
                let mut opts = sentry::ClientOptions::default();
                opts.dsn = Some(parsed_dsn);
                opts.release = Some(format!("{APP_NAME}@{APP_VERSION}").into());
                opts.send_default_pii = false;
                opts.attach_stacktrace = true;
                opts.before_send = Some(std::sync::Arc::new(move |event| {
                    let ctx = ScrubContext::from_environment(install_id.clone());
                    scrub_sentry_event(event, &ctx)
                }));
                opts.in_app_include = vec!["memos_desktop"];
                let client_guard = sentry::init(opts);
                *guard = Some(client_guard);
                tracing::info!(
                    install_id = %settings.install_id,
                    "sentry crash reporting initialized (scrubbed)"
                );
            }
            Err(_) => {
                tracing::warn!("invalid MEMOS_DESKTOP_SENTRY_DSN; staying in local-only mode");
            }
        }
    }
}

fn install_panic_hook(dir: PathBuf, install_id: String) {
    PANIC_HOOK_INIT.call_once(move || {
        let prev = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            let msg = if let Some(s) = info.payload().downcast_ref::<&str>() {
                (*s).to_string()
            } else if let Some(s) = info.payload().downcast_ref::<String>() {
                s.clone()
            } else {
                "panic".to_string()
            };
            let loc = info
                .location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
            let bt = std::backtrace::Backtrace::force_capture().to_string();

            let report_path =
                write_local_crash_report(&dir, &install_id, &msg, loc.as_deref(), &bt).ok();

            let suppress_dialog =
                env::var("MEMOS_NO_CRASH_DIALOG").ok().as_deref() == Some("1") || cfg!(test);
            if !suppress_dialog
                && let Some(path) = report_path.as_ref()
                && let Ok(exe) = env::current_exe()
            {
                let _ = std::process::Command::new(exe)
                    .arg("--crash-dialog")
                    .arg(path)
                    .spawn();
            }

            prev(info);
        }));
    });
}

/// Build non-sensitive diagnostics text (`--diagnostics` and "Copy diagnostics").
/// Never includes memory text, tags, or search queries.
pub fn build_diagnostics_text(
    resolved_db: &ResolvedDbPath,
    overview: Option<&DbOverview>,
    settings: &AppSettings,
    log_directory: &Path,
    harnesses: &[Detection],
) -> String {
    let mut lines = Vec::new();
    lines.push(format!("{APP_NAME} v{APP_VERSION}"));
    lines.push(format!("gpui: gpui-unofficial {GPUI_VERSION}"));
    lines.push(format!("os: {} ({})", env::consts::OS, env::consts::ARCH));
    lines.push(format!("sqlite: {}", rusqlite::version()));
    lines.push(format!("install_id: {}", settings.install_id));
    lines.push(format!(
        "crash_reporting: {} (dsn_configured: {})",
        match settings.crash_reporting_consent {
            None => "off (first-run opt-in pending)",
            Some(false) => "off (declined)",
            Some(true) => "on (scrubbed)",
        },
        resolve_dsn().is_some()
    ));
    lines.push(format!(
        "db_path: {} (source: {}, exists: {})",
        resolved_db.path.display(),
        resolved_db.source.label(),
        resolved_db.path.exists()
    ));
    lines.push(format!("log_dir: {}", log_directory.display()));

    if let Ok(entries) = fs::read_dir(log_directory) {
        let mut files: Vec<(String, u64)> = entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let len = e.metadata().ok()?.len();
                Some((name, len))
            })
            .collect();
        files.sort_by(|a, b| a.0.cmp(&b.0));
        if files.is_empty() {
            lines.push("log_files: (none yet)".to_string());
        } else {
            let formatted: Vec<String> = files
                .into_iter()
                .map(|(n, sz)| format!("{n} ({sz} B)"))
                .collect();
            lines.push(format!("log_files: {}", formatted.join(", ")));
        }
    }

    if let Some(ov) = overview {
        lines.push("table_counts:".to_string());
        for tbl in &ov.tables {
            if tbl.present {
                lines.push(format!(
                    "  {}: {} rows ({} cols)",
                    tbl.name,
                    tbl.row_count,
                    tbl.columns.len()
                ));
            } else {
                lines.push(format!("  {}: missing", tbl.name));
            }
        }
    } else {
        lines.push("table_counts: (database not opened)".to_string());
    }

    lines.push("harnesses (read-only detection):".to_string());
    let mut sorted: BTreeMap<&str, &Detection> = BTreeMap::new();
    for h in harnesses {
        sorted.insert(h.id, h);
    }
    for (_, h) in sorted {
        lines.push(format!(
            "  {}: installed={} config_paths={} version={}",
            h.id,
            h.installed,
            h.config_paths.len(),
            h.version.as_deref().unwrap_or("unknown")
        ));
    }

    lines.join("\n")
}

/// Trigger an intentional crash-test panic in debug builds to verify local report + scrubber.
#[cfg(debug_assertions)]
pub fn run_crash_test(settings: &AppSettings) -> ! {
    let _telemetry = TelemetryHandle::init(settings);
    let canary = "MEMOS_SYNTHETIC_SECRET_CANARY_987654";
    register_sensitive_text(canary);

    // Verify Sentry event scrubber directly before panicking.
    let ctx = ScrubContext::from_environment(&settings.install_id);
    let sample = Event {
        message: Some(format!(
            "Crash test query=\"{canary}\" content=\"{canary}\" at {}",
            log_dir().display()
        )),
        ..Default::default()
    };
    let scrubbed = scrub_sentry_event(sample, &ctx).expect("event preserved");
    let scrubbed_msg = scrubbed.message.as_deref().unwrap_or("");
    assert!(
        !scrubbed_msg.contains(canary),
        "scrubber failed to strip synthetic secret"
    );

    tracing::info!(
        install_id = %settings.install_id,
        "running debug --crash-test"
    );
    panic!("memos-desktop --crash-test synthetic panic (secret={canary})");
}

/// One recorded startup phase in milliseconds relative to process start.
#[derive(Clone, Debug, Serialize)]
pub struct StartupPhaseRecord {
    pub phase: String,
    pub start_ms: f64,
    pub duration_ms: f64,
    pub end_ms: f64,
}

/// Machine-readable JSON startup timing report written via `--startup-report <path>`.
#[derive(Clone, Debug, Serialize)]
pub struct StartupReport {
    pub app_name: String,
    pub app_version: String,
    pub os: String,
    pub arch: String,
    pub first_frame_ms: Option<f64>,
    pub first_list_page_ms: Option<f64>,
    pub total_ms: f64,
    pub phases: Vec<StartupPhaseRecord>,
}

#[derive(Default)]
struct StartupTimelineState {
    tracing_ready: bool,
    emitted_count: usize,
    report_path: Option<PathBuf>,
    first_frame_ms: Option<f64>,
    first_list_page_ms: Option<f64>,
    phases: Vec<StartupPhaseRecord>,
}

/// Thread-safe accumulator emitting one `tracing` event per startup phase and optional JSON report.
pub struct StartupTimeline {
    started_at: Instant,
    state: Mutex<StartupTimelineState>,
}

impl StartupTimeline {
    pub fn new(started_at: Instant, report_path: Option<PathBuf>) -> std::sync::Arc<Self> {
        let timeline = std::sync::Arc::new(Self {
            started_at,
            state: Mutex::new(StartupTimelineState {
                report_path,
                ..Default::default()
            }),
        });
        timeline.mark_instant("process_start", started_at);
        timeline
    }

    pub fn started_at(&self) -> Instant {
        self.started_at
    }

    pub fn elapsed_ms(&self, at: Instant) -> f64 {
        let ms = at.saturating_duration_since(self.started_at).as_secs_f64() * 1000.0;
        (ms * 1000.0).round() / 1000.0
    }

    pub fn mark_instant(&self, phase: &str, at: Instant) {
        self.record_span(phase, at, at);
    }

    pub fn record_span(&self, phase: &str, start: Instant, end: Instant) {
        let start_ms = self.elapsed_ms(start);
        let end_ms = self.elapsed_ms(end);
        let duration_ms = ((end.saturating_duration_since(start).as_secs_f64() * 1000.0) * 1000.0)
            .round()
            / 1000.0;
        let rec = StartupPhaseRecord {
            phase: phase.to_string(),
            start_ms,
            duration_ms,
            end_ms,
        };

        let to_emit = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            if phase == "first_frame" && state.first_frame_ms.is_none() {
                state.first_frame_ms = Some(end_ms);
            }
            if phase == "first_list_page" && state.first_list_page_ms.is_none() {
                state.first_list_page_ms = Some(end_ms);
            }
            state.phases.push(rec);
            Self::drain_pending_logs_locked(&mut state)
        };

        for rec in to_emit {
            Self::emit_phase_log(&rec);
        }
    }

    pub fn mark_tracing_ready(&self) {
        let to_emit = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            state.tracing_ready = true;
            Self::drain_pending_logs_locked(&mut state)
        };
        for rec in to_emit {
            Self::emit_phase_log(&rec);
        }
    }

    pub fn has_report_path(&self) -> bool {
        self.state
            .lock()
            .map(|s| s.report_path.is_some())
            .unwrap_or(false)
    }

    pub fn snapshot_report(&self) -> StartupReport {
        let Ok(state) = self.state.lock() else {
            return StartupReport {
                app_name: APP_NAME.to_string(),
                app_version: APP_VERSION.to_string(),
                os: env::consts::OS.to_string(),
                arch: env::consts::ARCH.to_string(),
                first_frame_ms: None,
                first_list_page_ms: None,
                total_ms: 0.0,
                phases: Vec::new(),
            };
        };
        let total_ms = state
            .phases
            .iter()
            .map(|p| p.end_ms)
            .fold(0.0_f64, f64::max);
        StartupReport {
            app_name: APP_NAME.to_string(),
            app_version: APP_VERSION.to_string(),
            os: env::consts::OS.to_string(),
            arch: env::consts::ARCH.to_string(),
            first_frame_ms: state.first_frame_ms,
            first_list_page_ms: state.first_list_page_ms,
            total_ms,
            phases: state.phases.clone(),
        }
    }

    pub fn write_report_if_configured(&self) -> io::Result<Option<PathBuf>> {
        let report_path = {
            let Ok(state) = self.state.lock() else {
                return Ok(None);
            };
            state.report_path.clone()
        };
        let Some(path) = report_path else {
            return Ok(None);
        };
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            fs::create_dir_all(parent)?;
        }
        let report = self.snapshot_report();
        let json = serde_json::to_string_pretty(&report)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, json)?;
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
        fs::rename(&tmp, &path)?;
        Ok(Some(path))
    }

    fn drain_pending_logs_locked(state: &mut StartupTimelineState) -> Vec<StartupPhaseRecord> {
        if !state.tracing_ready || state.emitted_count >= state.phases.len() {
            return Vec::new();
        }
        let drained = state.phases[state.emitted_count..].to_vec();
        state.emitted_count = state.phases.len();
        drained
    }

    fn emit_phase_log(rec: &StartupPhaseRecord) {
        tracing::info!(
            phase = %rec.phase,
            start_ms = rec.start_ms,
            duration_ms = rec.duration_ms,
            end_ms = rec.end_ms,
            "startup phase"
        );
    }
}
