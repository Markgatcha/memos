//! Headless `--self-test`: exercises onboarding, every view constructor,
//! schema introspection, graph layout and harness discovery without a window.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{App, AppContext, Bounds, WindowBounds, WindowOptions, px, size};

use crate::core::db::{DEFAULT_GRAPH_NODE_CAP, DbError, DbProbeSummary, ReadOnlyStore};
use crate::core::easter_eggs::{
    Celebrate100Outcome, Celebrate100Tracker, KonamiDetector, KonamiKey,
};
use crate::core::harness;
use crate::core::health::{StoreHealthStatus, assess_store_health, now_unix_ms};
use crate::core::model::{GraphMode, QueryFilter, RowDensity, SortOrder, ViewMode};
use crate::core::settings::{AppSettings, ResolvedDbPath, ThemeMode, WindowBoundsSetting};
use crate::core::write_bridge::{BridgeError, WriteBridge};
use crate::telemetry::{self, StartupTimeline, TelemetryHandle};
use crate::ui::app::{LaunchOptions, MemOSApp, register_app_key_bindings};
use crate::ui::views::TextInput;
use crate::ui::views::ThemePalette;
use crate::ui::views::detail::DetailView;
use crate::ui::views::graph::GraphView;
use crate::ui::views::list::MemoryListView;
use crate::ui::views::onboarding::{
    DbValidationState, OnboardingState, OnboardingStep, OnboardingView,
};
use crate::ui::views::palette::CommandPalette;
use crate::ui::views::sidebar::SidebarView;

pub fn run_self_test(
    resolved_db: ResolvedDbPath,
    settings: AppSettings,
    telemetry: Arc<TelemetryHandle>,
    timeline: Arc<StartupTimeline>,
) -> anyhow::Result<()> {
    use anyhow::ensure;
    use rusqlite::{Connection, TransactionBehavior};
    use uuid::Uuid;

    struct TempDirCleanup(PathBuf);
    impl Drop for TempDirCleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn run_check(name: &str, f: impl FnOnce() -> anyhow::Result<()>) -> anyhow::Result<()> {
        f().map_err(|err| anyhow::anyhow!("[check:{name}] {err}"))
    }

    fn create_rich_schema(conn: &mut Connection) -> anyhow::Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = OFF;
             CREATE TABLE nodes (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                content TEXT NOT NULL,
                summary TEXT DEFAULT '',
                importance REAL DEFAULT 0.5,
                confidence REAL DEFAULT 0.8,
                evidence_count INTEGER DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                access_count INTEGER DEFAULT 0,
                last_accessed INTEGER NOT NULL,
                valid_from INTEGER,
                valid_to INTEGER,
                expires_at INTEGER,
                metadata TEXT DEFAULT '{}',
                namespace TEXT NOT NULL DEFAULT 'default',
                source TEXT NOT NULL DEFAULT 'cli',
                harness TEXT NOT NULL DEFAULT 'codex',
                provenance TEXT NOT NULL DEFAULT 'user-verified',
                trust_score REAL NOT NULL DEFAULT 0.9,
                quarantined INTEGER NOT NULL DEFAULT 0,
                quarantined_at INTEGER,
                quarantine_reason TEXT
             );
             CREATE TABLE edges (
                id TEXT PRIMARY KEY,
                source_id TEXT NOT NULL,
                target_id TEXT NOT NULL,
                relation TEXT NOT NULL DEFAULT 'relates_to',
                weight REAL DEFAULT 0.7,
                created_at INTEGER NOT NULL,
                valid_from INTEGER,
                valid_to INTEGER
             );
             CREATE TABLE node_tags (
                node_id TEXT NOT NULL,
                tag TEXT NOT NULL
             );
             CREATE TABLE contradictions (
                id TEXT PRIMARY KEY,
                node_a TEXT NOT NULL,
                node_b TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'open',
                detected_at INTEGER NOT NULL
             );
             CREATE TABLE entity_index (
                entity TEXT NOT NULL,
                node_id TEXT NOT NULL
             );
             CREATE VIRTUAL TABLE nodes_fts USING fts5(content, summary);",
        )?;
        Ok(())
    }

    let tmp_root = std::env::temp_dir().join(format!("memos-self-test-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_root)?;
    let _cleanup = TempDirCleanup(tmp_root.clone());

    // 1. Missing DB check
    run_check("db_missing", || {
        let missing = tmp_root.join("does-not-exist.db");
        let err = ReadOnlyStore::open(&missing)
            .err()
            .ok_or_else(|| anyhow::anyhow!("expected NotFound opening missing DB"))?;
        ensure!(
            matches!(err, DbError::NotFound),
            "expected DbError::NotFound, got {err}"
        );
        ensure!(
            crate::core::db::probe_database(&missing).is_err(),
            "probe_database should fail on missing DB"
        );
        Ok(())
    })?;

    // 2. Empty DB (0 rows) + health Empty + all 5 graph modes empty
    run_check("db_empty_0_rows", || {
        let empty_db = tmp_root.join("empty.db");
        {
            let mut conn = Connection::open(&empty_db)?;
            create_rich_schema(&mut conn)?;
        }
        let store = ReadOnlyStore::open(&empty_db)?;
        let ov = store.load_overview()?;
        ensure!(
            ov.node_count == 0,
            "expected 0 nodes, got {}",
            ov.node_count
        );
        let health = assess_store_health(&store, &ov, now_unix_ms())?;
        ensure!(
            health.status == StoreHealthStatus::Empty,
            "expected Empty health status"
        );
        let filter = QueryFilter::default();
        for mode in GraphMode::ALL {
            let snap = store.load_graph_snapshot(
                mode,
                &filter,
                &ov.contradiction_node_ids,
                DEFAULT_GRAPH_NODE_CAP,
            )?;
            ensure!(snap.nodes.is_empty(), "empty DB graph node count != 0");
        }
        Ok(())
    })?;

    // 3. Invalid DB (non-SQLite bytes & SQLite DB lacking `nodes` table)
    run_check("db_invalid", || {
        let corrupt = tmp_root.join("corrupt.db");
        std::fs::write(&corrupt, b"definitely-not-a-sqlite-header")?;
        let corrupt_res = ReadOnlyStore::open(&corrupt);
        ensure!(
            matches!(
                corrupt_res,
                Err(DbError::OpenFailed { .. } | DbError::QueryFailed { .. })
            ),
            "expected OpenFailed/QueryFailed on non-SQLite file"
        );
        ensure!(
            crate::core::db::probe_database(&corrupt).is_err(),
            "probe_database must fail on non-SQLite file"
        );

        let no_nodes = tmp_root.join("no_nodes.db");
        {
            let conn = Connection::open(&no_nodes)?;
            conn.execute_batch("CREATE TABLE unrelated (id INTEGER PRIMARY KEY);")?;
        }
        ensure!(
            matches!(
                ReadOnlyStore::open(&no_nodes),
                Err(DbError::MissingNodesTable)
            ),
            "expected MissingNodesTable on DB without `nodes`"
        );
        Ok(())
    })?;

    // 4. Legacy DB schema (minimal columns, no optional/FTS tables, read-only enforcement)
    let legacy_db = tmp_root.join("legacy.db");
    run_check("db_legacy", || {
        {
            let conn = Connection::open(&legacy_db)?;
            conn.execute_batch(
                "CREATE TABLE nodes (
                    id TEXT PRIMARY KEY,
                    content TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                 );
                 INSERT INTO nodes (id, content, created_at, updated_at) VALUES
                    ('a3f9c2e1-0000-4000-8000-000000000001', 'legacy fallback searchable memory', 1700000000000, 1700000000000),
                    ('b7e21104-0000-4000-8000-000000000002', 'second legacy note', 1700000100000, 1700000100000);",
            )?;
        }
        let store = ReadOnlyStore::open(&legacy_db)?;
        let ov = store.load_overview()?;
        ensure!(ov.node_count == 2, "expected 2 legacy rows");
        ensure!(ov.missing_tables.contains(&"edges".to_string()));
        ensure!(ov.missing_tables.contains(&"nodes_fts".to_string()));
        let filter = QueryFilter {
            query: "searchable".to_string(),
            ..Default::default()
        };
        let found = store.query_nodes(&filter, &ov.contradiction_node_ids, 50)?;
        ensure!(found.len() == 1, "expected LIKE fallback match");
        ensure!(
            matches!(
                store.resolve_node_id("[mem:a3f9]")?,
                crate::core::db::NodeLookup::Exact(_)
            ),
            "short citation resolution failed on legacy DB"
        );
        let detail = store
            .load_node_detail("a3f9c2e1-0000-4000-8000-000000000001")?
            .ok_or_else(|| anyhow::anyhow!("missing legacy detail"))?;
        ensure!(detail.citation_token == "[mem:a3f9]");
        for mode in GraphMode::ALL {
            let _ = store.load_graph_snapshot(
                mode,
                &QueryFilter::default(),
                &ov.contradiction_node_ids,
                DEFAULT_GRAPH_NODE_CAP,
            )?;
        }
        Ok(())
    })?;

    // 5. 10k rows + FTS5 + all 5 graph modes & layout finiteness
    run_check("db_10k_rows_and_5_graph_modes", || {
        let db10k = tmp_root.join("10k.db");
        let now = now_unix_ms();
        {
            let mut conn = Connection::open(&db10k)?;
            create_rich_schema(&mut conn)?;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            {
                let mut ins_node = tx.prepare(
                    "INSERT INTO nodes (id, type, content, summary, importance, created_at, updated_at, last_accessed, namespace, source, harness, provenance, trust_score)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'cli', 'codex', 'user-verified', 0.9)",
                )?;
                let mut ins_fts = tx.prepare(
                    "INSERT INTO nodes_fts(rowid, content, summary) VALUES (?1, ?2, ?3)",
                )?;
                let mut ins_tag =
                    tx.prepare("INSERT INTO node_tags(node_id, tag) VALUES (?1, ?2)")?;
                let mut ins_ent =
                    tx.prepare("INSERT INTO entity_index(entity, node_id) VALUES (?1, ?2)")?;
                for i in 0..10_000usize {
                    let id = format!("{i:08x}-0000-4000-8000-000000000001");
                    let ty = match i % 4 {
                        0 => "fact",
                        1 => "decision",
                        2 => "preference",
                        _ => "lesson",
                    };
                    let ns = if i % 2 == 0 { "work" } else { "personal" };
                    let content = if i == 42 {
                        "needle_10k_unique_token architectural choice".to_string()
                    } else {
                        format!("synthetic memory entry #{i} about component {}", i % 40)
                    };
                    let ts = now - (i as i64) * 60_000;
                    ins_node.execute(rusqlite::params![
                        id,
                        ty,
                        content,
                        format!("summary {i}"),
                        0.4 + ((i % 6) as f32) * 0.1,
                        ts,
                        ts,
                        ts,
                        ns
                    ])?;
                    ins_fts.execute(rusqlite::params![
                        (i + 1) as i64,
                        content,
                        format!("summary {i}")
                    ])?;
                    if i < 200 {
                        ins_tag.execute(rusqlite::params![id, format!("tag-{}", i % 5)])?;
                        ins_ent.execute(rusqlite::params![format!("Entity-{}", i % 7), id])?;
                    }
                }
                let mut ins_edge = tx.prepare(
                    "INSERT INTO edges(id, source_id, target_id, relation, weight, created_at) VALUES (?1, ?2, ?3, 'relates_to', 0.8, ?4)",
                )?;
                for i in 0..400usize {
                    let a = format!("{i:08x}-0000-4000-8000-000000000001");
                    let b = format!("{:08x}-0000-4000-8000-000000000001", i + 1);
                    ins_edge.execute(rusqlite::params![format!("e-{i}"), a, b, now])?;
                }
                tx.execute(
                    "INSERT INTO contradictions(id, node_a, node_b, status, detected_at)
                     VALUES ('c-1', '00000000-0000-4000-8000-000000000001', '00000001-0000-4000-8000-000000000001', 'open', ?1)",
                    [now],
                )?;
            }
            tx.commit()?;
        }

        let store = ReadOnlyStore::open(&db10k)?;
        let ov = store.load_overview()?;
        ensure!(
            ov.node_count == 10_000,
            "expected 10000 rows, got {}",
            ov.node_count
        );
        let fts_hits = store.query_nodes(
            &QueryFilter {
                query: "needle_10k_unique_token".to_string(),
                ..Default::default()
            },
            &ov.contradiction_node_ids,
            100,
        )?;
        ensure!(fts_hits.len() == 1, "expected 1 FTS5 match on 10k rows");
        let health = assess_store_health(&store, &ov, now)?;
        ensure!(health.status == StoreHealthStatus::Contradictions);

        for mode in GraphMode::ALL {
            let snap = store.load_graph_snapshot(
                mode,
                &QueryFilter::default(),
                &ov.contradiction_node_ids,
                DEFAULT_GRAPH_NODE_CAP,
            )?;
            ensure!(
                snap.nodes.len() <= DEFAULT_GRAPH_NODE_CAP + 64,
                "mode {:?} exceeded cap",
                mode
            );
            let layout = crate::ui::views::graph::compute_graph_layout(&snap);
            ensure!(
                layout
                    .nodes
                    .iter()
                    .all(|n| n.x.is_finite() && n.y.is_finite()),
                "non-finite graph coordinates for {:?}",
                mode
            );
        }
        Ok(())
    })?;

    // 6. 50k rows pagination + graph snapshot
    run_check("db_50k_rows", || {
        let db50k = tmp_root.join("50k.db");
        let now = now_unix_ms();
        {
            let mut conn = Connection::open(&db50k)?;
            create_rich_schema(&mut conn)?;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            {
                let mut ins = tx.prepare(
                    "INSERT INTO nodes (id, type, content, importance, created_at, updated_at, last_accessed, namespace, source, harness, provenance, trust_score)
                     VALUES (?1, 'fact', ?2, 0.5, ?3, ?3, ?3, 'scale', 'cli', 'codex', 'user-verified', 0.9)",
                )?;
                for i in 0..50_000usize {
                    let id = format!("{i:08x}-0000-4000-8000-000000000050");
                    let ts = now - (i as i64) * 1000;
                    ins.execute(rusqlite::params![id, format!("scale item #{i}"), ts])?;
                }
            }
            tx.commit()?;
        }
        let store = ReadOnlyStore::open(&db50k)?;
        let ov = store.load_overview()?;
        ensure!(
            ov.node_count == 50_000,
            "expected 50000 rows, got {}",
            ov.node_count
        );
        let page = store.query_nodes(
            &QueryFilter::default(),
            &ov.contradiction_node_ids,
            crate::core::db::LIST_PAGE_SIZE,
        )?;
        ensure!(
            page.len() == crate::core::db::LIST_PAGE_SIZE,
            "50k page size mismatch: {}",
            page.len()
        );
        let snap = store.load_graph_snapshot(
            GraphMode::Namespace,
            &QueryFilter::default(),
            &ov.contradiction_node_ids,
            DEFAULT_GRAPH_NODE_CAP,
        )?;
        ensure!(!snap.nodes.is_empty(), "50k graph should emit clusters");
        ensure!(snap.clustered_nodes > 0, "50k graph must cluster overflow");
        Ok(())
    })?;

    // 7. All onboarding branches (missing/stale/valid, Ready options, Back, Skip, Finish)
    run_check("onboarding_all_branches", || {
        let mut st = OnboardingState::new(resolved_db.path.clone(), &settings);
        ensure!(st.step == OnboardingStep::Database);
        ensure!(!st.can_advance());
        ensure!(!st.can_skip());
        ensure!(!st.go_next());

        let gen0 = st.begin_probe(PathBuf::from("nonexistent_memos_self_test.db"));
        ensure!(st.apply_probe_result(
            gen0,
            PathBuf::from("nonexistent_memos_self_test.db"),
            Err("file does not exist".to_string()),
        ));
        ensure!(matches!(st.db_status, DbValidationState::NotFound(_)));
        ensure!(!st.can_advance());
        ensure!(!st.can_skip());

        let gen_inv = st.begin_probe(PathBuf::from("invalid_memos_self_test.db"));
        ensure!(st.apply_probe_result(
            gen_inv,
            PathBuf::from("invalid_memos_self_test.db"),
            Err("missing required tables".to_string()),
        ));
        ensure!(matches!(st.db_status, DbValidationState::Invalid { .. }));
        ensure!(!st.can_advance());

        let gen1 = st.begin_probe(legacy_db.clone());
        ensure!(!st.apply_probe_result(
            gen1.saturating_sub(1),
            PathBuf::from("stale.db"),
            Ok(DbProbeSummary {
                path: PathBuf::from("stale.db"),
                node_count: 1,
                edge_count: 0,
            }),
        ));
        ensure!(st.apply_probe_result(
            gen1,
            legacy_db.clone(),
            Ok(DbProbeSummary {
                path: legacy_db.clone(),
                node_count: 2,
                edge_count: 0,
            }),
        ));
        ensure!(matches!(st.db_status, DbValidationState::Valid(_)));
        ensure!(st.can_advance());
        ensure!(st.can_skip());

        // Branch: skip directly without changing Ready toggles preserves defaults.
        let skipped = st.build_skipped_settings(&AppSettings::default());
        ensure!(skipped.onboarding_completed);
        ensure_eq_msg(
            skipped.preferred_db_path,
            Some(legacy_db.clone()),
            "skip db",
        )?;
        ensure!(skipped.crash_reporting_consent == Some(false));

        // Branch: go_next -> change theme & crash opt-in -> go_back -> go_next -> finish.
        ensure!(st.go_next());
        ensure!(st.step == OnboardingStep::Ready);
        st.theme = ThemeMode::Light;
        st.crash_reporting_enabled = true;
        ensure!(!st.go_next());
        ensure!(st.go_back());
        ensure!(st.step == OnboardingStep::Database);
        ensure!(st.go_next());
        let finished = st.build_finished_settings(&settings);
        ensure!(finished.onboarding_completed);
        ensure!(finished.theme == ThemeMode::Light);
        ensure!(finished.crash_reporting_consent == Some(true));
        ensure!(finished.preferred_db_path == Some(legacy_db.clone()));
        Ok(())
    })?;

    // 8. Settings round-trip + celebrated_100 + write mode
    run_check("settings_round_trip", || {
        let cfg_path = tmp_root.join("settings.json");
        let original = AppSettings {
            install_id: "self-test-install-id".to_string(),
            crash_reporting_consent: Some(true),
            theme: ThemeMode::Dark,
            default_view: ViewMode::Graph,
            onboarding_completed: true,
            celebrated_100: true,
            preferred_db_path: Some(legacy_db.clone()),
            saved_views: settings.saved_views.clone(),
            window_bounds: Some(WindowBoundsSetting {
                x: 120.0,
                y: 80.0,
                width: 1280.0,
                height: 800.0,
                maximized: false,
            }),
            last_sort: SortOrder::Importance,
            last_view_mode: Some(ViewMode::Graph),
            last_saved_view_id: Some("all".to_string()),
            row_density: RowDensity::Compact,
            write_mode: true,
            writer_command: "memos mcp".to_string(),
        };
        original.save_to(&cfg_path)?;
        let loaded = AppSettings::load_from(&cfg_path);
        ensure!(loaded.install_id == original.install_id);
        ensure!(loaded.crash_reporting_consent == Some(true));
        ensure!(loaded.theme == ThemeMode::Dark);
        ensure!(loaded.default_view == ViewMode::Graph);
        ensure!(loaded.onboarding_completed);
        ensure!(loaded.celebrated_100);
        ensure!(loaded.preferred_db_path == original.preferred_db_path);
        ensure!(loaded.window_bounds == original.window_bounds);
        ensure!(loaded.last_sort == SortOrder::Importance);
        ensure!(loaded.row_density == RowDensity::Compact);
        ensure!(loaded.last_view_mode == Some(ViewMode::Graph));
        ensure!(loaded.last_saved_view_id.as_deref() == Some("all"));
        ensure!(loaded.write_mode);
        ensure!(loaded.effective_writer_command() == "memos mcp");
        Ok(())
    })?;

    // 9. Harness detection 0/16 and 16/16 in isolated directory (no host leak)
    run_check("harness_detection_0_of_16_and_16_of_16", || {
        let empty_home = tmp_root.join("harness-empty");
        std::fs::create_dir_all(&empty_home)?;
        let zero = harness::adapters::detect_all_for_isolated_home_and_path(
            empty_home,
            Some(std::ffi::OsString::new()),
        );
        ensure!(
            zero.len() == 16,
            "expected 16 harness entries, got {}",
            zero.len()
        );
        let installed_zero = zero.iter().filter(|d| d.installed).count();
        ensure!(
            installed_zero == 0,
            "expected 0/16 in isolated empty home, got {installed_zero}/16"
        );

        let full_home = tmp_root.join("harness-full");
        let fake_bin = full_home.join("bin");
        std::fs::create_dir_all(&fake_bin)?;
        for sub in [
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
            std::fs::create_dir_all(full_home.join(sub))?;
        }
        std::fs::write(full_home.join(".claude.json"), "{}")?;
        std::fs::write(full_home.join(".codex/config.toml"), "")?;
        std::fs::write(full_home.join(".cursor/mcp.json"), "{}")?;
        std::fs::write(full_home.join(".codeium/windsurf/mcp_config.json"), "{}")?;
        std::fs::write(full_home.join(".cline/cline_mcp_settings.json"), "{}")?;
        std::fs::write(full_home.join(".config/opencode/opencode.json"), "{}")?;
        std::fs::write(full_home.join(".gemini/settings.json"), "{}")?;
        std::fs::write(full_home.join(".hermes/config.yaml"), "mcp_servers:\n")?;
        std::fs::write(full_home.join(".dsh/memos.patch.yml"), "- insert: []\n")?;
        std::fs::write(full_home.join(".config/kilo/kilo.json"), "{}")?;
        std::fs::write(full_home.join(".pi/agent/mcp.json"), "{}")?;
        std::fs::write(full_home.join(".openclaw/openclaw.json"), "{}")?;
        std::fs::write(full_home.join(".config/zed/settings.json"), "{}")?;
        std::fs::write(full_home.join(".config/goose/config.yaml"), "extensions:\n")?;
        std::fs::write(full_home.join(".continue/config.yaml"), "mcpServers:\n")?;

        for name in [
            "claude", "codex", "cursor", "windsurf", "cline", "opencode", "gemini", "hermes",
            "dsh", "kilo", "pi", "openclaw", "zed", "goose", "continue",
        ] {
            #[cfg(target_os = "windows")]
            let fname = format!("{name}.cmd");
            #[cfg(not(target_os = "windows"))]
            let fname = name.to_string();
            std::fs::write(fake_bin.join(fname), "echo ok")?;
        }
        let sixteen = harness::adapters::detect_all_for_isolated_home_and_path(
            full_home,
            Some(fake_bin.into_os_string()),
        );
        let installed_sixteen = sixteen.iter().filter(|d| d.installed).count();
        ensure!(
            installed_sixteen == 16,
            "expected 16/16 in isolated full home, got {installed_sixteen}/16"
        );
        Ok(())
    })?;

    // 10. Crash reporting off/on & secret scrubbing
    run_check("crash_reporting_off_and_on", || {
        let mut s_off = settings.clone();
        s_off.crash_reporting_consent = None;
        ensure!(!s_off.crash_reporting_enabled());
        s_off.crash_reporting_consent = Some(false);
        ensure!(!s_off.crash_reporting_enabled());
        telemetry.sync_sentry_from_settings(&s_off);

        let mut s_on = settings.clone();
        s_on.crash_reporting_consent = Some(true);
        ensure!(s_on.crash_reporting_enabled());
        telemetry.sync_sentry_from_settings(&s_on);
        telemetry.sync_sentry_from_settings(&settings);

        let secret = "SELF_TEST_SENSITIVE_MEMORY_LINE";
        telemetry::register_sensitive_text(secret);
        telemetry::set_active_query("secret_query_self_test");
        let crash_dir = tmp_root.join("crash-reports");
        let report_path = telemetry::write_local_crash_report(
            &crash_dir,
            &settings.install_id,
            &format!("panic near {secret} query=secret_query_self_test"),
            Some("C:\\Users\\fakeuser\\memos\\secret"),
            "frame 0",
        )?;
        let report_body = std::fs::read_to_string(&report_path)?;
        telemetry::clear_sensitive_text();
        ensure!(!report_body.contains(secret), "crash report leaked secret");
        ensure!(
            !report_body.contains("secret_query_self_test"),
            "crash report leaked search query"
        );
        Ok(())
    })?;

    // 11. Easter eggs state machines + GPUI headless render & views across all modes/themes
    run_check("easter_eggs_and_headless_ui", || {
        let now = Instant::now();
        let mut konami = KonamiDetector::new();
        for (ix, k) in [
            KonamiKey::Up,
            KonamiKey::Up,
            KonamiKey::Down,
            KonamiKey::Down,
            KonamiKey::Left,
            KonamiKey::Right,
            KonamiKey::Left,
            KonamiKey::Right,
            KonamiKey::B,
        ]
        .into_iter()
        .enumerate()
        {
            ensure!(!konami.push(k, now + Duration::from_millis(ix as u64 * 100)));
        }
        ensure!(konami.push(KonamiKey::A, now + Duration::from_millis(950)));

        let mut cel = Celebrate100Tracker::new(false);
        ensure!(cel.observe_count(99, false) == Celebrate100Outcome::None);
        ensure!(cel.observe_count(100, false) == Celebrate100Outcome::AnimateAndPersist);

        for mode in [ThemeMode::System, ThemeMode::Light, ThemeMode::Dark] {
            let theme = ThemePalette::for_mode(mode);
            let _sidebar = SidebarView::new(settings.saved_views.clone(), theme);
            let _list = MemoryListView::new(theme);
            let _detail = DetailView::new(theme);
            for gm in GraphMode::ALL {
                let _graph = GraphView::new(gm, theme);
            }
        }

        let db_clone = resolved_db.clone();
        let settings_clone = settings.clone();
        let tl_clone = timeline.clone();
        let tel_clone = telemetry.clone();
        gpui_platform::headless().run(move |cx: &mut App| {
            register_app_key_bindings(cx);
            let bounds = Bounds::centered(None, size(px(1100.), px(720.)), cx);
            let window_opts = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_min_size: Some(size(px(900.), px(600.))),
                show: false,
                focus: false,
                ..Default::default()
            };
            let _ = cx.open_window(window_opts, move |window, cx| {
                let theme = ThemePalette::resolve(settings_clone.theme, window.appearance());
                let _input = cx.new(|cx| TextInput::new(cx, "self-test", theme));
                let _multiline =
                    cx.new(|cx| TextInput::new_multiline(cx, "self-test multi", theme));
                let _palette = cx.new(|cx| CommandPalette::new(theme, window, cx));
                let _onboarding = cx.new(|cx| {
                    OnboardingView::new(db_clone.path.clone(), settings_clone.clone(), theme, cx)
                });
                cx.new(|cx| {
                    MemOSApp::new(
                        db_clone,
                        settings_clone,
                        tel_clone,
                        tl_clone,
                        LaunchOptions {
                            smoke_exit_after_first_frame: true,
                            no_fun: false,
                        },
                        window,
                        cx,
                    )
                })
            });
            cx.spawn(async move |cx| {
                cx.update(|cx| cx.quit());
            })
            .detach();
        });
        ensure!(crate::ui::views::detail::is_sticky_header_visible(60.0));
        Ok(())
    })?;

    // 12. WriteBridge error handling (invalid command surfaces SpawnFailed without DB mutation)
    run_check("write_bridge_config_and_errors", || {
        let bridge = WriteBridge::new("memos-nonexistent-writer-cmd-xyz", legacy_db.clone());
        let err = bridge
            .ping()
            .expect_err("nonexistent writer must fail cleanly");
        ensure!(matches!(err, BridgeError::SpawnFailed { .. }));
        bridge.shutdown();
        Ok(())
    })?;

    println!(
        "SELF_TEST_OK checks=12 harnesses=0/16,16/16 db_source={}",
        resolved_db.source.label()
    );
    Ok(())
}

fn ensure_eq_msg<T: PartialEq + std::fmt::Debug>(
    left: T,
    right: T,
    label: &str,
) -> anyhow::Result<()> {
    if left != right {
        anyhow::bail!("{label}: expected {right:?}, got {left:?}");
    }
    Ok(())
}
