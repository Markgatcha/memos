use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use directories::{BaseDirs, ProjectDirs};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::core::model::{QueryFilter, SortOrder, ViewMode};

/// UI color theme.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ThemeMode {
    #[default]
    System,
    Dark,
    Light,
}

impl ThemeMode {
    pub fn toggle_from_dark(self, currently_dark: bool) -> Self {
        match self {
            ThemeMode::System => {
                if currently_dark {
                    ThemeMode::Light
                } else {
                    ThemeMode::Dark
                }
            }
            ThemeMode::Dark => ThemeMode::Light,
            ThemeMode::Light => ThemeMode::Dark,
        }
    }

    pub fn toggle(self) -> Self {
        self.toggle_from_dark(self != ThemeMode::Light)
    }

    pub fn label(self) -> &'static str {
        match self {
            ThemeMode::System => "System",
            ThemeMode::Dark => "Dark",
            ThemeMode::Light => "Light",
        }
    }
}

/// A named filter preset displayed in the sidebar.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SavedView {
    pub id: String,
    pub name: String,
    pub filter: QueryFilter,
    pub built_in: bool,
}

impl SavedView {
    pub fn defaults() -> Vec<Self> {
        vec![
            SavedView {
                id: "all".to_string(),
                name: "All".to_string(),
                filter: QueryFilter::default(),
                built_in: true,
            },
            SavedView {
                id: "recent".to_string(),
                name: "Recent".to_string(),
                filter: QueryFilter {
                    sort: SortOrder::Recency,
                    ..Default::default()
                },
                built_in: true,
            },
            SavedView {
                id: "important".to_string(),
                name: "Important".to_string(),
                filter: QueryFilter {
                    min_importance: Some(0.7),
                    sort: SortOrder::Importance,
                    ..Default::default()
                },
                built_in: true,
            },
            SavedView {
                id: "contradictions".to_string(),
                name: "Contradictions".to_string(),
                filter: QueryFilter {
                    has_contradiction: true,
                    ..Default::default()
                },
                built_in: true,
            },
        ]
    }

    /// Resolve a view's query filter relative to the current wall-clock time.
    pub fn resolved_filter(&self, now_ms: i64) -> QueryFilter {
        let mut filter = self.filter.clone();
        if self.id == "recent" && filter.created_after_ms.is_none() {
            const SEVEN_DAYS_MS: i64 = 7 * 24 * 60 * 60 * 1000;
            filter.created_after_ms = Some(now_ms.saturating_sub(SEVEN_DAYS_MS));
        }
        filter
    }
}

/// Saved logical window bounds (pixels) for restoring window size and position.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct WindowBoundsSetting {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    #[serde(default)]
    pub maximized: bool,
}

impl WindowBoundsSetting {
    pub const MIN_WIDTH: f32 = 900.0;
    pub const MIN_HEIGHT: f32 = 600.0;

    /// Clamp saved window bounds to valid dimensions and at least one visible display `(x, y, w, h)`.
    pub fn clamp_to_displays(self, displays: &[(f32, f32, f32, f32)]) -> Self {
        let mut width = if self.width.is_finite() {
            self.width.max(Self::MIN_WIDTH)
        } else {
            1100.0
        };
        let mut height = if self.height.is_finite() {
            self.height.max(Self::MIN_HEIGHT)
        } else {
            720.0
        };
        let mut x = if self.x.is_finite() { self.x } else { 80.0 };
        let mut y = if self.y.is_finite() { self.y } else { 80.0 };

        if displays.is_empty() {
            return Self {
                x,
                y,
                width,
                height,
                maximized: self.maximized,
            };
        }

        // Prefer a display that overlaps the saved titlebar/header region (`>= 80x40` px visible).
        let matching = displays.iter().copied().find(|&(dx, dy, dw, dh)| {
            let overlap_w = (x + width).min(dx + dw) - x.max(dx);
            let title_h = 44.0_f32.min(height);
            let overlap_h = (y + title_h).min(dy + dh) - y.max(dy);
            overlap_w >= 80.0 && overlap_h >= 24.0
        });

        let (dx, dy, dw, dh) = matching.unwrap_or(displays[0]);
        width = width.min(dw.max(Self::MIN_WIDTH));
        height = height.min(dh.max(Self::MIN_HEIGHT));

        if matching.is_none() {
            x = dx + ((dw - width) * 0.5).max(0.0);
            y = dy + ((dh - height) * 0.5).max(0.0);
        } else {
            let max_x = dx + (dw - width).max(0.0);
            let max_y = dy + (dh - height).max(0.0);
            x = x.clamp(dx, max_x.max(dx));
            y = y.clamp(dy, max_y.max(dy));
        }

        Self {
            x,
            y,
            width,
            height,
            maximized: self.maximized,
        }
    }
}

pub const DEFAULT_WRITER_COMMAND: &str = "npx -y @mem-os/sdk mcp";

fn default_writer_command_string() -> String {
    crate::core::write_bridge::recommended_writer_command()
}

/// How many recent search expressions are kept.
pub const RECENT_SEARCH_LIMIT: usize = 8;

/// Persistent application settings (never stores memory content).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    /// Random installation UUID (never linked to user or host identity).
    pub install_id: String,
    /// `None` = prompt on first run; `Some(false)` = off; `Some(true)` = opted in.
    pub crash_reporting_consent: Option<bool>,
    pub theme: ThemeMode,
    pub default_view: ViewMode,
    pub onboarding_completed: bool,
    pub celebrated_100: bool,
    pub preferred_db_path: Option<PathBuf>,
    pub saved_views: Vec<SavedView>,
    pub window_bounds: Option<WindowBoundsSetting>,
    pub last_sort: SortOrder,
    pub last_view_mode: Option<ViewMode>,
    pub last_saved_view_id: Option<String>,
    /// Enable creating, editing, and forgetting memories via the MCP stdio writer.
    pub write_mode: bool,
    /// Command used to spawn the MemOS MCP stdio server when write mode is active.
    pub writer_command: String,
    /// List row density preference (`Comfortable` 64 px / `Compact` 48 px).
    pub row_density: crate::core::model::RowDensity,
    /// Recently submitted search expressions, newest first. Local to this
    /// settings file only (like saved views); never sent anywhere.
    pub recent_searches: Vec<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            install_id: Uuid::new_v4().to_string(),
            crash_reporting_consent: None,
            theme: ThemeMode::System,
            default_view: ViewMode::List,
            onboarding_completed: false,
            celebrated_100: false,
            preferred_db_path: None,
            saved_views: SavedView::defaults(),
            window_bounds: None,
            last_sort: SortOrder::Recency,
            last_view_mode: None,
            last_saved_view_id: None,
            write_mode: false,
            writer_command: default_writer_command_string(),
            row_density: crate::core::model::RowDensity::Comfortable,
            recent_searches: Vec::new(),
        }
    }
}

impl AppSettings {
    /// Non-empty writer command with default fallback.
    pub fn effective_writer_command(&self) -> String {
        let trimmed = self.writer_command.trim();
        if trimmed.is_empty() {
            crate::core::write_bridge::recommended_writer_command()
        } else {
            trimmed.to_string()
        }
    }

    /// Whether crash reporting is actively opted in (OFF by default).
    pub fn crash_reporting_enabled(&self) -> bool {
        self.crash_reporting_consent == Some(true)
    }

    /// Generate a readable default name from active facets, falling back to `"View N"`.
    pub fn suggested_view_name(&self, filter: &QueryFilter) -> String {
        let mut parts: Vec<String> = Vec::new();
        if let Some(tag) = filter
            .tag
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            parts.push(format!("#{}", tag.trim_start_matches('#')));
        }
        if let Some(ns) = filter
            .namespace
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            parts.push(ns.to_string());
        }
        if let Some(ty) = filter
            .node_type
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            parts.push(ty.to_string());
        }
        if let Some(prov) = filter
            .provenance
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            parts.push(prov.to_string());
        }
        if filter.has_contradiction {
            parts.push("contradictions".to_string());
        }
        if filter.min_importance.is_some() {
            parts.push("important".to_string());
        }
        let q = filter.query.trim();
        if parts.is_empty() && !q.is_empty() {
            let short_q: String = q.chars().take(24).collect();
            parts.push(format!("\"{short_q}\""));
        }

        let base = if parts.is_empty() {
            let mut n = 1usize;
            loop {
                let candidate = format!("View {n}");
                if !self
                    .saved_views
                    .iter()
                    .any(|v| v.name.eq_ignore_ascii_case(&candidate))
                {
                    return candidate;
                }
                n += 1;
            }
        } else {
            parts.join(" · ")
        };
        self.dedupe_saved_view_name(&base)
    }

    /// Deduplicate a saved view name using `" 2"`, `" 3"`, ... suffixes when colliding.
    pub fn dedupe_saved_view_name(&self, desired: &str) -> String {
        let trimmed = desired.trim();
        let base = if trimmed.is_empty() {
            "Custom View"
        } else {
            trimmed
        };
        if !self
            .saved_views
            .iter()
            .any(|v| v.name.eq_ignore_ascii_case(base))
        {
            return base.to_string();
        }
        let mut suffix = 2usize;
        loop {
            let candidate = format!("{base} {suffix}");
            if !self
                .saved_views
                .iter()
                .any(|v| v.name.eq_ignore_ascii_case(&candidate))
            {
                return candidate;
            }
            suffix += 1;
        }
    }

    /// Save a custom (non-built-in) view and mark it as the last active saved view.
    pub fn add_custom_saved_view(&mut self, desired_name: &str, filter: QueryFilter) -> SavedView {
        let name = self.dedupe_saved_view_name(desired_name);
        let view = SavedView {
            id: format!("custom-{}", Uuid::new_v4().simple()),
            name,
            filter,
            built_in: false,
        };
        self.saved_views.push(view.clone());
        self.last_saved_view_id = Some(view.id.clone());
        view
    }

    /// Rename a custom view. Returns the final (deduplicated) name, or `None`
    /// when the view does not exist or is built in.
    pub fn rename_custom_saved_view(&mut self, id: &str, desired: &str) -> Option<String> {
        let current = self
            .saved_views
            .iter()
            .find(|v| v.id == id && !v.built_in)?
            .name
            .clone();
        let trimmed = desired.trim();
        let name = if trimmed.is_empty() || trimmed.eq_ignore_ascii_case(&current) {
            if trimmed.is_empty() {
                current
            } else {
                trimmed.to_string()
            }
        } else {
            self.dedupe_saved_view_name(trimmed)
        };
        let view = self.saved_views.iter_mut().find(|v| v.id == id)?;
        view.name = name.clone();
        Some(name)
    }

    /// Replace a custom view's filter (including sort). Built-in views are fixed.
    pub fn update_custom_saved_view_filter(&mut self, id: &str, filter: QueryFilter) -> bool {
        match self
            .saved_views
            .iter_mut()
            .find(|v| v.id == id && !v.built_in)
        {
            Some(view) => {
                view.filter = filter;
                true
            }
            None => false,
        }
    }

    /// Remember a search expression, newest first, without duplicates.
    pub fn record_recent_search(&mut self, expression: &str) -> bool {
        let expr = expression.split_whitespace().collect::<Vec<_>>().join(" ");
        if expr.is_empty() {
            return false;
        }
        if self.recent_searches.first().map(String::as_str) == Some(expr.as_str()) {
            return false;
        }
        self.recent_searches.retain(|r| r != &expr);
        self.recent_searches.insert(0, expr);
        self.recent_searches.truncate(RECENT_SEARCH_LIMIT);
        true
    }

    /// Remove a custom (non-built-in) view by ID. Built-in views cannot be removed.
    pub fn remove_custom_saved_view(&mut self, id: &str) -> bool {
        let before = self.saved_views.len();
        self.saved_views.retain(|v| v.built_in || v.id != id);
        let removed = self.saved_views.len() < before;
        if removed && self.last_saved_view_id.as_deref() == Some(id) {
            self.last_saved_view_id = Some("all".to_string());
        }
        removed
    }

    pub fn config_path() -> PathBuf {
        if let Some(home) = env::var_os("MEMOS_DESKTOP_HOME") {
            let dir = PathBuf::from(home);
            if !dir.as_os_str().is_empty() {
                return dir.join("settings.json");
            }
        }
        if let Some(proj) = ProjectDirs::from("ai", "memos", "MemOS Desktop") {
            proj.config_dir().join("settings.json")
        } else if let Some(base) = BaseDirs::new() {
            base.home_dir().join(".memos").join("desktop-settings.json")
        } else {
            PathBuf::from("memos-desktop-settings.json")
        }
    }

    pub fn load() -> Self {
        Self::load_from(&Self::config_path())
    }

    pub fn load_from(path: &Path) -> Self {
        let Ok(raw) = fs::read_to_string(path) else {
            return Self::default();
        };
        let mut parsed: AppSettings = serde_json::from_str(&raw).unwrap_or_default();
        if parsed.install_id.trim().is_empty() {
            parsed.install_id = Uuid::new_v4().to_string();
        }
        if parsed.saved_views.is_empty() || parsed.saved_views.iter().all(|v| v.built_in) {
            parsed.saved_views = SavedView::defaults();
        }
        parsed
    }

    pub fn save_to(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            fs::create_dir_all(parent)?;
        }
        let body = serde_json::to_string_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("settings.json");
        let tmp_path = path.with_file_name(format!("{file_name}.tmp.{}", Uuid::new_v4()));
        if let Err(err) = fs::write(&tmp_path, body) {
            let _ = fs::remove_file(&tmp_path);
            return Err(err);
        }
        if let Err(err) = fs::rename(&tmp_path, path) {
            let _ = fs::remove_file(&tmp_path);
            return Err(err);
        }
        Ok(())
    }

    /// Persist settings without blocking the calling thread.
    pub fn save_async(&self) {
        let cloned = self.clone();
        let path = Self::config_path();
        std::thread::Builder::new()
            .name("settings-save".to_string())
            .spawn(move || {
                if let Err(_err) = cloned.save_to(&path) {
                    crate::core_warn!(error = %_err, "failed to persist settings");
                }
            })
            .ok();
    }
}

/// Source that selected the active database path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DbPathSource {
    CliFlag,
    EnvVar,
    SavedPreference,
    DefaultHome,
}

impl DbPathSource {
    pub fn label(self) -> &'static str {
        match self {
            DbPathSource::CliFlag => "--db flag",
            DbPathSource::EnvVar => "MEMOS_DB env",
            DbPathSource::SavedPreference => "saved database",
            DbPathSource::DefaultHome => "~/.memos/memos.db",
        }
    }
}

/// Resolved DB path and provenance of the resolution rule.
#[derive(Clone, Debug)]
pub struct ResolvedDbPath {
    pub path: PathBuf,
    pub source: DbPathSource,
}

/// Resolve the database path using exact precedence:
/// `--db <path>`, then `MEMOS_DB`, then `~/.memos/memos.db`.
pub fn resolve_db_path(cli_db: Option<&Path>) -> ResolvedDbPath {
    resolve_db_path_with_settings(cli_db, &AppSettings::default())
}

/// Resolve the database path using `--db <path>`, `MEMOS_DB`, saved onboarding choice, or `~/.memos/memos.db`.
pub fn resolve_db_path_with_settings(
    cli_db: Option<&Path>,
    settings: &AppSettings,
) -> ResolvedDbPath {
    let env_val = env::var("MEMOS_DB").ok();
    resolve_db_path_with_settings_and_env(cli_db, env_val.as_deref(), settings)
}

pub fn resolve_db_path_with_settings_and_env(
    cli_db: Option<&Path>,
    env_db: Option<&str>,
    settings: &AppSettings,
) -> ResolvedDbPath {
    if let Some(p) = cli_db.filter(|p| !p.as_os_str().is_empty()) {
        return ResolvedDbPath {
            path: expand_tilde(p),
            source: DbPathSource::CliFlag,
        };
    }

    if let Some(env_val) = env_db {
        let trimmed = env_val.trim();
        if !trimmed.is_empty() {
            return ResolvedDbPath {
                path: expand_tilde(Path::new(trimmed)),
                source: DbPathSource::EnvVar,
            };
        }
    }

    if let Some(saved) = settings
        .preferred_db_path
        .as_deref()
        .filter(|p| !p.as_os_str().is_empty())
    {
        return ResolvedDbPath {
            path: expand_tilde(saved),
            source: DbPathSource::SavedPreference,
        };
    }

    let default_path = BaseDirs::new()
        .map(|b| b.home_dir().join(".memos").join("memos.db"))
        .unwrap_or_else(|| PathBuf::from(".memos").join("memos.db"));

    ResolvedDbPath {
        path: default_path,
        source: DbPathSource::DefaultHome,
    }
}

fn expand_tilde(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\"))
        && let Some(base) = BaseDirs::new()
    {
        return base.home_dir().join(rest);
    }
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_views_can_be_renamed_and_refiltered_but_built_ins_cannot() {
        let mut settings = AppSettings::default();
        let view = settings.add_custom_saved_view("Auth", QueryFilter::default());
        settings.add_custom_saved_view("Infra", QueryFilter::default());
        assert_eq!(
            settings.rename_custom_saved_view(&view.id, "  Infra "),
            Some("Infra 2".to_string())
        );
        assert_eq!(
            settings.rename_custom_saved_view(&view.id, "infra 2"),
            Some("infra 2".to_string())
        );
        assert_eq!(settings.rename_custom_saved_view("all", "Everything"), None);
        let narrowed = QueryFilter {
            tag: Some("auth".into()),
            ..Default::default()
        };
        assert!(settings.update_custom_saved_view_filter(&view.id, narrowed.clone()));
        assert!(!settings.update_custom_saved_view_filter("all", narrowed.clone()));
        let saved = settings
            .saved_views
            .iter()
            .find(|v| v.id == view.id)
            .unwrap();
        assert_eq!(saved.filter, narrowed);
    }

    #[test]
    fn recent_searches_dedupe_normalize_and_cap() {
        let mut settings = AppSettings::default();
        assert!(!settings.record_recent_search("   "));
        assert!(settings.record_recent_search("tag:auth  pkce"));
        assert!(!settings.record_recent_search("tag:auth pkce"));
        assert!(settings.record_recent_search("oauth"));
        assert!(settings.record_recent_search("tag:auth pkce"));
        assert_eq!(settings.recent_searches, vec!["tag:auth pkce", "oauth"]);
        for i in 0..20 {
            settings.record_recent_search(&format!("q{i}"));
        }
        assert_eq!(settings.recent_searches.len(), RECENT_SEARCH_LIMIT);
        assert_eq!(settings.recent_searches[0], "q19");
    }

    #[test]
    fn cli_flag_takes_precedence_over_env_and_default() {
        let resolved = resolve_db_path(Some(Path::new("/custom/path/memos.db")));
        assert_eq!(resolved.source, DbPathSource::CliFlag);
        assert_eq!(resolved.path, PathBuf::from("/custom/path/memos.db"));
    }

    #[test]
    fn settings_round_trip_preserves_install_id_and_consent() {
        let tmp = env::temp_dir().join(format!("memos-settings-{}.json", Uuid::new_v4()));
        let mut s = AppSettings::default();
        assert!(!s.crash_reporting_enabled());
        s.crash_reporting_consent = Some(true);
        s.theme = ThemeMode::Light;
        s.save_to(&tmp).expect("save settings");

        let loaded = AppSettings::load_from(&tmp);
        assert_eq!(loaded.install_id, s.install_id);
        assert_eq!(loaded.crash_reporting_consent, Some(true));
        assert_eq!(loaded.theme, ThemeMode::Light);
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn db_path_precedence_respects_cli_then_env_then_saved_then_default() {
        let settings = AppSettings {
            preferred_db_path: Some(PathBuf::from("/saved/memos.db")),
            ..Default::default()
        };

        let cli = resolve_db_path_with_settings_and_env(
            Some(Path::new("/cli/memos.db")),
            Some("/env/memos.db"),
            &settings,
        );
        assert_eq!(cli.source, DbPathSource::CliFlag);
        assert_eq!(cli.path, PathBuf::from("/cli/memos.db"));

        let from_env =
            resolve_db_path_with_settings_and_env(None, Some("/env/memos.db"), &settings);
        assert_eq!(from_env.source, DbPathSource::EnvVar);
        assert_eq!(from_env.path, PathBuf::from("/env/memos.db"));

        let saved = resolve_db_path_with_settings_and_env(None, Some("   "), &settings);
        assert_eq!(saved.source, DbPathSource::SavedPreference);
        assert_eq!(saved.path, PathBuf::from("/saved/memos.db"));

        let default = resolve_db_path_with_settings_and_env(None, None, &AppSettings::default());
        assert_eq!(default.source, DbPathSource::DefaultHome);
    }

    #[test]
    fn atomic_settings_save_leaves_no_temp_files() {
        let dir = env::temp_dir().join(format!("memos-settings-dir-{}", Uuid::new_v4()));
        let path = dir.join("settings.json");
        let s = AppSettings {
            onboarding_completed: true,
            default_view: ViewMode::Graph,
            ..Default::default()
        };
        s.save_to(&path).expect("atomic save");
        let files: Vec<String> = fs::read_dir(&dir)
            .expect("read dir")
            .filter_map(|e| e.ok().and_then(|d| d.file_name().into_string().ok()))
            .collect();
        assert_eq!(files, vec!["settings.json".to_string()]);
        assert_eq!(ThemeMode::System.toggle_from_dark(true), ThemeMode::Light);
        assert_eq!(ThemeMode::System.toggle_from_dark(false), ThemeMode::Dark);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn round_trip_persists_bounds_sort_last_view_and_custom_views() {
        let tmp = env::temp_dir().join(format!("memos-settings-p0-{}.json", Uuid::new_v4()));
        let mut s = AppSettings {
            window_bounds: Some(WindowBoundsSetting {
                x: 42.0,
                y: 64.0,
                width: 1280.0,
                height: 820.0,
                maximized: false,
            }),
            last_sort: SortOrder::Trust,
            last_view_mode: Some(ViewMode::Graph),
            write_mode: true,
            writer_command: "memos mcp".to_string(),
            ..Default::default()
        };
        let filter = QueryFilter {
            tag: Some("auth".to_string()),
            node_type: Some("decision".to_string()),
            sort: SortOrder::Importance,
            ..Default::default()
        };
        assert_eq!(s.suggested_view_name(&filter), "#auth · decision");
        let added = s.add_custom_saved_view("#auth · decision", filter.clone());
        assert_eq!(added.name, "#auth · decision");
        let dup = s.add_custom_saved_view("#auth · decision", filter);
        assert_eq!(dup.name, "#auth · decision 2");
        assert!(!dup.built_in);
        assert!(!s.remove_custom_saved_view("all"));

        s.save_to(&tmp).expect("save settings");
        let loaded = AppSettings::load_from(&tmp);
        assert_eq!(loaded.window_bounds, s.window_bounds);
        assert_eq!(loaded.last_sort, SortOrder::Trust);
        assert_eq!(loaded.last_view_mode, Some(ViewMode::Graph));
        assert!(loaded.write_mode);
        assert_eq!(loaded.writer_command, "memos mcp");
        assert_eq!(loaded.last_saved_view_id.as_deref(), Some(dup.id.as_str()));
        assert!(loaded.saved_views.iter().any(|v| v.id == added.id));
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn window_bounds_clamp_prevents_offscreen_or_undersized_window() {
        let displays = [(0.0, 0.0, 1920.0, 1080.0)];
        let tiny = WindowBoundsSetting {
            x: 5000.0,
            y: -400.0,
            width: 500.0,
            height: 300.0,
            maximized: false,
        };
        let clamped = tiny.clamp_to_displays(&displays);
        assert!(clamped.width >= WindowBoundsSetting::MIN_WIDTH);
        assert!(clamped.height >= WindowBoundsSetting::MIN_HEIGHT);
        assert!(clamped.x >= 0.0 && clamped.x + clamped.width <= 1920.0);
        assert!(clamped.y >= 0.0 && clamped.y + clamped.height <= 1080.0);
    }
}
