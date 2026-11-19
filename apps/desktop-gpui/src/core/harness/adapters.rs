use std::collections::HashMap;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use anyhow::{Result, bail};
use directories::BaseDirs;

use super::{
    ConfigFormat, Detection, HarnessAdapter, InstallPlan, LaunchSpec, McpServerConfig, McpTransport,
};

pub const MEMOS_STDIO_COMMAND: &str = "npx";
pub const MEMOS_STDIO_ARGS: &[&str] = &["-y", "@mem-os/sdk", "mcp"];
pub const MEMOS_HTTP_URL: &str = "http://localhost:7400/mcp";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum McpConfigShape {
    McpServersMap,
    OpenCodeV2,
    OpenCodeV1,
    KiloV1,
    OpenClawServers,
    ContextServers,
    CodexToml,
    HermesYaml,
    DshPatchYaml,
    GooseYaml,
    ContinueYaml,
}

#[derive(Clone, Debug)]
struct AdapterSpec {
    id: &'static str,
    display_name: &'static str,
    binary_names: &'static [&'static str],
    primary_dir_rel: &'static str,
    extra_dirs_rel: &'static [&'static str],
    config_files_rel: &'static [&'static str],
    format: ConfigFormat,
    config_shape: McpConfigShape,
    print_only: bool,
    is_gui_editor: bool,
}

#[derive(Clone, Debug)]
struct CachedHarnessEntry {
    dir_mtimes: Vec<(PathBuf, Option<u128>)>,
    config_mtimes: Vec<(PathBuf, Option<u128>)>,
    binary_path: Option<PathBuf>,
    binary_mtime: Option<u128>,
    detection: Detection,
}

#[derive(Default)]
struct DiscoveryCache {
    home_dir: PathBuf,
    path_env: Option<OsString>,
    dsh_home: Option<OsString>,
    entries: HashMap<&'static str, CachedHarnessEntry>,
}

static DISCOVERY_CACHE: OnceLock<Mutex<DiscoveryCache>> = OnceLock::new();

fn mtime_nanos(path: &Path) -> Option<u128> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    modified
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_nanos())
}

#[derive(Clone, Debug)]
pub struct ScaffoldAdapter {
    spec: AdapterSpec,
    home_dir: PathBuf,
    path_override: Option<OsString>,
    pre_resolved_binary: Option<PathBuf>,
    use_system_dirs: bool,
}

impl ScaffoldAdapter {
    fn new(spec: AdapterSpec, home_dir: PathBuf, path_override: Option<OsString>) -> Self {
        Self {
            spec,
            home_dir,
            path_override,
            pre_resolved_binary: None,
            use_system_dirs: true,
        }
    }

    fn with_resolved_binary(mut self, bin: Option<PathBuf>) -> Self {
        self.pre_resolved_binary = bin;
        self
    }

    fn with_system_dirs(mut self, enabled: bool) -> Self {
        self.use_system_dirs = enabled;
        self
    }

    pub fn resolve_home() -> PathBuf {
        #[cfg(target_os = "windows")]
        if let Some(up) = env::var_os("USERPROFILE").filter(|v| !v.is_empty()) {
            return PathBuf::from(up);
        }
        if let Some(home) = env::var_os("HOME").filter(|v| !v.is_empty()) {
            return PathBuf::from(home);
        }
        BaseDirs::new()
            .map(|b| b.home_dir().to_path_buf())
            .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("."))
    }

    fn dsh_dir(&self) -> PathBuf {
        if self.use_system_dirs
            && let Some(dsh_home) = env::var_os("DSH_HOME").filter(|v| !v.is_empty())
        {
            return PathBuf::from(dsh_home);
        }
        self.home_dir.join(".dsh")
    }

    fn candidate_dirs(&self) -> Vec<PathBuf> {
        if self.spec.id == "dsh" {
            return vec![self.dsh_dir()];
        }
        let mut dirs = vec![self.home_dir.join(self.spec.primary_dir_rel)];
        for rel in self.spec.extra_dirs_rel {
            dirs.push(self.home_dir.join(rel));
        }
        if self.use_system_dirs {
            #[cfg(target_os = "windows")]
            {
                if self.spec.id == "zed"
                    && let Some(appdata) = env::var_os("APPDATA").filter(|v| !v.is_empty())
                {
                    dirs.push(PathBuf::from(appdata).join("Zed"));
                }
                if self.spec.id == "cline"
                    && let Some(appdata) = env::var_os("APPDATA").filter(|v| !v.is_empty())
                {
                    dirs.push(
                        PathBuf::from(appdata)
                            .join("Code/User/globalStorage/saoudrizwan.claude-dev/settings"),
                    );
                }
            }
            #[cfg(target_os = "macos")]
            {
                if self.spec.id == "zed" {
                    dirs.push(PathBuf::from("/Applications/Zed.app"));
                }
                if self.spec.id == "cursor" {
                    dirs.push(PathBuf::from("/Applications/Cursor.app"));
                }
                if self.spec.id == "cline" {
                    dirs.push(self.home_dir.join(
                        "Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings",
                    ));
                }
            }
            #[cfg(target_os = "linux")]
            if self.spec.id == "cline" {
                dirs.push(
                    self.home_dir
                        .join(".config/Code/User/globalStorage/saoudrizwan.claude-dev/settings"),
                );
            }
        }
        dirs
    }

    fn candidate_configs(&self) -> Vec<PathBuf> {
        if self.spec.id == "dsh" {
            let dir = self.dsh_dir();
            return vec![dir.join("memos.patch.yml"), dir.join("cordis.patch.yml")];
        }
        let mut out: Vec<PathBuf> = self
            .spec
            .config_files_rel
            .iter()
            .map(|rel| self.home_dir.join(rel))
            .collect();
        if self.use_system_dirs {
            #[cfg(target_os = "windows")]
            {
                if self.spec.id == "zed"
                    && let Some(appdata) = env::var_os("APPDATA").filter(|v| !v.is_empty())
                {
                    out.push(PathBuf::from(appdata).join("Zed").join("settings.json"));
                }
                if self.spec.id == "cline"
                    && let Some(appdata) = env::var_os("APPDATA").filter(|v| !v.is_empty())
                {
                    out.push(
                        PathBuf::from(appdata)
                            .join("Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json"),
                    );
                }
            }
            #[cfg(target_os = "macos")]
            {
                if self.spec.id == "zed" {
                    out.push(
                        self.home_dir
                            .join("Library/Application Support/Zed/settings.json"),
                    );
                }
                if self.spec.id == "cline" {
                    out.push(self.home_dir.join(
                        "Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
                    ));
                }
            }
        }
        out
    }

    fn fixed_binary_candidates(&self) -> Vec<PathBuf> {
        let mut candidates = Vec::new();
        let home_bins = [
            self.home_dir.join(".local/bin"),
            self.home_dir.join(".claude/local"),
            self.home_dir.join(".cargo/bin"),
        ];
        for dir in home_bins {
            for bin in self.spec.binary_names {
                candidates.push(dir.join(bin));
                #[cfg(target_os = "windows")]
                for ext in [".exe", ".cmd", ".bat"] {
                    candidates.push(dir.join(format!("{bin}{ext}")));
                }
            }
        }
        if self.use_system_dirs {
            #[cfg(target_os = "windows")]
            {
                if let Some(appdata) = env::var_os("APPDATA").filter(|v| !v.is_empty()) {
                    let npm_dir = PathBuf::from(appdata).join("npm");
                    for bin in self.spec.binary_names {
                        candidates.push(npm_dir.join(format!("{bin}.cmd")));
                        candidates.push(npm_dir.join(format!("{bin}.exe")));
                    }
                }
                if let Some(local) = env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty()) {
                    let local_p = PathBuf::from(local);
                    match self.spec.id {
                        "cursor" => {
                            candidates.push(local_p.join("Programs/cursor/Cursor.exe"));
                            candidates
                                .push(local_p.join("Programs/cursor/resources/app/bin/cursor.cmd"));
                        }
                        "windsurf" => {
                            candidates.push(local_p.join("Programs/windsurf/Windsurf.exe"));
                            candidates.push(
                                local_p.join("Programs/windsurf/resources/app/bin/windsurf.cmd"),
                            );
                        }
                        "zed" => {
                            candidates.push(local_p.join("Programs/Zed/Zed.exe"));
                            candidates.push(local_p.join("Zed/zed.exe"));
                        }
                        _ => {}
                    }
                }
            }
        }
        candidates
    }

    fn find_binary(&self) -> Option<PathBuf> {
        if let Some(ref b) = self.pre_resolved_binary {
            return Some(b.clone());
        }
        let path_var = self.path_override.clone().or_else(|| env::var_os("PATH"));
        if let Some(path_var) = path_var {
            for dir in env::split_paths(&path_var) {
                if let Some(found) = check_binary_in_dir(&dir, self.spec.binary_names) {
                    return Some(found);
                }
            }
        }
        self.fixed_binary_candidates()
            .into_iter()
            .find(|p| p.is_file())
    }

    fn resolve_version(&self, binary_path: &Path) -> String {
        if matches!(self.spec.id, "opencode" | "opencode-v1")
            && let Some((_, ver)) = probe_opencode_version(binary_path)
        {
            return format!(
                "{ver} ({})",
                binary_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
            );
        }
        if let Some(ver) = extract_package_version_near_binary(binary_path, self.spec.id) {
            return format!(
                "{ver} ({})",
                binary_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
            );
        }
        format!(
            "installed ({})",
            binary_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
        )
    }

    fn detect_uncached(&self) -> Detection {
        let existing_configs: Vec<PathBuf> = self
            .candidate_configs()
            .into_iter()
            .filter(|p| p.is_file())
            .collect();
        let dir_exists = self.candidate_dirs().iter().any(|d| d.exists());
        let binary_path = self.find_binary();

        let (installed, version, memos_configured) = if self.spec.id == "dsh" {
            // `dsh_dir()` honors DSH_HOME and falls back to ~/.dsh, so the
            // detection works even when the harness was installed without
            // exporting DSH_HOME into the desktop app's environment.
            let dsh_home_exists = self.use_system_dirs && self.dsh_dir().exists();
            let inst = binary_path.is_some() || dsh_home_exists;
            let servers = self.mcp_servers_from_paths(&existing_configs);
            let conf = servers.iter().any(|s| s.name.eq_ignore_ascii_case("memos"));
            let ver = binary_path.as_ref().map(|p| self.resolve_version(p));
            (inst, ver, conf)
        } else if matches!(self.spec.id, "opencode" | "opencode-v1") {
            let probed = binary_path.as_deref().and_then(probe_opencode_version);
            let base_present = dir_exists || !existing_configs.is_empty() || binary_path.is_some();
            let inst = if let Some((major, _)) = &probed {
                if self.spec.id == "opencode" {
                    *major >= 2
                } else {
                    *major == 1
                }
            } else if binary_path.is_none() && base_present {
                let has_v2_cfg = !self
                    .mcp_servers_from_paths_with_shape(
                        &existing_configs,
                        McpConfigShape::OpenCodeV2,
                    )
                    .is_empty();
                let has_v1_cfg = !self
                    .mcp_servers_from_paths_with_shape(
                        &existing_configs,
                        McpConfigShape::OpenCodeV1,
                    )
                    .is_empty();
                match (self.spec.id, has_v2_cfg, has_v1_cfg) {
                    ("opencode", true, _) => true,
                    ("opencode", false, true) => false,
                    ("opencode", false, false) => true,
                    ("opencode-v1", _, true) => true,
                    ("opencode-v1", _, false) => false,
                    _ => false,
                }
            } else {
                base_present
            };
            let servers = self.mcp_servers_from_paths(&existing_configs);
            let conf = inst && servers.iter().any(|s| s.name.eq_ignore_ascii_case("memos"));
            let ver = if inst {
                binary_path.as_ref().map(|p| self.resolve_version(p))
            } else {
                None
            };
            (inst, ver, conf)
        } else {
            let inst = dir_exists || !existing_configs.is_empty() || binary_path.is_some();
            let servers = self.mcp_servers_from_paths(&existing_configs);
            let conf = servers.iter().any(|s| s.name.eq_ignore_ascii_case("memos"));
            let ver = binary_path.as_ref().map(|p| self.resolve_version(p));
            (inst, ver, conf)
        };

        Detection {
            id: self.spec.id,
            display_name: self.spec.display_name,
            installed,
            version,
            config_paths: existing_configs,
            memos_configured,
            print_only: self.spec.print_only,
        }
    }

    fn mcp_servers_from_paths(&self, paths: &[PathBuf]) -> Vec<McpServerConfig> {
        self.mcp_servers_from_paths_with_shape(paths, self.spec.config_shape)
    }

    fn mcp_servers_from_paths_with_shape(
        &self,
        paths: &[PathBuf],
        shape: McpConfigShape,
    ) -> Vec<McpServerConfig> {
        let mut servers = Vec::new();
        for path in paths {
            if !path.is_file() {
                continue;
            }
            let Ok(raw) = fs::read_to_string(path) else {
                continue;
            };
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if ext == "json" {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
                    collect_json_mcp_servers_for_shape(&json, path, Some(shape), &mut servers);
                }
            } else if ext == "toml" {
                collect_toml_mcp_servers(&raw, path, &mut servers);
            } else if ext == "yaml" || ext == "yml" {
                collect_yaml_mcp_servers(&raw, path, shape, &mut servers);
            }
        }
        servers
    }

    fn stdio_snippet(&self) -> String {
        match self.spec.config_shape {
            McpConfigShape::McpServersMap => serde_json::to_string_pretty(&serde_json::json!({
                "mcpServers": {
                    "memos": {
                        "command": MEMOS_STDIO_COMMAND,
                        "args": MEMOS_STDIO_ARGS
                    }
                }
            }))
            .unwrap_or_default(),
            McpConfigShape::OpenCodeV2 => serde_json::to_string_pretty(&serde_json::json!({
                "mcp": {
                    "servers": {
                        "memos": {
                            "type": "local",
                            "command": ["npx", "-y", "@mem-os/sdk", "mcp"],
                            "enabled": true
                        }
                    }
                }
            }))
            .unwrap_or_default(),
            McpConfigShape::OpenCodeV1 | McpConfigShape::KiloV1 => {
                serde_json::to_string_pretty(&serde_json::json!({
                    "mcp": {
                        "memos": {
                            "type": "local",
                            "command": ["npx", "-y", "@mem-os/sdk", "mcp"],
                            "enabled": true
                        }
                    }
                }))
                .unwrap_or_default()
            }
            McpConfigShape::OpenClawServers => serde_json::to_string_pretty(&serde_json::json!({
                "mcp": {
                    "servers": {
                        "memos": {
                            "command": MEMOS_STDIO_COMMAND,
                            "args": MEMOS_STDIO_ARGS,
                            "enabled": true
                        }
                    }
                }
            }))
            .unwrap_or_default(),
            McpConfigShape::ContextServers => serde_json::to_string_pretty(&serde_json::json!({
                "context_servers": {
                    "memos": {
                        "source": "custom",
                        "command": MEMOS_STDIO_COMMAND,
                        "args": MEMOS_STDIO_ARGS
                    }
                }
            }))
            .unwrap_or_default(),
            McpConfigShape::CodexToml => {
                "[mcp_servers.memos]\ncommand = \"npx\"\nargs = [\"-y\", \"@mem-os/sdk\", \"mcp\"]\n"
                    .to_string()
            }
            McpConfigShape::HermesYaml => concat!(
                "mcp_servers:\n",
                "  memos:\n",
                "    command: \"npx\"\n",
                "    args: [\"-y\", \"@mem-os/sdk\", \"mcp\"]\n",
                "    protocol: auto\n",
                "    trust: full\n",
            )
            .to_string(),
            McpConfigShape::DshPatchYaml => concat!(
                "- insert:\n",
                "    - id: memos\n",
                "      name: '@deepseek-ai/dsh-mcp-client'\n",
                "      config:\n",
                "        serverName: memos\n",
                "        transport: stdio\n",
                "        command: \"npx\"\n",
                "        args: [\"-y\", \"@mem-os/sdk\", \"mcp\"]\n",
            )
            .to_string(),
            McpConfigShape::GooseYaml => concat!(
                "extensions:\n",
                "  memos:\n",
                "    type: stdio\n",
                "    cmd: \"npx\"\n",
                "    args: [\"-y\", \"@mem-os/sdk\", \"mcp\"]\n",
                "    enabled: true\n",
                "    timeout: 300\n",
            )
            .to_string(),
            McpConfigShape::ContinueYaml => concat!(
                "mcpServers:\n",
                "  - name: memos\n",
                "    command: npx\n",
                "    args:\n",
                "      - -y\n",
                "      - \"@mem-os/sdk\"\n",
                "      - mcp\n",
            )
            .to_string(),
        }
    }

    fn http_snippet(&self) -> String {
        match self.spec.config_shape {
            McpConfigShape::CodexToml => {
                format!("[mcp_servers.memos]\nurl = \"{MEMOS_HTTP_URL}\"\n")
            }
            McpConfigShape::OpenCodeV2 => serde_json::to_string_pretty(&serde_json::json!({
                "mcp": {
                    "servers": {
                        "memos": {
                            "type": "remote",
                            "url": MEMOS_HTTP_URL,
                            "enabled": true
                        }
                    }
                }
            }))
            .unwrap_or_default(),
            McpConfigShape::OpenCodeV1 | McpConfigShape::KiloV1 => {
                serde_json::to_string_pretty(&serde_json::json!({
                    "mcp": {
                        "memos": {
                            "type": "remote",
                            "url": MEMOS_HTTP_URL
                        }
                    }
                }))
                .unwrap_or_default()
            }
            McpConfigShape::OpenClawServers => serde_json::to_string_pretty(&serde_json::json!({
                "mcp": {
                    "servers": {
                        "memos": {
                            "url": MEMOS_HTTP_URL,
                            "enabled": true
                        }
                    }
                }
            }))
            .unwrap_or_default(),
            McpConfigShape::ContextServers => serde_json::to_string_pretty(&serde_json::json!({
                "context_servers": {
                    "memos": {
                        "source": "custom",
                        "url": MEMOS_HTTP_URL
                    }
                }
            }))
            .unwrap_or_default(),
            McpConfigShape::ContinueYaml => format!(
                "mcpServers:\n  - name: memos\n    type: streamable-http\n    url: {MEMOS_HTTP_URL}\n"
            ),
            McpConfigShape::HermesYaml => format!(
                "mcp_servers:\n  memos:\n    url: \"{MEMOS_HTTP_URL}\"\n    protocol: auto\n"
            ),
            McpConfigShape::DshPatchYaml => format!(
                "- insert:\n    - id: memos\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: memos\n        transport: http\n        url: \"{MEMOS_HTTP_URL}\"\n"
            ),
            McpConfigShape::GooseYaml => format!(
                "extensions:\n  memos:\n    type: streamable_http\n    uri: \"{MEMOS_HTTP_URL}\"\n    enabled: true\n"
            ),
            McpConfigShape::McpServersMap => serde_json::to_string_pretty(&serde_json::json!({
                "mcpServers": {
                    "memos": {
                        "url": MEMOS_HTTP_URL
                    }
                }
            }))
            .unwrap_or_default(),
        }
    }
}

impl HarnessAdapter for ScaffoldAdapter {
    fn id(&self) -> &'static str {
        self.spec.id
    }

    fn display_name(&self) -> &'static str {
        self.spec.display_name
    }

    fn detect(&self) -> Detection {
        self.detect_uncached()
    }

    fn mcp_servers(&self) -> Vec<McpServerConfig> {
        self.mcp_servers_from_paths(&self.candidate_configs())
    }

    fn plan_memos_install(&self) -> InstallPlan {
        let target_config_path = if self.spec.id == "dsh" {
            // Never suggest overwriting user's cordis.patch.yml; target dedicated memos.patch.yml.
            self.dsh_dir().join("memos.patch.yml")
        } else {
            self.candidate_configs()
                .into_iter()
                .find(|p| p.exists())
                .unwrap_or_else(|| {
                    self.candidate_configs()
                        .into_iter()
                        .next()
                        .unwrap_or_else(|| self.home_dir.join(self.spec.primary_dir_rel))
                })
        };

        let backup_path = PathBuf::from(format!("{}.bak", target_config_path.display()));
        let stdio_snippet = self.stdio_snippet();
        let http_snippet = self.http_snippet();
        let diff_preview = format!(
            "--- {}\n+++ {} (planned, NOT applied; backup -> {})\n{}",
            target_config_path.display(),
            target_config_path.display(),
            backup_path.display(),
            stdio_snippet
                .lines()
                .map(|l| format!("+ {l}"))
                .collect::<Vec<_>>()
                .join("\n")
        );

        let notes = if self.spec.id == "dsh" {
            "Print-only: writes/uses dedicated memos.patch.yml and never modifies cordis.patch.yml. Test via `dsh web --patch` or merge the row manually.".to_string()
        } else if self.spec.print_only {
            "Print-only: merges into larger editor/agent settings; paste this block manually rather than overwriting the file.".to_string()
        } else if self.spec.id == "opencode" {
            "OpenCode 2.x uses nested `mcp.servers.memos` (`memos connect opencode`). Project path: ./opencode.json.".to_string()
        } else if self.spec.id == "opencode-v1" {
            "Legacy OpenCode 1.x uses `mcp.memos` without a `servers` wrapper (`memos connect opencode-v1`).".to_string()
        } else if self.spec.id == "kilo" {
            "Kilo uses `mcp.memos` with array `command` and `environment` (`./kilo.json` or `~/.config/kilo/kilo.json`).".to_string()
        } else {
            "Read-only preview: copy snippet or launch an isolated session with MEMOS_DB_PATH."
                .to_string()
        };

        InstallPlan {
            harness_id: self.spec.id,
            target_config_path,
            backup_path,
            format: self.spec.format,
            stdio_snippet,
            http_snippet,
            diff_preview,
            applied: false,
            print_only: self.spec.print_only,
            notes,
        }
    }

    fn launch(&self) -> Result<()> {
        // Phase 3 seam: embedding a live harness terminal (PTY + terminal renderer)
        // belongs here. In v1, we open the harness externally in an OS terminal.
        let Some(binary) = self.find_binary() else {
            bail!(
                "{} CLI executable was not found on PATH (Phase 3 embedded PTY not enabled in v1)",
                self.spec.display_name
            );
        };
        let working_dir = self.home_dir.clone();
        spawn_in_terminal_or_gui(&binary, &[], &[], &working_dir, self.spec.is_gui_editor)
    }

    fn plan_launch_with_memos(&self, db_path: &Path, temp_dir: &Path) -> Result<LaunchSpec> {
        let Some(program) = self.find_binary() else {
            bail!(
                "{} executable was not found on PATH or standard install locations",
                self.spec.display_name
            );
        };
        let db_str = db_path.display().to_string();
        let mut env_vars = vec![
            ("MEMOS_DB".to_string(), db_str.clone()),
            ("MEMOS_DB_PATH".to_string(), db_str.clone()),
        ];
        let mut args = Vec::new();
        let mut temp_config_path = None;
        let mut temp_config_contents = None;
        let mut uses_temp_mcp_config = false;

        match self.spec.id {
            "claude-code" => {
                let cfg_path = temp_dir.join("claude-memos-mcp.json");
                let json = serde_json::to_string_pretty(&serde_json::json!({
                    "mcpServers": {
                        "memos": {
                            "command": MEMOS_STDIO_COMMAND,
                            "args": MEMOS_STDIO_ARGS,
                            "env": {
                                "MEMOS_DB": db_str,
                                "MEMOS_DB_PATH": db_str
                            }
                        }
                    }
                }))?;
                args.push("--mcp-config".to_string());
                args.push(cfg_path.display().to_string());
                temp_config_path = Some(cfg_path);
                temp_config_contents = Some(json);
                uses_temp_mcp_config = true;
            }
            "codex" => {
                args.push("-c".to_string());
                args.push("mcp_servers.memos.command=\"npx\"".to_string());
                args.push("-c".to_string());
                args.push("mcp_servers.memos.args=[\"-y\",\"@mem-os/sdk\",\"mcp\"]".to_string());
                uses_temp_mcp_config = true;
            }
            "opencode" => {
                let cfg_path = temp_dir.join("opencode-memos.json");
                let json = serde_json::to_string_pretty(&serde_json::json!({
                    "mcp": {
                        "servers": {
                            "memos": {
                                "type": "local",
                                "command": ["npx", "-y", "@mem-os/sdk", "mcp"],
                                "environment": {
                                    "MEMOS_DB": db_str,
                                    "MEMOS_DB_PATH": db_str
                                },
                                "enabled": true
                            }
                        }
                    }
                }))?;
                env_vars.push((
                    "OPENCODE_CONFIG".to_string(),
                    cfg_path.display().to_string(),
                ));
                temp_config_path = Some(cfg_path);
                temp_config_contents = Some(json);
                uses_temp_mcp_config = true;
            }
            "opencode-v1" => {
                let cfg_path = temp_dir.join("opencode-v1-memos.json");
                let json = serde_json::to_string_pretty(&serde_json::json!({
                    "mcp": {
                        "memos": {
                            "type": "local",
                            "command": ["npx", "-y", "@mem-os/sdk", "mcp"],
                            "environment": {
                                "MEMOS_DB": db_str,
                                "MEMOS_DB_PATH": db_str
                            },
                            "enabled": true
                        }
                    }
                }))?;
                env_vars.push((
                    "OPENCODE_CONFIG".to_string(),
                    cfg_path.display().to_string(),
                ));
                temp_config_path = Some(cfg_path);
                temp_config_contents = Some(json);
                uses_temp_mcp_config = true;
            }
            _ => {
                // Global/user config is never modified automatically; MEMOS_DB / MEMOS_DB_PATH configure MemOS.
            }
        }

        Ok(LaunchSpec {
            harness_id: self.spec.id,
            display_name: self.spec.display_name,
            program,
            args,
            env: env_vars,
            temp_config_path,
            temp_config_contents,
            uses_temp_mcp_config,
            working_dir: self.home_dir.clone(),
        })
    }
}

pub fn execute_launch_spec(spec: &LaunchSpec) -> Result<()> {
    if let (Some(cfg_path), Some(contents)) = (&spec.temp_config_path, &spec.temp_config_contents) {
        if let Some(parent) = cfg_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(cfg_path, contents)?;
    }
    let is_gui = matches!(spec.harness_id, "cursor" | "zed");
    spawn_in_terminal_or_gui(
        &spec.program,
        &spec.args,
        &spec.env,
        &spec.working_dir,
        is_gui,
    )
}

fn spawn_in_terminal_or_gui(
    program: &Path,
    args: &[String],
    env_vars: &[(String, String)],
    working_dir: &Path,
    is_gui: bool,
) -> Result<()> {
    let mut cmd = if is_gui {
        let mut c = Command::new(program);
        c.args(args);
        c
    } else {
        #[cfg(target_os = "windows")]
        {
            let mut inner = quote_cmd_arg(&program.display().to_string());
            for a in args {
                inner.push(' ');
                inner.push_str(&quote_cmd_arg(a));
            }
            let mut c = Command::new("cmd.exe");
            c.args(["/C", "start", "MemOS Harness", "cmd.exe", "/K", &inner]);
            c
        }
        #[cfg(not(target_os = "windows"))]
        {
            let mut c = Command::new(program);
            c.args(args);
            c
        }
    };

    if working_dir.is_dir() {
        cmd.current_dir(working_dir);
    }
    for (k, v) in env_vars {
        cmd.env(k, v);
    }
    cmd.spawn()?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn quote_cmd_arg(arg: &str) -> String {
    if arg.contains(' ') || arg.contains('"') {
        format!("\"{}\"", arg.replace('"', "\\\""))
    } else {
        arg.to_string()
    }
}

fn check_binary_in_dir(dir: &Path, names: &[&str]) -> Option<PathBuf> {
    for bin in names {
        let candidate = dir.join(bin);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(target_os = "windows")]
        for ext in [".exe", ".cmd", ".bat"] {
            let with_ext = dir.join(format!("{bin}{ext}"));
            if with_ext.is_file() {
                return Some(with_ext);
            }
        }
    }
    None
}

fn find_binary_in_entries(
    dir: &Path,
    entries: &HashMap<String, std::ffi::OsString>,
    names: &[&str],
) -> Option<PathBuf> {
    for bin in names {
        let lower = bin.to_ascii_lowercase();
        let keys: Vec<String> = {
            #[cfg(target_os = "windows")]
            {
                vec![
                    lower.clone(),
                    format!("{lower}.exe"),
                    format!("{lower}.cmd"),
                    format!("{lower}.bat"),
                ]
            }
            #[cfg(not(target_os = "windows"))]
            {
                vec![lower]
            }
        };
        for key in keys {
            if let Some(actual_name) = entries.get(&key) {
                #[cfg(not(target_os = "windows"))]
                if actual_name != std::ffi::OsStr::new(bin) {
                    continue;
                }
                let candidate = dir.join(actual_name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

fn scan_path_binaries(
    specs: &[AdapterSpec],
    home_dir: &Path,
    path_env: Option<&OsString>,
) -> HashMap<&'static str, PathBuf> {
    let mut found: HashMap<&'static str, PathBuf> = HashMap::new();
    if let Some(path_var) = path_env {
        for dir in env::split_paths(path_var) {
            if found.len() == specs.len() {
                break;
            }
            let Ok(read_dir) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut entries: HashMap<String, std::ffi::OsString> = HashMap::new();
            for entry in read_dir.flatten() {
                let name = entry.file_name();
                entries.insert(name.to_string_lossy().to_ascii_lowercase(), name);
            }
            if entries.is_empty() {
                continue;
            }
            for spec in specs {
                if found.contains_key(spec.id) {
                    continue;
                }
                if let Some(bin) = find_binary_in_entries(&dir, &entries, spec.binary_names) {
                    found.insert(spec.id, bin);
                }
            }
        }
    }
    for spec in specs {
        if !found.contains_key(spec.id) {
            let adapter =
                ScaffoldAdapter::new(spec.clone(), home_dir.to_path_buf(), path_env.cloned());
            if let Some(bin) = adapter
                .fixed_binary_candidates()
                .into_iter()
                .find(|p| p.is_file())
            {
                found.insert(spec.id, bin);
            }
        }
    }
    found
}

type OpenCodeVersionCache = HashMap<PathBuf, (Option<u128>, Option<(u32, String)>)>;
static OPENCODE_VERSION_CACHE: OnceLock<Mutex<OpenCodeVersionCache>> = OnceLock::new();

fn parse_semver_major_and_display(raw: &str) -> Option<(u32, String)> {
    for tok in raw.split_whitespace() {
        let trimmed = tok.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.');
        let ver_body = trimmed.strip_prefix(['v', 'V']).unwrap_or(trimmed);
        let mut parts = ver_body.split('.');
        if let (Some(maj_s), Some(min_s)) = (parts.next(), parts.next())
            && !maj_s.is_empty()
            && maj_s.bytes().all(|b| b.is_ascii_digit())
            && min_s.bytes().take_while(|b| b.is_ascii_digit()).count() > 0
            && let Ok(major) = maj_s.parse::<u32>()
        {
            return Some((major, trimmed.to_string()));
        }
    }
    None
}

fn probe_opencode_version(binary_path: &Path) -> Option<(u32, String)> {
    let mtime = mtime_nanos(binary_path);
    let cache = OPENCODE_VERSION_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = cache.lock()
        && let Some((cached_mt, cached_ver)) = guard.get(binary_path)
        && *cached_mt == mtime
    {
        return cached_ver.clone();
    }

    let mut probed = extract_package_version_near_binary(binary_path, "opencode")
        .and_then(|v| parse_semver_major_and_display(&v));
    if probed.is_none() {
        let mut cmd = Command::new(binary_path);
        cmd.arg("--version");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        if let Ok(output) = cmd.output() {
            let combined = format!(
                "{} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            probed = parse_semver_major_and_display(&combined);
        }
    }

    if let Ok(mut guard) = cache.lock() {
        guard.insert(binary_path.to_path_buf(), (mtime, probed.clone()));
    }
    probed
}

fn extract_package_version_near_binary(binary_path: &Path, id: &str) -> Option<String> {
    let parent = binary_path.parent()?;
    let pkg_names: &[&str] = match id {
        "claude-code" => &["@anthropic-ai/claude-code"],
        "codex" => &["@openai/codex"],
        "gemini-cli" => &["@google/gemini-cli"],
        "opencode" => &["opencode-ai", "opencode"],
        "continue" => &["@continuedev/cli", "continue"],
        _ => &[],
    };
    for pkg in pkg_names {
        let candidates = [
            parent.join("node_modules").join(pkg).join("package.json"),
            parent
                .parent()
                .map(|p| p.join("lib/node_modules").join(pkg).join("package.json"))
                .unwrap_or_default(),
            parent
                .join("..")
                .join("node_modules")
                .join(pkg)
                .join("package.json"),
        ];
        for cand in candidates {
            if cand.is_file()
                && let Ok(raw) = fs::read_to_string(&cand)
                && let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw)
                && let Some(ver) = val.get("version").and_then(|v| v.as_str())
            {
                return Some(ver.to_string());
            }
        }
    }
    None
}

fn push_json_server_entries(
    obj: &serde_json::Map<String, serde_json::Value>,
    source_path: &Path,
    skip_servers_key: bool,
    out: &mut Vec<McpServerConfig>,
) {
    for (name, val) in obj {
        if skip_servers_key && name == "servers" {
            continue;
        }
        let enabled = val.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
        if let Some(url) = val.get("url").and_then(|v| v.as_str()) {
            out.push(McpServerConfig {
                name: name.clone(),
                transport: McpTransport::Http {
                    url: url.to_string(),
                },
                source_path: source_path.to_path_buf(),
                enabled,
            });
        } else if let Some(cmd_arr) = val.get("command").and_then(|v| v.as_array()) {
            let mut parts = cmd_arr
                .iter()
                .filter_map(|x| x.as_str().map(ToOwned::to_owned));
            if let Some(command) = parts.next() {
                out.push(McpServerConfig {
                    name: name.clone(),
                    transport: McpTransport::Stdio {
                        command,
                        args: parts.collect(),
                    },
                    source_path: source_path.to_path_buf(),
                    enabled,
                });
            }
        } else if let Some(command) = val.get("command").and_then(|v| v.as_str()) {
            let args = val
                .get("args")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(ToOwned::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            out.push(McpServerConfig {
                name: name.clone(),
                transport: McpTransport::Stdio {
                    command: command.to_string(),
                    args,
                },
                source_path: source_path.to_path_buf(),
                enabled,
            });
        }
    }
}

fn collect_json_mcp_servers_for_shape(
    root: &serde_json::Value,
    source_path: &Path,
    shape: Option<McpConfigShape>,
    out: &mut Vec<McpServerConfig>,
) {
    match shape {
        Some(McpConfigShape::OpenCodeV2) | Some(McpConfigShape::OpenClawServers) => {
            if let Some(servers_obj) = root
                .get("mcp")
                .and_then(|m| m.get("servers"))
                .and_then(|v| v.as_object())
            {
                push_json_server_entries(servers_obj, source_path, false, out);
            }
        }
        Some(McpConfigShape::OpenCodeV1) | Some(McpConfigShape::KiloV1) => {
            if let Some(mcp_obj) = root.get("mcp").and_then(|v| v.as_object()) {
                push_json_server_entries(mcp_obj, source_path, true, out);
            }
        }
        Some(McpConfigShape::ContextServers) => {
            if let Some(obj) = root.get("context_servers").and_then(|v| v.as_object()) {
                push_json_server_entries(obj, source_path, false, out);
            }
        }
        Some(McpConfigShape::McpServersMap) | Some(McpConfigShape::ContinueYaml) => {
            if let Some(obj) = root.get("mcpServers").and_then(|v| v.as_object()) {
                push_json_server_entries(obj, source_path, false, out);
            }
        }
        _ => {
            for key in ["mcpServers", "context_servers"] {
                if let Some(obj) = root.get(key).and_then(|v| v.as_object()) {
                    push_json_server_entries(obj, source_path, false, out);
                }
            }
            if let Some(mcp_obj) = root.get("mcp").and_then(|v| v.as_object()) {
                if let Some(servers_obj) = mcp_obj.get("servers").and_then(|v| v.as_object()) {
                    push_json_server_entries(servers_obj, source_path, false, out);
                }
                push_json_server_entries(mcp_obj, source_path, true, out);
            }
        }
    }
}

fn collect_yaml_mcp_servers(
    raw: &str,
    source_path: &Path,
    shape: McpConfigShape,
    out: &mut Vec<McpServerConfig>,
) {
    let matched = match shape {
        McpConfigShape::DshPatchYaml => {
            raw.contains("@deepseek-ai/dsh-mcp-client")
                || raw.contains("serverName: memos")
                || raw.contains("id: memos")
        }
        McpConfigShape::HermesYaml => raw.contains("mcp_servers:") && raw.contains("memos:"),
        McpConfigShape::GooseYaml => raw.contains("extensions:") && raw.contains("memos:"),
        McpConfigShape::ContinueYaml => raw.contains("memos"),
        _ => raw.contains("memos"),
    };
    if matched {
        out.push(McpServerConfig {
            name: "memos".to_string(),
            transport: McpTransport::Stdio {
                command: MEMOS_STDIO_COMMAND.to_string(),
                args: MEMOS_STDIO_ARGS.iter().map(|s| (*s).to_string()).collect(),
            },
            source_path: source_path.to_path_buf(),
            enabled: true,
        });
    }
}

fn collect_toml_mcp_servers(raw: &str, source_path: &Path, out: &mut Vec<McpServerConfig>) {
    for line in raw.lines() {
        let trimmed = line.trim();
        if let Some(name) = trimmed
            .strip_prefix("[mcp_servers.")
            .and_then(|s| s.strip_suffix(']'))
        {
            out.push(McpServerConfig {
                name: name.trim().to_string(),
                transport: McpTransport::Stdio {
                    command: MEMOS_STDIO_COMMAND.to_string(),
                    args: MEMOS_STDIO_ARGS.iter().map(|s| (*s).to_string()).collect(),
                },
                source_path: source_path.to_path_buf(),
                enabled: true,
            });
        }
    }
}

fn all_specs() -> [AdapterSpec; 16] {
    [
        AdapterSpec {
            id: "claude-code",
            display_name: "Claude Code",
            binary_names: &["claude"],
            primary_dir_rel: ".claude",
            extra_dirs_rel: &[],
            config_files_rel: &[".mcp.json", ".claude.json", ".claude/settings.json"],
            format: ConfigFormat::Json,
            config_shape: McpConfigShape::McpServersMap,
            print_only: false,
            is_gui_editor: false,
        },
        AdapterSpec {
            id: "codex",
            display_name: "Codex",
            binary_names: &["codex"],
            primary_dir_rel: ".codex",
            extra_dirs_rel: &[],
            config_files_rel: &[".codex/config.toml"],
            format: ConfigFormat::Toml,
            config_shape: McpConfigShape::CodexToml,
            print_only: false,
            is_gui_editor: false,
        },
        AdapterSpec {
            id: "cursor",
            display_name: "Cursor",
            binary_names: &["cursor"],
            primary_dir_rel: ".cursor",
            extra_dirs_rel: &[],
            config_files_rel: &[".cursor/mcp.json"],
            format: ConfigFormat::Json,
            config_shape: McpConfigShape::McpServersMap,
            print_only: false,
            is_gui_editor: true,
        },
        AdapterSpec {
            id: "windsurf",
            display_name: "Windsurf",
            binary_names: &["windsurf"],
            primary_dir_rel: ".codeium/windsurf",
            extra_dirs_rel: &[".codeium"],
            config_files_rel: &[".codeium/windsurf/mcp_config.json"],
            format: ConfigFormat::Json,
            config_shape: McpConfigShape::McpServersMap,
            print_only: false,
            is_gui_editor: true,
        },
        AdapterSpec {
            id: "cline",
            display_name: "Cline",
            binary_names: &["cline"],
            primary_dir_rel: ".cline",
            extra_dirs_rel: &[".config/Code/User/globalStorage/saoudrizwan.claude-dev/settings"],
            config_files_rel: &[
                ".config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
                ".cline/cline_mcp_settings.json",
            ],
            format: ConfigFormat::Json,
            config_shape: McpConfigShape::McpServersMap,
            print_only: true,
            is_gui_editor: true,
        },
        AdapterSpec {
            id: "opencode",
            display_name: "OpenCode",
            binary_names: &["opencode"],
            primary_dir_rel: ".config/opencode",
            extra_dirs_rel: &[".local/share/opencode"],
            config_files_rel: &[
                ".config/opencode/opencode.json",
                ".config/opencode/config.json",
            ],
            format: ConfigFormat::Json,
            config_shape: McpConfigShape::OpenCodeV2,
            print_only: false,
            is_gui_editor: false,
        },
        AdapterSpec {
            id: "opencode-v1",
            display_name: "OpenCode 1.x",
            binary_names: &["opencode"],
            primary_dir_rel: ".config/opencode",
            extra_dirs_rel: &[".local/share/opencode"],
            config_files_rel: &[
                ".config/opencode/opencode.json",
                ".config/opencode/config.json",
            ],
            format: ConfigFormat::Json,
            config_shape: McpConfigShape::OpenCodeV1,
            print_only: false,
            is_gui_editor: false,
        },
        AdapterSpec {
            id: "gemini-cli",
            display_name: "Gemini CLI",
            binary_names: &["gemini"],
            primary_dir_rel: ".gemini",
            extra_dirs_rel: &[],
            config_files_rel: &[".gemini/settings.json"],
            format: ConfigFormat::Json,
            config_shape: McpConfigShape::McpServersMap,
            print_only: false,
            is_gui_editor: false,
        },
        AdapterSpec {
            id: "hermes",
            display_name: "Hermes",
            binary_names: &["hermes"],
            primary_dir_rel: ".hermes",
            extra_dirs_rel: &[],
            config_files_rel: &[".hermes/config.yaml", ".hermes/config.yml"],
            format: ConfigFormat::Yaml,
            config_shape: McpConfigShape::HermesYaml,
            print_only: true,
            is_gui_editor: false,
        },
        AdapterSpec {
            id: "dsh",
            display_name: "DeepSeek Harness (dsh)",
            binary_names: &["dsh"],
            primary_dir_rel: ".dsh",
            extra_dirs_rel: &[],
            config_files_rel: &[".dsh/memos.patch.yml", ".dsh/cordis.patch.yml"],
            format: ConfigFormat::Yaml,
            config_shape: McpConfigShape::DshPatchYaml,
            print_only: true,
            is_gui_editor: false,
        },
        AdapterSpec {
            id: "kilo",
            display_name: "Kilo",
            binary_names: &["kilo", "kilocode"],
            primary_dir_rel: ".config/kilo",
            extra_dirs_rel: &[],
            config_files_rel: &[".config/kilo/kilo.json"],
            format: ConfigFormat::Json,
            config_shape: McpConfigShape::KiloV1,
            print_only: false,
            is_gui_editor: false,
        },
        AdapterSpec {
            id: "pi",
            display_name: "Pi",
            binary_names: &["pi"],
            primary_dir_rel: ".pi/agent",
            extra_dirs_rel: &[".pi"],
            config_files_rel: &[".pi/agent/mcp.json", ".pi/mcp.json"],
            format: ConfigFormat::Json,
            config_shape: McpConfigShape::McpServersMap,
            print_only: false,
            is_gui_editor: false,
        },
        AdapterSpec {
            id: "openclaw",
            display_name: "OpenClaw",
            binary_names: &["openclaw"],
            primary_dir_rel: ".openclaw",
            extra_dirs_rel: &[],
            config_files_rel: &[".openclaw/openclaw.json"],
            format: ConfigFormat::Json,
            config_shape: McpConfigShape::OpenClawServers,
            print_only: true,
            is_gui_editor: false,
        },
        AdapterSpec {
            id: "zed",
            display_name: "Zed",
            binary_names: &["zed"],
            primary_dir_rel: ".config/zed",
            extra_dirs_rel: &[],
            config_files_rel: &[".config/zed/settings.json"],
            format: ConfigFormat::Json,
            config_shape: McpConfigShape::ContextServers,
            print_only: true,
            is_gui_editor: true,
        },
        AdapterSpec {
            id: "goose",
            display_name: "Goose",
            binary_names: &["goose"],
            primary_dir_rel: ".config/goose",
            extra_dirs_rel: &[],
            config_files_rel: &[".config/goose/config.yaml", ".config/goose/config.yml"],
            format: ConfigFormat::Yaml,
            config_shape: McpConfigShape::GooseYaml,
            print_only: true,
            is_gui_editor: false,
        },
        AdapterSpec {
            id: "continue",
            display_name: "Continue",
            binary_names: &["continue", "cn"],
            primary_dir_rel: ".continue",
            extra_dirs_rel: &[],
            config_files_rel: &[
                ".continue/config.yaml",
                ".continue/config.yml",
                ".continue/config.json",
            ],
            format: ConfigFormat::Yaml,
            config_shape: McpConfigShape::ContinueYaml,
            print_only: false,
            is_gui_editor: false,
        },
    ]
}

/// Build all supported adapters with explicit home directory (testable without mutating env).
pub fn adapters_for_home(home_dir: PathBuf) -> Vec<Box<dyn HarnessAdapter>> {
    adapters_for_home_and_path(home_dir, env::var_os("PATH"))
}

pub fn adapters_for_home_and_path(
    home_dir: PathBuf,
    path_env: Option<OsString>,
) -> Vec<Box<dyn HarnessAdapter>> {
    let specs = all_specs();
    let binaries = scan_path_binaries(&specs, &home_dir, path_env.as_ref());
    specs
        .into_iter()
        .map(|spec| {
            let bin = binaries.get(spec.id).cloned();
            Box::new(
                ScaffoldAdapter::new(spec, home_dir.clone(), path_env.clone())
                    .with_resolved_binary(bin),
            ) as Box<dyn HarnessAdapter>
        })
        .collect()
}

pub fn default_adapters() -> Vec<Box<dyn HarnessAdapter>> {
    adapters_for_home(ScaffoldAdapter::resolve_home())
}

/// Parallel read-only harness discovery with mtime/binary cache invalidation (`< 100 ms`).
pub fn detect_all_cached() -> Vec<Detection> {
    let home_dir = ScaffoldAdapter::resolve_home();
    let path_env = env::var_os("PATH");
    detect_all_for_home_and_path(home_dir, path_env)
}

pub fn detect_all_for_home_and_path(
    home_dir: PathBuf,
    path_env: Option<OsString>,
) -> Vec<Detection> {
    let specs = all_specs();
    let cache_mutex = DISCOVERY_CACHE.get_or_init(|| Mutex::new(DiscoveryCache::default()));

    let dsh_home_env = env::var_os("DSH_HOME");

    // Check which entries are still valid (matching home, PATH, DSH_HOME, dir mtimes, config mtimes, and binary mtime).
    let (cached_hits, path_reset) = {
        let guard = cache_mutex.lock().unwrap();
        if guard.home_dir != home_dir
            || guard.path_env != path_env
            || guard.dsh_home != dsh_home_env
        {
            (HashMap::new(), true)
        } else {
            let mut hits = HashMap::new();
            for spec in &specs {
                if let Some(entry) = guard.entries.get(spec.id) {
                    let dirs_valid = entry.dir_mtimes.iter().all(|(p, mt)| mtime_nanos(p) == *mt);
                    let cfgs_valid = entry
                        .config_mtimes
                        .iter()
                        .all(|(p, mt)| mtime_nanos(p) == *mt);
                    let bin_valid = match &entry.binary_path {
                        Some(p) => mtime_nanos(p) == entry.binary_mtime,
                        None => true,
                    };
                    if dirs_valid && cfgs_valid && bin_valid {
                        hits.insert(spec.id, entry.detection.clone());
                    }
                }
            }
            (hits, false)
        }
    };

    if cached_hits.len() == specs.len() {
        return specs
            .iter()
            .filter_map(|s| cached_hits.get(s.id).cloned())
            .collect();
    }

    let binaries = scan_path_binaries(&specs, &home_dir, path_env.as_ref());
    let computed: Vec<(AdapterSpec, Option<PathBuf>, Detection)> = specs
        .iter()
        .map(|spec| {
            let spec_c = spec.clone();
            let bin = binaries.get(spec.id).cloned();
            let cached = cached_hits.get(spec.id).cloned();
            if let Some(det) = cached {
                (spec_c, bin, det)
            } else {
                let adapter =
                    ScaffoldAdapter::new(spec_c.clone(), home_dir.clone(), path_env.clone())
                        .with_resolved_binary(bin.clone());
                let det = adapter.detect_uncached();
                (spec_c, bin, det)
            }
        })
        .collect();

    if let Ok(mut guard) = cache_mutex.lock() {
        if path_reset {
            guard.home_dir = home_dir.clone();
            guard.path_env = path_env.clone();
            guard.dsh_home = dsh_home_env;
            guard.entries.clear();
        }
        for (spec, bin, det) in &computed {
            let adapter = ScaffoldAdapter::new(spec.clone(), home_dir.clone(), path_env.clone());
            let dir_mtimes = adapter
                .candidate_dirs()
                .into_iter()
                .map(|d| {
                    let mt = mtime_nanos(&d);
                    (d, mt)
                })
                .collect();
            let config_mtimes = adapter
                .candidate_configs()
                .into_iter()
                .map(|c| {
                    let mt = mtime_nanos(&c);
                    (c, mt)
                })
                .collect();
            let binary_mtime = bin.as_deref().and_then(mtime_nanos);
            guard.entries.insert(
                spec.id,
                CachedHarnessEntry {
                    dir_mtimes,
                    config_mtimes,
                    binary_path: bin.clone(),
                    binary_mtime,
                    detection: det.clone(),
                },
            );
        }
    }

    computed.into_iter().map(|(_, _, det)| det).collect()
}

/// Detect harnesses strictly inside an isolated fake `home_dir` and `PATH`, ignoring OS system paths and global caches.
pub fn detect_all_for_isolated_home_and_path(
    home_dir: PathBuf,
    path_env: Option<OsString>,
) -> Vec<Detection> {
    let specs = all_specs();
    specs
        .into_iter()
        .map(|spec| {
            ScaffoldAdapter::new(spec, home_dir.clone(), path_env.clone())
                .with_system_dirs(false)
                .detect_uncached()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    use uuid::Uuid;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn scaffolds_all_harnesses_read_only() {
        let tmp = env::temp_dir().join(format!("memos-harness-{}", Uuid::new_v4()));
        fs::create_dir_all(tmp.join(".claude")).unwrap();
        fs::write(
            tmp.join(".claude.json"),
            r#"{"mcpServers":{"memos":{"command":"npx","args":["-y","@mem-os/sdk","mcp"]}}}"#,
        )
        .unwrap();
        fs::create_dir_all(tmp.join(".codex")).unwrap();
        fs::write(
            tmp.join(".codex/config.toml"),
            "[mcp_servers.memos]\ncommand = \"npx\"\nargs = [\"-y\", \"@mem-os/sdk\", \"mcp\"]\n",
        )
        .unwrap();
        fs::create_dir_all(tmp.join(".config/opencode")).unwrap();
        fs::write(
            tmp.join(".config/opencode/opencode.json"),
            r#"{"mcp":{"servers":{"memos":{"type":"local","command":["npx","-y","@mem-os/sdk","mcp"],"enabled":true}}}}"#,
        )
        .unwrap();
        fs::create_dir_all(tmp.join(".dsh")).unwrap();
        fs::write(tmp.join(".dsh/cordis.patch.yml"), "- insert: []\n").unwrap();

        let adapters = adapters_for_home(tmp.clone());
        assert_eq!(adapters.len(), 16);

        let ids: Vec<&str> = adapters.iter().map(|a| a.id()).collect();
        assert_eq!(
            ids,
            vec![
                "claude-code",
                "codex",
                "cursor",
                "windsurf",
                "cline",
                "opencode",
                "opencode-v1",
                "gemini-cli",
                "hermes",
                "dsh",
                "kilo",
                "pi",
                "openclaw",
                "zed",
                "goose",
                "continue"
            ]
        );

        let claude = adapters[0].detect();
        assert!(claude.installed);
        assert!(claude.memos_configured);

        let codex = adapters[1].detect();
        assert!(codex.installed);
        assert!(codex.memos_configured);

        // OpenCode 2.x default matches mcp.servers.memos without falsely marking opencode-v1 configured.
        let oc2 = adapters.iter().find(|a| a.id() == "opencode").unwrap();
        let oc1 = adapters.iter().find(|a| a.id() == "opencode-v1").unwrap();
        assert!(oc2.detect().memos_configured);
        assert!(!oc1.detect().memos_configured);
        assert!(
            oc2.plan_memos_install()
                .stdio_snippet
                .contains("\"servers\"")
        );
        assert!(
            !oc1.plan_memos_install()
                .stdio_snippet
                .contains("\"servers\"")
        );

        // dsh never targets cordis.patch.yml and uses print-only dedicated memos.patch.yml.
        let dsh = adapters.iter().find(|a| a.id() == "dsh").unwrap();
        let dsh_plan = dsh.plan_memos_install();
        assert!(dsh_plan.print_only);
        assert!(dsh_plan.target_config_path.ends_with("memos.patch.yml"));
        assert!(!dsh_plan.target_config_path.ends_with("cordis.patch.yml"));
        assert!(
            dsh_plan
                .stdio_snippet
                .contains("@deepseek-ai/dsh-mcp-client")
        );

        // Verify all snippets default to npx -y @mem-os/sdk mcp.
        for a in &adapters {
            let plan = a.plan_memos_install();
            assert!(!plan.applied);
            assert!(
                plan.stdio_snippet.contains("@mem-os/sdk"),
                "{} snippet missing @mem-os/sdk: {}",
                a.id(),
                plan.stdio_snippet
            );
            assert!(plan.stdio_snippet.contains("npx"));
            assert!(plan.http_snippet.contains("http://localhost:7400/mcp"));
        }

        // Verify print-only set matches harness matrix.
        for id in ["cline", "hermes", "dsh", "openclaw", "zed", "goose"] {
            let a = adapters.iter().find(|x| x.id() == id).unwrap();
            assert!(a.detect().print_only, "{id} must be print_only");
            assert!(
                a.plan_memos_install().print_only,
                "{id} plan must be print_only"
            );
        }
        assert!(!tmp.join(".cursor/mcp.json").exists());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn detects_all_harnesses_with_fake_home_and_builds_launch_specs() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let fake_home = env::temp_dir().join(format!("memos-fake-home-{}", Uuid::new_v4()));
        let fake_bin = fake_home.join("fake-bin");
        fs::create_dir_all(&fake_bin).unwrap();

        for dir in [
            ".claude",
            ".codex",
            ".cursor",
            ".codeium/windsurf",
            ".cline",
            ".config/opencode",
            ".gemini",
            ".hermes",
            ".dsh",
            ".config/kilo",
            ".pi/agent",
            ".openclaw",
            ".config/zed",
            ".config/goose",
            ".continue",
        ] {
            fs::create_dir_all(fake_home.join(dir)).unwrap();
        }
        fs::write(
            fake_home.join(".claude.json"),
            r#"{"mcpServers":{"memos":{"command":"npx","args":["-y","@mem-os/sdk","mcp"]}}}"#,
        )
        .unwrap();
        fs::write(fake_home.join(".codex/config.toml"), "").unwrap();
        fs::write(fake_home.join(".cursor/mcp.json"), "{}").unwrap();
        fs::write(fake_home.join(".codeium/windsurf/mcp_config.json"), "{}").unwrap();
        fs::write(fake_home.join(".cline/cline_mcp_settings.json"), "{}").unwrap();
        fs::write(fake_home.join(".config/opencode/opencode.json"), "{}").unwrap();
        fs::write(fake_home.join(".gemini/settings.json"), "{}").unwrap();
        fs::write(fake_home.join(".hermes/config.yaml"), "mcp_servers:\n").unwrap();
        fs::write(fake_home.join(".dsh/memos.patch.yml"), "- insert: []\n").unwrap();
        fs::write(fake_home.join(".config/kilo/kilo.json"), "{}").unwrap();
        fs::write(fake_home.join(".pi/agent/mcp.json"), "{}").unwrap();
        fs::write(fake_home.join(".openclaw/openclaw.json"), "{}").unwrap();
        fs::write(fake_home.join(".config/zed/settings.json"), "{}").unwrap();
        fs::write(fake_home.join(".config/goose/config.yaml"), "extensions:\n").unwrap();
        fs::write(fake_home.join(".continue/config.yaml"), "mcpServers:\n").unwrap();

        for name in [
            "claude", "codex", "cursor", "windsurf", "cline", "opencode", "gemini", "hermes",
            "dsh", "kilo", "pi", "openclaw", "zed", "goose", "continue",
        ] {
            #[cfg(target_os = "windows")]
            let fname = format!("{name}.cmd");
            #[cfg(not(target_os = "windows"))]
            let fname = name.to_string();
            fs::write(fake_bin.join(fname), "echo test").unwrap();
        }

        let prev_home = env::var_os("HOME");
        let prev_up = env::var_os("USERPROFILE");
        let prev_path = env::var_os("PATH");
        let prev_dsh = env::var_os("DSH_HOME");
        unsafe {
            env::set_var("HOME", &fake_home);
            env::set_var("USERPROFILE", &fake_home);
            env::set_var("PATH", &fake_bin);
            env::remove_var("DSH_HOME");
        }

        let t0 = Instant::now();
        let detected = detect_all_cached();
        let detect_ms = t0.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(detected.len(), 16);
        for d in &detected {
            assert!(d.installed, "{} should be installed", d.id);
            assert!(d.version.is_some(), "{} should have version", d.id);
        }
        assert!(
            detect_ms < 500.0,
            "cold fake-home detection must stay bounded even with opencode subprocess probe (was {detect_ms:.2}ms)"
        );

        let t_warm = Instant::now();
        let cached = detect_all_cached();
        let cached_ms = t_warm.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(cached.len(), 16);
        assert!(cached[0].memos_configured);
        assert!(
            cached_ms < 15.0,
            "cached harness detection must be < 15ms (was {cached_ms:.2}ms)"
        );

        let fake_db = fake_home.join("memos.db");
        let temp_cfg_dir = fake_home.join("temp-mcp");
        let adapters = default_adapters();
        let db_str = fake_db.display().to_string();

        let claude_spec = adapters
            .iter()
            .find(|a| a.id() == "claude-code")
            .unwrap()
            .plan_launch_with_memos(&fake_db, &temp_cfg_dir)
            .unwrap();
        assert_eq!(claude_spec.args[0], "--mcp-config");
        assert!(claude_spec.temp_config_path.is_some());
        assert!(
            claude_spec
                .env
                .contains(&("MEMOS_DB".to_string(), db_str.clone()))
        );
        assert!(
            claude_spec
                .env
                .contains(&("MEMOS_DB_PATH".to_string(), db_str.clone()))
        );

        let codex_spec = adapters
            .iter()
            .find(|a| a.id() == "codex")
            .unwrap()
            .plan_launch_with_memos(&fake_db, &temp_cfg_dir)
            .unwrap();
        assert!(codex_spec.args.contains(&"-c".to_string()));
        assert!(
            codex_spec
                .args
                .iter()
                .any(|a| a.contains("mcp_servers.memos.command"))
        );

        let oc_spec = adapters
            .iter()
            .find(|a| a.id() == "opencode")
            .unwrap()
            .plan_launch_with_memos(&fake_db, &temp_cfg_dir)
            .unwrap();
        assert!(oc_spec.env.iter().any(|(k, _)| k == "OPENCODE_CONFIG"));
        assert!(
            oc_spec
                .temp_config_contents
                .as_deref()
                .unwrap()
                .contains("\"servers\"")
        );

        for a in &adapters {
            let spec = a.plan_launch_with_memos(&fake_db, &temp_cfg_dir).unwrap();
            assert!(spec.env.contains(&("MEMOS_DB".to_string(), db_str.clone())));
            assert!(
                spec.env
                    .contains(&("MEMOS_DB_PATH".to_string(), db_str.clone()))
            );
        }

        unsafe {
            match prev_home {
                Some(v) => env::set_var("HOME", v),
                None => env::remove_var("HOME"),
            }
            match prev_up {
                Some(v) => env::set_var("USERPROFILE", v),
                None => env::remove_var("USERPROFILE"),
            }
            match prev_path {
                Some(v) => env::set_var("PATH", v),
                None => env::remove_var("PATH"),
            }
            match prev_dsh {
                Some(v) => env::set_var("DSH_HOME", v),
                None => env::remove_var("DSH_HOME"),
            }
        }
        let _ = fs::remove_dir_all(&fake_home);
    }

    #[test]
    fn opencode_version_distinguishes_v2_and_v1_and_dsh_requires_binary_or_dsh_home() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = env::temp_dir().join(format!("memos-oc-dsh-{}", Uuid::new_v4()));
        let bin_dir = tmp.join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        fs::create_dir_all(tmp.join(".dsh")).unwrap();
        fs::write(tmp.join(".dsh/memos.patch.yml"), "- insert: []\n").unwrap();

        // 1. OpenCode v2.3.0 -> only "opencode" installed, "opencode-v1" not installed.
        // A home with no ~/.dsh and no binary is not dsh-installed.
        #[cfg(target_os = "windows")]
        {
            fs::write(
                bin_dir.join("opencode.cmd"),
                "@echo off\r\necho opencode v2.3.0\r\n",
            )
            .unwrap();
        }
        #[cfg(not(target_os = "windows"))]
        {
            use std::os::unix::fs::PermissionsExt;
            let p = bin_dir.join("opencode");
            fs::write(&p, "#!/bin/sh\necho opencode v2.3.0\n").unwrap();
            let mut perms = fs::metadata(&p).unwrap().permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&p, perms).unwrap();
        }

        let prev_dsh = env::var_os("DSH_HOME");
        unsafe { env::remove_var("DSH_HOME") };

        let empty_home = tmp.join("empty-home");
        fs::create_dir_all(&empty_home).unwrap();
        let det_v2 =
            detect_all_for_home_and_path(empty_home, Some(bin_dir.clone().into_os_string()));
        let oc2 = det_v2.iter().find(|d| d.id == "opencode").unwrap();
        let oc1 = det_v2.iter().find(|d| d.id == "opencode-v1").unwrap();
        let dsh_absent = det_v2.iter().find(|d| d.id == "dsh").unwrap();
        assert!(oc2.installed);
        assert!(oc2.version.as_deref().unwrap_or("").contains("v2.3.0"));
        assert!(!oc1.installed);
        assert!(oc1.version.is_none());
        assert!(!dsh_absent.installed);

        // 1b. The ~/.dsh fallback marks dsh installed without DSH_HOME.
        let det_fallback =
            detect_all_for_home_and_path(tmp.clone(), Some(bin_dir.clone().into_os_string()));
        assert!(
            det_fallback
                .iter()
                .find(|d| d.id == "dsh")
                .unwrap()
                .installed
        );

        // 2. Setting DSH_HOME to an existing dir marks dsh installed.
        unsafe { env::set_var("DSH_HOME", tmp.join(".dsh")) };
        let det_dsh =
            detect_all_for_home_and_path(tmp.clone(), Some(bin_dir.clone().into_os_string()));
        assert!(det_dsh.iter().find(|d| d.id == "dsh").unwrap().installed);

        // 3. OpenCode 1.4.2 -> only "opencode-v1" installed, "opencode" not installed.
        #[cfg(target_os = "windows")]
        fs::write(bin_dir.join("opencode.cmd"), "@echo off\r\necho 1.4.2\r\n").unwrap();
        #[cfg(not(target_os = "windows"))]
        fs::write(bin_dir.join("opencode"), "#!/bin/sh\necho 1.4.2\n").unwrap();
        if let Some(cache) = OPENCODE_VERSION_CACHE.get() {
            cache.lock().unwrap().clear();
        }
        if let Some(dcache) = DISCOVERY_CACHE.get() {
            dcache.lock().unwrap().entries.clear();
        }
        let det_v1 = detect_all_for_home_and_path(tmp.clone(), Some(bin_dir.into_os_string()));
        let oc2_b = det_v1.iter().find(|d| d.id == "opencode").unwrap();
        let oc1_b = det_v1.iter().find(|d| d.id == "opencode-v1").unwrap();
        assert!(!oc2_b.installed);
        assert!(oc1_b.installed);
        assert!(oc1_b.version.as_deref().unwrap_or("").contains("1.4.2"));

        unsafe {
            match prev_dsh {
                Some(v) => env::set_var("DSH_HOME", v),
                None => env::remove_var("DSH_HOME"),
            }
        }
        let _ = fs::remove_dir_all(&tmp);
    }
}
