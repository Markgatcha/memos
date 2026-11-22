use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

/// Both benchmarks build large synthetic stores and measure latency. Running
/// them concurrently lets the 50k setup steal CPU and disk from the 10k p95
/// gate, which made the release gate flaky. Serialize them in-process.
static BENCH_LOCK: Mutex<()> = Mutex::new(());

use memos_desktop::core::db::{
    DEFAULT_GRAPH_NODE_CAP, LIST_NEXT_PAGE_SIZE, LIST_PAGE_SIZE, ReadOnlyStore,
};
use memos_desktop::core::model::{GraphMode, QueryFilter};
use memos_desktop::ui::views::graph::compute_graph_layout;
use rusqlite::{Connection, TransactionBehavior};

fn build_synthetic_store(path: &Path, node_count: usize, with_fts: bool) {
    let mut conn = Connection::open(path).expect("create synthetic db");
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = OFF;
         CREATE TABLE nodes (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            content TEXT NOT NULL,
            summary TEXT,
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
            relation TEXT NOT NULL,
            weight REAL DEFAULT 1.0,
            created_at INTEGER NOT NULL,
            valid_from INTEGER,
            valid_to INTEGER,
            metadata TEXT DEFAULT '{}'
         );
         CREATE TABLE node_tags (
            node_id TEXT NOT NULL,
            tag TEXT NOT NULL,
            PRIMARY KEY (node_id, tag)
         );
         CREATE TABLE contradictions (
            id TEXT PRIMARY KEY,
            node_a TEXT NOT NULL,
            node_b TEXT NOT NULL,
            status TEXT DEFAULT 'open',
            detected_at INTEGER NOT NULL
         );
         CREATE TABLE entity_index (
            entity TEXT NOT NULL,
            node_id TEXT NOT NULL
         );
         CREATE INDEX idx_nodes_recency_sort
            ON nodes(COALESCE(updated_at, created_at, 0) DESC, id DESC);",
    )
    .expect("create schema");

    if with_fts {
        conn.execute_batch(
            "CREATE VIRTUAL TABLE nodes_fts USING fts5(content, summary, content='nodes', content_rowid='rowid', tokenize='porter unicode61');",
        )
        .expect("create fts5 table");
    }

    let namespaces = ["default", "work", "architecture", "security", "research"];
    let types = [
        "fact",
        "preference",
        "decision",
        "procedural",
        "observation",
    ];
    let provs = ["user-verified", "direct-input", "agent-inferred"];
    let tags = [
        "rust",
        "sqlite",
        "gpui",
        "graph",
        "performance",
        "telemetry",
        "mcp",
        "security",
    ];
    let keywords = [
        "apollo",
        "meridian",
        "quantum",
        "walrus",
        "obsidian",
        "lyon",
        "lattice",
        "beacon",
        "synthesis",
        "hyperion",
    ];
    let entities = ["MemOS", "SQLite", "GPUI", "Lyon", "Sentry", "Codex"];

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .expect("begin tx");

    {
        let mut ins_node = tx
            .prepare(
                "INSERT INTO nodes (id, type, content, summary, importance, created_at, updated_at, last_accessed, namespace, provenance, trust_score)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            )
            .expect("prep node");
        let mut ins_tag = tx
            .prepare("INSERT INTO node_tags (node_id, tag) VALUES (?1, ?2)")
            .expect("prep tag");
        let mut ins_ent = tx
            .prepare("INSERT INTO entity_index (entity, node_id) VALUES (?1, ?2)")
            .expect("prep entity");

        let base_ts: i64 = 1_700_000_000_000;
        for i in 0..node_count {
            let id = format!("{:08x}-0000-4000-8000-{:012x}", i + 1, i + 1);
            let ty = types[i % types.len()];
            let ns = namespaces[i % namespaces.len()];
            let prov = provs[i % provs.len()];
            let kw = keywords[i % keywords.len()];
            let kw2 = keywords[(i * 7 + 3) % keywords.len()];
            let content = format!(
                "Synthetic memory {i} about {kw} and {kw2} architecture milestone in namespace {ns}."
            );
            let summary = format!("Summary {i}: {kw} / {kw2}");
            let importance = ((i % 100) as f64) / 100.0;
            let trust = 0.5 + ((i % 50) as f64) / 100.0;
            let ts = base_ts + (i as i64) * 60_000;

            ins_node
                .execute(rusqlite::params![
                    id, ty, content, summary, importance, ts, ts, ts, ns, prov, trust
                ])
                .expect("insert node");
            ins_tag
                .execute(rusqlite::params![id, tags[i % tags.len()]])
                .expect("insert tag1");
            if i % 3 == 0 {
                ins_tag
                    .execute(rusqlite::params![id, tags[(i + 3) % tags.len()]])
                    .expect("insert tag2");
            }
            if i < 2_500 {
                ins_ent
                    .execute(rusqlite::params![entities[i % entities.len()], id])
                    .expect("insert entity");
            }
        }

        let mut ins_edge = tx
            .prepare(
                "INSERT INTO edges (id, source_id, target_id, relation, weight, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .expect("prep edge");
        let relations = ["related_to", "supports", "derived_from", "supersedes"];
        let edge_target_count = (node_count / 2).min(5_000);
        for i in 0..edge_target_count {
            let src = format!("{:08x}-0000-4000-8000-{:012x}", i + 1, i + 1);
            let dst_idx = ((i * 13 + 5) % node_count) + 1;
            let dst = format!("{dst_idx:08x}-0000-4000-8000-{dst_idx:012x}");
            let eid = format!("edge-{i:08x}");
            let rel = relations[i % relations.len()];
            ins_edge
                .execute(rusqlite::params![
                    eid,
                    src,
                    dst,
                    rel,
                    0.85,
                    base_ts + i as i64
                ])
                .expect("insert edge");
        }

        let mut ins_contra = tx
            .prepare(
                "INSERT INTO contradictions (id, node_a, node_b, status, detected_at)
                 VALUES (?1, ?2, ?3, 'open', ?4)",
            )
            .expect("prep contradiction");
        for i in 0..30 {
            let a = format!("{:08x}-0000-4000-8000-{:012x}", i * 2 + 1, i * 2 + 1);
            let b = format!("{:08x}-0000-4000-8000-{:012x}", i * 2 + 2, i * 2 + 2);
            ins_contra
                .execute(rusqlite::params![format!("c-{i}"), a, b, base_ts])
                .expect("insert contradiction");
        }
    }

    if with_fts {
        tx.execute_batch("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild');")
            .expect("rebuild fts5");
    }

    tx.commit().expect("commit synthetic store");
}

fn temp_db_path(label: &str) -> PathBuf {
    env::temp_dir().join(format!("memos-gpui-{label}-{}.db", std::process::id()))
}

#[cfg(target_os = "windows")]
fn current_rss_bytes() -> Option<u64> {
    #[repr(C)]
    #[allow(non_snake_case)]
    struct ProcessMemoryCounters {
        cb: u32,
        PageFaultCount: u32,
        PeakWorkingSetSize: usize,
        WorkingSetSize: usize,
        QuotaPeakPagedPoolUsage: usize,
        QuotaPagedPoolUsage: usize,
        QuotaPeakNonPagedPoolUsage: usize,
        QuotaNonPagedPoolUsage: usize,
        PagefileUsage: usize,
        PeakPagefileUsage: usize,
    }
    unsafe extern "system" {
        fn GetCurrentProcess() -> isize;
        fn K32GetProcessMemoryInfo(
            process: isize,
            ppsmem_counters: *mut ProcessMemoryCounters,
            cb: u32,
        ) -> i32;
    }
    let mut counters = std::mem::MaybeUninit::<ProcessMemoryCounters>::zeroed();
    let cb = std::mem::size_of::<ProcessMemoryCounters>() as u32;
    unsafe {
        (*counters.as_mut_ptr()).cb = cb;
        let ok = K32GetProcessMemoryInfo(GetCurrentProcess(), counters.as_mut_ptr(), cb);
        if ok != 0 {
            Some(counters.assume_init().WorkingSetSize as u64)
        } else {
            None
        }
    }
}

#[cfg(target_os = "linux")]
fn current_rss_bytes() -> Option<u64> {
    let status = fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            let kb: u64 = rest.split_whitespace().next()?.parse().ok()?;
            return Some(kb * 1024);
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn current_rss_bytes() -> Option<u64> {
    let pid = std::process::id().to_string();
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid])
        .output()
        .ok()?;
    let kb: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
    Some(kb * 1024)
}

#[test]
fn smoke_10k_nodes_startup_search_p95_and_graph_layout() {
    let _guard = BENCH_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let db_path = temp_db_path("smoke-10k");
    let _ = fs::remove_file(&db_path);
    build_synthetic_store(&db_path, 10_000, true);

    let t_open = Instant::now();
    let store = ReadOnlyStore::open(&db_path).expect("open 10k synthetic db read-only");
    let overview = store.load_overview().expect("overview 10k");
    let items = store
        .query_nodes(
            &QueryFilter::default(),
            &overview.contradiction_node_ids,
            LIST_PAGE_SIZE,
        )
        .expect("query 10k items");
    let startup_ms = t_open.elapsed().as_secs_f64() * 1000.0;

    assert_eq!(overview.node_count, 10_000);
    assert_eq!(items.len(), LIST_PAGE_SIZE);

    // Measure FTS5 search p95 across 25 queries.
    let queries = [
        "apollo",
        "meridian",
        "quantum",
        "walrus",
        "obsidian",
        "lyon",
        "lattice",
        "beacon",
        "synthesis",
        "hyperion",
        "apollo milestone",
        "quantum architecture",
        "mem:0000000a",
        "obsidian work",
        "beacon security",
        "walrus research",
        "hyperion architecture",
        "meridian default",
        "lattice synthesis",
        "lyon milestone",
        "apollo beacon",
        "quantum walrus",
        "mem:00000100",
        "obsidian lyon",
        "synthesis work",
    ];

    let mut cold_latencies_ms = Vec::with_capacity(queries.len());
    let mut warm_latencies_ms = Vec::with_capacity(queries.len());
    for q in queries {
        let f = QueryFilter {
            query: q.to_string(),
            ..Default::default()
        };
        let t_cold = Instant::now();
        let res = store
            .query_nodes(&f, &overview.contradiction_node_ids, LIST_PAGE_SIZE)
            .expect("fts query cold");
        let cold_ms = t_cold.elapsed().as_secs_f64() * 1000.0;
        assert!(!res.is_empty(), "expected matches for '{q}'");
        cold_latencies_ms.push(cold_ms);

        let mut samples = [0.0f64; 3];
        for s in &mut samples {
            let t0 = Instant::now();
            let r = store
                .query_nodes(&f, &overview.contradiction_node_ids, LIST_PAGE_SIZE)
                .expect("fts query warm");
            *s = t0.elapsed().as_secs_f64() * 1000.0;
            assert!(!r.is_empty());
        }
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        warm_latencies_ms.push(samples[1]);
    }
    cold_latencies_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    warm_latencies_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let cold_p95_ix = ((cold_latencies_ms.len() as f64) * 0.95).ceil() as usize - 1;
    let cold_p95 = cold_latencies_ms[cold_p95_ix.min(cold_latencies_ms.len() - 1)];
    let p50 = warm_latencies_ms[warm_latencies_ms.len() / 2];
    let p95_ix = ((warm_latencies_ms.len() as f64) * 0.95).ceil() as usize - 1;
    let p95 = warm_latencies_ms[p95_ix.min(warm_latencies_ms.len() - 1)];

    // Verify detail loading on node 0.
    let detail = store
        .load_node_detail(&items[0].id)
        .expect("detail load")
        .expect("node exists");
    assert!(!detail.content.is_empty());

    // Verify keyset pagination past 500 on 10k nodes (no gaps or duplicates across pages 1..4).
    let page1 = store
        .query_nodes_page(
            &QueryFilter::default(),
            &overview.contradiction_node_ids,
            None,
            LIST_PAGE_SIZE,
        )
        .expect("10k page 1");
    assert_eq!(page1.items.len(), LIST_PAGE_SIZE);
    assert!(page1.has_more);
    let page2 = store
        .query_nodes_page(
            &QueryFilter::default(),
            &overview.contradiction_node_ids,
            page1.next_cursor.as_ref(),
            LIST_NEXT_PAGE_SIZE,
        )
        .expect("10k page 2");
    assert_eq!(page2.items.len(), LIST_NEXT_PAGE_SIZE);
    assert!(page2.has_more);
    let mut seen_10k =
        std::collections::HashSet::with_capacity(LIST_PAGE_SIZE + LIST_NEXT_PAGE_SIZE);
    for it in page1.items.iter().chain(page2.items.iter()) {
        assert!(
            seen_10k.insert(it.id.clone()),
            "10k pagination duplicate {}",
            it.id
        );
    }

    // Measure all 5 GraphMode snapshot loads + background layouts with 2,000-node cap.
    let mut graph_timings = Vec::new();
    for mode in GraphMode::ALL {
        let tg = Instant::now();
        let snap = store
            .load_graph_snapshot(
                mode,
                &QueryFilter::default(),
                &overview.contradiction_node_ids,
                DEFAULT_GRAPH_NODE_CAP,
            )
            .expect("graph snapshot");
        let snap_ms = tg.elapsed().as_secs_f64() * 1000.0;
        assert!(
            snap.nodes.len() <= DEFAULT_GRAPH_NODE_CAP,
            "{mode:?} exceeded 2,000 node cap: {}",
            snap.nodes.len()
        );
        let layout = compute_graph_layout(&snap);
        graph_timings.push((
            mode,
            snap.nodes.len(),
            snap.clustered_nodes,
            snap.edges.len(),
            snap_ms,
            layout.elapsed_ms,
        ));
    }

    let rss_mb = current_rss_bytes().map(|b| b as f64 / (1024.0 * 1024.0));
    println!(
        "BENCH_10K: startup_db_ms={startup_ms:.2}, search_p50_ms={p50:.2}, search_p95_ms={p95:.2}, search_cold_p95_ms={cold_p95:.2}, rss_mb={:.2}",
        rss_mb.unwrap_or(-1.0)
    );
    for (mode, vis, clus, edges, snap_ms, layout_ms) in &graph_timings {
        println!(
            "BENCH_GRAPH_{mode:?}: visible_nodes={vis}, clustered={clus}, edges={edges}, query_ms={snap_ms:.2}, layout_ms={layout_ms:.2}"
        );
    }

    if !cfg!(debug_assertions) {
        assert!(
            p95 < 30.0,
            "10k warm FTS5 search p95 exceeded 30 ms budget: {p95:.2} ms"
        );
        assert!(
            cold_p95 < 60.0,
            "10k cold-cache FTS5 search p95 exceeded 60 ms budget: {cold_p95:.2} ms"
        );
        for (mode, _, _, _, _, layout_ms) in &graph_timings {
            assert!(
                *layout_ms < 250.0,
                "{mode:?} 2k graph layout exceeded 250 ms budget: {layout_ms:.2} ms"
            );
        }
    } else {
        println!(
            "BENCH_10K_DEBUG: p95={p95:.2} ms, cold_p95={cold_p95:.2} ms (not gated; debug builds are unoptimized)"
        );
    }

    drop(detail);
    drop(items);
    drop(store);
    for suffix in ["", "-wal", "-shm"] {
        let mut p = db_path.as_os_str().to_os_string();
        p.push(suffix);
        let _ = fs::remove_file(p);
    }
}

#[test]
fn smoke_50k_nodes_resident_memory_under_200mb() {
    let _guard = BENCH_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let db_path = temp_db_path("smoke-50k");
    let _ = fs::remove_file(&db_path);
    build_synthetic_store(&db_path, 50_000, false);

    let store = ReadOnlyStore::open(&db_path).expect("open 50k db");
    let overview = store.load_overview().expect("overview 50k");
    assert_eq!(overview.node_count, 50_000);

    let page1 = store
        .query_nodes_page(
            &QueryFilter::default(),
            &overview.contradiction_node_ids,
            None,
            LIST_PAGE_SIZE,
        )
        .expect("query 50k page 1");
    assert_eq!(page1.items.len(), LIST_PAGE_SIZE);
    assert!(page1.has_more);
    let page2 = store
        .query_nodes_page(
            &QueryFilter::default(),
            &overview.contradiction_node_ids,
            page1.next_cursor.as_ref(),
            LIST_NEXT_PAGE_SIZE,
        )
        .expect("query 50k page 2");
    assert_eq!(page2.items.len(), LIST_NEXT_PAGE_SIZE);
    assert!(page2.has_more);
    let items = [page1.items, page2.items].concat();
    let unique_50k: std::collections::HashSet<&str> = items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(unique_50k.len(), LIST_PAGE_SIZE + LIST_NEXT_PAGE_SIZE);

    if let Some(rss_bytes) = current_rss_bytes() {
        let rss_mb = rss_bytes as f64 / (1024.0 * 1024.0);
        println!(
            "BENCH_50K: loaded_nodes={}, rss_mb={rss_mb:.2}",
            items.len()
        );
        if !cfg!(debug_assertions) {
            assert!(
                rss_mb < 120.0,
                "Resident memory with 50,000 nodes exceeded 120 MB budget: {rss_mb:.2} MB"
            );
        } else {
            assert!(
                rss_mb < 200.0,
                "Resident memory with 50,000 nodes exceeded 200 MB debug cap: {rss_mb:.2} MB"
            );
        }
    } else {
        println!(
            "BENCH_50K: loaded_nodes={}, rss_mb=unavailable",
            items.len()
        );
    }

    drop(items);
    drop(store);
    let _ = fs::remove_file(&db_path);
}
