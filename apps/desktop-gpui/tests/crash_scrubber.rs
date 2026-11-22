use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::PathBuf;

use memos_desktop::core::db::{DbError, ReadOnlyStore};
use memos_desktop::core::model::{GraphMode, QueryFilter};
use memos_desktop::telemetry::{
    self, APP_VERSION, GPUI_VERSION, ScrubContext, clear_sensitive_text, register_sensitive_text,
    scrub_sentry_event, set_active_query, write_local_crash_report,
};
use rusqlite::Connection;
use sentry::protocol::{
    Breadcrumb, Context as SentryContext, DeviceContext, Event, Exception, Frame, Stacktrace,
    Value as SentryValue,
};

struct GuardCleanup;
impl Drop for GuardCleanup {
    fn drop(&mut self) {
        clear_sensitive_text();
    }
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = env::temp_dir().join(format!("memos-gpui-test-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

#[test]
fn whole_event_scrub_covers_nested_fields() {
    let _cleanup = GuardCleanup;
    let secret = "NESTED_SECRET_MEMORY_abc123";
    register_sensitive_text(secret);
    let ctx = ScrubContext::from_environment("test-install-nested")
        .with_extra_sensitive(secret);

    let mut event = Event::default();
    event.contexts.insert(
        "custom".to_string(),
        SentryContext::Other(BTreeMap::from([(
            "note".to_string(),
            SentryValue::String(secret.to_string()),
        )])),
    );
    let mut nested = serde_json::Map::new();
    nested.insert(
        "description".to_string(),
        SentryValue::String(secret.to_string()),
    );
    event
        .extra
        .insert("nested".to_string(), SentryValue::Object(nested));

    let scrubbed = scrub_sentry_event(event, &ctx).expect("event kept");
    let serialized = serde_json::to_string(&scrubbed).expect("serialize");
    assert!(
        !serialized.contains(secret),
        "nested field leaked secret: {serialized}"
    );
}

#[test]
fn crash_scrubber_strips_secret_query_paths_username_and_hostname() {
    let _cleanup = GuardCleanup;
    let secret = "MEMOS_SECRET_MEMORY_TOKEN_xyz789";
    let search_query = "project_apollo_confidential_roadmap";
    let install_id = "test-install-0000-1111-2222-333333333333";

    register_sensitive_text(secret);
    set_active_query(search_query);

    let ctx = ScrubContext::from_environment(install_id)
        .with_extra_sensitive(secret)
        .with_extra_sensitive(search_query);

    let home_probe = env::var("USERPROFILE")
        .or_else(|_| env::var("HOME"))
        .unwrap_or_else(|_| "/home/testuser".to_string());
    let sample_abs_path = format!("{home_probe}/Documents/private/memos.db");

    let mut event = Event {
        release: Some(format!("memos-desktop@{APP_VERSION}").into()),
        server_name: Some("workstation-secret-host.local".into()),
        message: Some(format!(
            "Query failed for query=\"{search_query}\" near content=\"{secret}\" at {sample_abs_path}"
        )),
        ..Default::default()
    };

    event.exception.values.push(Exception {
        ty: "SqliteReadPanic".to_string(),
        value: Some(format!("panic with secret {secret} and {sample_abs_path}")),
        stacktrace: Some(Stacktrace {
            frames: vec![Frame {
                filename: Some(sample_abs_path.clone()),
                abs_path: Some(sample_abs_path.clone()),
                function: Some("memos_desktop::db::query".to_string()),
                ..Default::default()
            }],
            ..Default::default()
        }),
        ..Default::default()
    });

    event.breadcrumbs.values.push(Breadcrumb {
        message: Some(format!(
            "FTS search '{search_query}' triggered from {sample_abs_path}"
        )),
        data: BTreeMap::from([
            (
                "query".to_string(),
                SentryValue::String(search_query.to_string()),
            ),
            (
                "content".to_string(),
                SentryValue::String(secret.to_string()),
            ),
            ("safe_count".to_string(), SentryValue::from(42)),
        ]),
        ..Default::default()
    });

    event
        .tags
        .insert("query".to_string(), search_query.to_string());
    event.extra.insert(
        "memory_text".to_string(),
        SentryValue::String(secret.to_string()),
    );
    event.contexts.insert(
        "device".to_string(),
        SentryContext::Device(Box::new(DeviceContext {
            name: Some("secret-laptop".to_string()),
            ..Default::default()
        })),
    );

    let scrubbed = scrub_sentry_event(event, &ctx).expect("event kept after scrubbing");
    let serialized = serde_json::to_string(&scrubbed).expect("serialize scrubbed event");

    assert!(
        !serialized.contains(secret),
        "scrubbed event leaked secret string: {serialized}"
    );
    assert!(
        !serialized.contains(search_query),
        "scrubbed event leaked search query: {serialized}"
    );
    assert!(
        !serialized.contains(&home_probe),
        "scrubbed event leaked full home directory path: {serialized}"
    );
    assert!(
        scrubbed.server_name.is_none(),
        "server_name must be stripped"
    );
    if let Ok(user) = env::var("USERNAME").or_else(|_| env::var("USER"))
        && user.len() >= 3
        && !matches!(user.as_str(), "app" | "user" | "root" | "test")
    {
        assert!(
            !serialized.contains(&user),
            "scrubbed event leaked username `{user}`: {serialized}"
        );
    }

    assert_eq!(
        scrubbed.tags.get("app_version").map(String::as_str),
        Some(APP_VERSION)
    );
    assert_eq!(
        scrubbed.tags.get("gpui_version").map(String::as_str),
        Some(GPUI_VERSION)
    );
    assert_eq!(
        scrubbed.tags.get("error_kind").map(String::as_str),
        Some("SqliteReadPanic")
    );
    assert_eq!(
        scrubbed.user.as_ref().and_then(|u| u.id.as_deref()),
        Some(install_id)
    );
}

#[test]
fn local_crash_report_works_offline_and_strips_sensitive_data() {
    let _cleanup = GuardCleanup;
    let dir = temp_dir("local-crash");
    let canary = "OFFLINE_PANIC_MEMORY_CANARY_424242";
    register_sensitive_text(canary);

    let report_path = write_local_crash_report(
        &dir,
        "offline-install-9999",
        &format!("crash while viewing memory '{canary}' at {}", dir.display()),
        Some("C:\\Users\\fake\\src\\app.rs:42:1"),
        &format!("0: frame with {canary}"),
    )
    .expect("write local crash report");

    let contents = fs::read_to_string(&report_path).expect("read report");
    assert!(contents.contains(APP_VERSION));
    assert!(contents.contains(GPUI_VERSION));
    assert!(contents.contains("offline-install-9999"));
    assert!(
        !contents.contains(canary),
        "local crash report leaked sensitive canary: {contents}"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn schema_introspection_handles_missing_optional_tables_and_columns() {
    let dir = temp_dir("legacy-schema");
    let db_path = dir.join("legacy.db");

    {
        let conn = Connection::open(&db_path).expect("create legacy db");
        // Minimal schema: omits provenance, trust_score, importance, summary, metadata,
        // and omits edges, node_tags, embeddings, contradictions, nodes_fts, entity_index, etc.
        conn.execute_batch(
            "CREATE TABLE nodes (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                content TEXT NOT NULL,
                namespace TEXT DEFAULT 'default',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            INSERT INTO nodes (id, type, content, namespace, created_at, updated_at)
            VALUES
              ('a1b2c3d4-0000-0000-0000-000000000001', 'fact', 'Legacy schema alpha entry', 'default', 1700000000000, 1700000001000),
              ('b2c3d4e5-0000-0000-0000-000000000002', 'decision', 'Legacy schema beta entry', 'work', 1700000002000, 1700000003000);",
        )
        .expect("seed legacy db");
    }

    let store = ReadOnlyStore::open(&db_path).expect("open minimal schema db read-only");
    let overview = store.load_overview().expect("overview on minimal schema");
    assert_eq!(overview.node_count, 2);
    assert_eq!(overview.edge_count, 0);
    assert!(overview.missing_tables.contains(&"edges".to_string()));
    assert!(overview.missing_tables.contains(&"nodes_fts".to_string()));
    assert!(
        overview
            .missing_tables
            .contains(&"recall_traces".to_string())
    );

    // Fallback LIKE search when `nodes_fts` is absent.
    let filter = QueryFilter {
        query: "alpha".to_string(),
        ..Default::default()
    };
    let results = store
        .query_nodes(&filter, &overview.contradiction_node_ids, 100)
        .expect("query without FTS5");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].short_id.as_ref(), "a1b2");

    let detail = store
        .load_node_detail("a1b2c3d4-0000-0000-0000-000000000001")
        .expect("load detail on legacy schema")
        .expect("row exists");
    assert!(detail.edges.is_empty());
    assert!(detail.contradictions.is_empty());

    for mode in GraphMode::ALL {
        let snap = store
            .load_graph_snapshot(
                mode,
                &QueryFilter::default(),
                &overview.contradiction_node_ids,
                2_000,
            )
            .expect("graph snapshot works without optional tables");
        if mode == GraphMode::Contradictions {
            assert_eq!(snap.nodes.len(), 0);
        } else {
            assert_eq!(snap.nodes.len(), 2);
        }
    }

    drop(store);
    let _ = fs::remove_dir_all(&dir);

    let missing_err = ReadOnlyStore::open(dir.join("missing.db"));
    assert!(matches!(missing_err, Err(DbError::NotFound)));

    // Keep telemetry module referenced cleanly for -D warnings.
    let _log_dir = telemetry::log_dir();
}
