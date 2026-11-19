pub mod adapters;

use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// Transport configuration for a MemOS (or third-party) MCP server entry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum McpTransport {
    Stdio { command: String, args: Vec<String> },
    Http { url: String },
}

/// Configured MCP server discovered read-only from a harness config file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub name: String,
    pub transport: McpTransport,
    pub source_path: PathBuf,
    pub enabled: bool,
}

/// Read-only detection result for an AI coding harness.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Detection {
    pub id: &'static str,
    pub display_name: &'static str,
    pub installed: bool,
    pub version: Option<String>,
    pub config_paths: Vec<PathBuf>,
    pub memos_configured: bool,
    #[serde(default)]
    pub print_only: bool,
}

/// Target serialization format for generated MCP configuration snippets.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConfigFormat {
    Json,
    Toml,
    Yaml,
}

/// Non-mutating plan describing how MemOS MCP would be added to a harness.
///
/// Computes the diff, backup path, and snippets (`stdio`: `npx -y @mem-os/sdk mcp`
/// and `HTTP`: `http://localhost:7400/mcp`) without modifying any files on disk.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallPlan {
    pub harness_id: &'static str,
    pub target_config_path: PathBuf,
    pub backup_path: PathBuf,
    pub format: ConfigFormat,
    pub stdio_snippet: String,
    pub http_snippet: String,
    pub diff_preview: String,
    pub applied: bool,
    #[serde(default)]
    pub print_only: bool,
    pub notes: String,
}

/// Resolved spawn specification for launching a harness with `MEMOS_DB` and optional temporary MCP config.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchSpec {
    pub harness_id: &'static str,
    pub display_name: &'static str,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub temp_config_path: Option<PathBuf>,
    pub temp_config_contents: Option<String>,
    pub uses_temp_mcp_config: bool,
    pub working_dir: PathBuf,
}

/// Phase 2 trait defining the read-only adapter boundary for external AI harnesses.
///
/// Phase 3 seam: embedding a live harness terminal (PTY + terminal renderer)
/// will extend or wrap `HarnessAdapter::launch` with an in-app PTY session
/// trait (`PtySession`) rather than spawning an external terminal window.
pub trait HarnessAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    /// Perform read-only filesystem/PATH detection. Never writes or modifies configs.
    fn detect(&self) -> Detection;
    /// Parse existing MCP servers from the harness's config files (read-only).
    fn mcp_servers(&self) -> Vec<McpServerConfig>;
    /// Compute the diff + backup plan for adding MemOS (`memos mcp` / `http://localhost:7400/mcp`).
    /// Must NOT apply changes without explicit user approval and backup.
    fn plan_memos_install(&self) -> InstallPlan;
    /// Launch the harness in an external terminal in v1 (Phase 3 seam: embedded PTY).
    fn launch(&self) -> Result<()>;

    /// Build exact spawn specification for "Launch with MemOS" without mutating global config files.
    fn plan_launch_with_memos(&self, db_path: &Path, temp_dir: &Path) -> Result<LaunchSpec>;

    /// Spawn the harness externally with `MEMOS_DB` and any generated temporary MCP config.
    fn launch_with_memos(&self, db_path: &Path) -> Result<LaunchSpec> {
        let temp_dir = std::env::temp_dir().join("memos-desktop-harness");
        let spec = self.plan_launch_with_memos(db_path, &temp_dir)?;
        adapters::execute_launch_spec(&spec)?;
        Ok(spec)
    }

    /// Best config file or directory path to reveal in the OS file manager.
    fn reveal_target_path(&self) -> Option<PathBuf> {
        let plan = self.plan_memos_install();
        if plan.target_config_path.exists() {
            return Some(plan.target_config_path);
        }
        plan.target_config_path
            .parent()
            .filter(|p| p.exists())
            .map(Path::to_path_buf)
    }
}

/// Return all scaffolded Phase 2 adapters.
pub fn all_adapters() -> Vec<Box<dyn HarnessAdapter>> {
    adapters::default_adapters()
}

/// Run parallel, mtime-cached read-only detection across all scaffolded harnesses (`< 100 ms`).
pub fn detect_all() -> Vec<Detection> {
    adapters::detect_all_cached()
}
