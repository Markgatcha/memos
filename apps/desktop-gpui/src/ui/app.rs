use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use gpui::{
    AccessibleAction, AnyElement, App, AppContext, Bounds, ClipboardItem, Context, Entity,
    FocusHandle, Focusable, FontWeight, InteractiveElement, IntoElement, KeyBinding, KeyDownEvent,
    MouseButton, MouseDownEvent, ParentElement, PathPromptOptions, Render, Role, ScrollHandle,
    SharedString, StatefulInteractiveElement, Styled, Subscription, Task, TitlebarOptions, Window,
    WindowBackgroundAppearance, WindowBounds, WindowOptions, actions, div, point,
    prelude::FluentBuilder, px, size,
};

use crate::core::context_pack::PackSource;
use crate::core::db::{
    DEFAULT_GRAPH_NODE_CAP, DbError, LIST_NEXT_PAGE_SIZE, ListCursor, ReadOnlyStore,
};
use crate::core::easter_eggs::{
    CELEBRATE_100_DURATION, Celebrate100Outcome, Celebrate100Tracker, KonamiDetector, KonamiKey,
    MomoPeekController, PeekSample,
};
use crate::core::harness::{self, Detection, InstallPlan, McpServerConfig, McpTransport};
use crate::core::health::{
    HealthPanelFilter, StoreHealthReport, StoreHealthStatus, assess_store_health, now_unix_ms,
};
use crate::core::model::{
    BriefSnapshot, DbOverview, DreamDiffEntry, DreamDiffKind, GraphMode, MemoryListItem,
    QueryFilter, RowDensity, SortOrder, ViewMode, WriterSchemaPreflight, describe_filter_target,
    extract_search_scopes, format_timestamp_ms, remove_last_search_scope, remove_search_scope,
    scopes_from_filter,
};
use crate::core::settings::{
    AppSettings, DEFAULT_WRITER_COMMAND, DbPathSource, ResolvedDbPath, ThemeMode,
    WindowBoundsSetting,
};
use crate::core::store_cache::SharedStore;
use crate::core::write_bridge::{
    BridgeError, IngestInput, IngestResult, PingResult, ReviewInput, StoreInput, WriteBridge,
    detect_local_writer, parse_extensions_csv, recommended_writer_command,
};
use crate::telemetry::{self, StartupTimeline, TelemetryHandle};
use crate::ui::motion::prefers_reduced_motion;
use crate::ui::views::brief::{BriefEvent, BriefSectionKind, BriefView};
use crate::ui::views::detail::{DetailEvent, DetailView};
use crate::ui::views::graph::{GraphEvent, GraphView};
use crate::ui::views::kit;
use crate::ui::views::list::{ListEvent, MemoryListView};
use crate::ui::views::momo::render_momo_button;
use crate::ui::views::onboarding::{
    CLI_INIT_COMMAND, CLI_STORE_COMMAND, OnboardingEvent, OnboardingView,
};
use crate::ui::views::palette::{CommandPalette, PaletteAction, PaletteEvent};
use crate::ui::views::review::{ReviewEvent, ReviewLoadError, ReviewView};
use crate::ui::views::sidebar::{SidebarEvent, SidebarSurface, SidebarView};
use crate::ui::views::{
    InputEvent, TextInput, ThemePalette, UiIcon, init_icon_font_from_window, keycap,
    register_input_key_bindings, render_ui_icon, render_vertical_scroll_overlay, status_dot,
    tabular_nums, tooltip_view,
};

mod actions;
mod capture_ui;
mod compare_ui;
mod dialogs_ui;
mod health_ui;
mod keymap;
mod loaders;
mod modals;
mod pack_ui;
mod review_batch;
mod search_ui;
mod settings_ui;
mod shell;
mod shortcuts;
mod state;
mod store_ui;
mod tools_ui;
mod write_path;

pub use keymap::register_app_key_bindings;
pub use write_path::{is_ingest_button_visible, parse_ingest_chunk_chars};

use loaders::{db_file_stamp, load_initial_snapshot_blocking};
use shell::{preferred_window_background, window_bounds_to_setting};
use state::{format_memory_count, toggle_opt_string};
use write_path::sanitize_db_error;

const APP_BUILD_DATE: &str = env!("MEMOS_BUILD_DATE");

actions!(
    memos_app,
    [
        OpenPalette,
        FocusSearch,
        SwitchToList,
        SwitchToGraph,
        ToggleTheme,
        QuickCapture,
        OpenTodaySurface,
        OpenReviewSurface,
        ToggleSearchSyntax,
        ExportMemories
    ]
);

#[derive(Clone, Debug)]
struct InitialLoadResult {
    overview: DbOverview,
    items: Vec<MemoryListItem>,
    next_cursor: Option<ListCursor>,
    has_more: bool,
    total_matching: usize,
    health: Option<StoreHealthReport>,
}

/// Phase two of startup: the full overview plus health. `full` is `None`
/// when the fast phase already owns the list rows.
struct PhaseTwo {
    overview: DbOverview,
    health: Option<StoreHealthReport>,
    full: Option<(InitialLoadResult, Instant)>,
}

#[derive(Clone, Debug)]
struct PendingLiveReload {
    result: InitialLoadResult,
    stamp: Option<(u64, Option<SystemTime>)>,
    newest_id: Option<String>,
}

#[derive(Clone, Debug)]
struct HarnessInspectorData {
    detection: Detection,
    servers: Vec<McpServerConfig>,
    plan: InstallPlan,
    reveal_path: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum WorkspaceSurface {
    #[default]
    Memories,
    Today,
    Review,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PopoverOwner {
    None,
    Overflow,
    List,
    Graph,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HoverOrigin {
    List,
    Graph,
}

#[derive(Clone, Debug)]
enum WriteRetryAction {
    Store {
        input: StoreInput,
    },
    Edit {
        original_id: String,
        input: StoreInput,
    },
    /// The new version was already stored; only the supersede link failed.
    /// Retrying this must never store a second copy.
    FinishEdit {
        original_id: String,
        new_id: String,
    },
    Forget {
        id: String,
    },
    /// Retry an approve/reject from the review queue through the same banner
    /// as other writes.
    Review {
        id: String,
        approve: bool,
    },
}

#[derive(Clone, Debug)]
struct BridgeErrorBanner {
    command: String,
    message: String,
    retry_action: WriteRetryAction,
}

#[derive(Clone, Debug)]
struct ForgetTarget {
    id: String,
    short_id: String,
    preview: String,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct LaunchOptions {
    pub smoke_exit_after_first_frame: bool,
    pub no_fun: bool,
}

pub fn launch_main_app(
    resolved_db: ResolvedDbPath,
    settings: AppSettings,
    telemetry: Arc<TelemetryHandle>,
    timeline: Arc<StartupTimeline>,
    options: LaunchOptions,
) {
    let gpui_init_start = Instant::now();
    gpui_platform::application().run(move |cx: &mut App| {
        timeline.record_span("gpui_app_init", gpui_init_start, Instant::now());
        telemetry::start_render_stats_if_requested();
        register_app_key_bindings(cx);
        cx.on_window_closed(|cx, _window_id| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();

        let window_bounds = if let Some(saved) = settings.window_bounds {
            let displays: Vec<(f32, f32, f32, f32)> = cx
                .displays()
                .into_iter()
                .map(|d| {
                    let b = d.bounds();
                    (
                        b.origin.x.as_f32(),
                        b.origin.y.as_f32(),
                        b.size.width.as_f32(),
                        b.size.height.as_f32(),
                    )
                })
                .collect();
            let clamped = saved.clamp_to_displays(&displays);
            let rect = Bounds::new(
                point(px(clamped.x), px(clamped.y)),
                size(px(clamped.width), px(clamped.height)),
            );
            if clamped.maximized {
                WindowBounds::Maximized(rect)
            } else {
                WindowBounds::Windowed(rect)
            }
        } else {
            WindowBounds::Windowed(Bounds::centered(None, size(px(1100.), px(720.)), cx))
        };
        let window_opts = WindowOptions {
            window_bounds: Some(window_bounds),
            window_min_size: Some(size(px(900.), px(600.))),
            window_background: preferred_window_background(),
            focus: true,
            titlebar: Some(TitlebarOptions {
                title: Some("MemOS".into()),
                ..Default::default()
            }),
            ..Default::default()
        };

        let db = resolved_db.clone();
        let st = settings.clone();
        let tel = telemetry.clone();
        let tl_win = timeline.clone();
        let window_open_start = Instant::now();
        let open_res = cx.open_window(window_opts, move |window, cx| {
            // `window_open` minus this span is GPUI's own window/device setup.
            let view_start = Instant::now();
            let tl_view = tl_win.clone();
            let view = cx.new(|cx| MemOSApp::new(db, st, tel, tl_win, options, window, cx));
            tl_view.record_span("app_view_new", view_start, Instant::now());
            view
        });
        timeline.record_span("window_open", window_open_start, Instant::now());
        if let Err(err) = open_res {
            tracing::error!(error = %err, "failed to open main GPUI window");
            let _ = timeline.write_report_if_configured();
            cx.quit();
        }
    });
}

pub use crate::ui::crash_dialog::launch_crash_dialog;
pub use crate::ui::self_test::run_self_test;

/// Root MemOS Desktop workspace view orchestrating background DB queries, graph, and overlays.
pub struct MemOSApp {
    focus_handle: FocusHandle,
    palette_return_focus: Option<FocusHandle>,
    timeline: Arc<StartupTimeline>,
    smoke_exit_after_first_frame: bool,
    no_fun: bool,
    first_frame_logged: bool,
    first_frame_done: bool,
    initial_load_done: bool,
    store_create_in_flight: bool,
    store_optimize_in_flight: bool,
    window_active: bool,
    shared_store: SharedStore,

    resolved_db: ResolvedDbPath,
    settings: AppSettings,
    telemetry: Arc<TelemetryHandle>,
    theme: ThemePalette,
    overview: Option<DbOverview>,
    health_report: Option<StoreHealthReport>,
    health_status: StoreHealthStatus,
    active_surface: WorkspaceSurface,
    view_mode: ViewMode,
    graph_mode: GraphMode,
    filter: QueryFilter,
    active_saved_view_id: Option<String>,
    today_count: usize,
    pending_review_count: usize,
    selected_id: Option<String>,
    detail_open: bool,
    hovered_id: Option<String>,
    write_bridge: Arc<WriteBridge>,
    writer_preflight: WriterSchemaPreflight,
    writer_testing: bool,
    writer_test_status: Option<Result<PingResult, String>>,
    write_in_flight: bool,
    write_bridge_error: Option<BridgeErrorBanner>,
    show_composer_modal: bool,
    composer_editing_id: Option<String>,
    composer_type: String,
    composer_pool: String,
    composer_validation_error: Option<String>,
    forget_confirm_target: Option<ForgetTarget>,
    show_ingest_modal: bool,
    ingest_recursive: bool,
    ingest_in_flight: bool,
    ingest_result: Option<IngestResult>,
    ingest_error: Option<String>,

    harnesses: Vec<Detection>,
    selected_harness_ix: usize,
    harness_inspector: Option<HarnessInspectorData>,
    show_harnesses_modal: bool,
    pending_connect_id: Option<&'static str>,
    tools_advanced_open: bool,
    show_settings_modal: bool,
    settings_scroll: ScrollHandle,
    show_health_modal: bool,
    show_dream_diff_modal: bool,
    show_shortcuts_modal: bool,
    pack: pack_ui::PackState,
    compare: compare_ui::CompareState,
    capture: capture_ui::CaptureState,
    search_ui: search_ui::SearchUiState,
    review_batch: review_batch::ReviewBatchState,
    store_switch: store_ui::StoreSwitchState,
    graph_card: shortcuts::GraphCardState,
    ingest_ui: dialogs_ui::IngestUiState,
    show_save_view_modal: bool,
    save_view_input: Entity<TextInput>,
    health_filter: HealthPanelFilter,
    dream_diff_entries: Vec<DreamDiffEntry>,
    dream_diff_loading: bool,
    dream_diff_filter: Option<DreamDiffKind>,
    show_overflow_menu: bool,
    show_consent_modal: bool,
    compact_layout: bool,
    momo_hovered: bool,
    last_synced_titlebar_dark: Option<bool>,
    status_notice: Option<String>,
    bounds_dirty: bool,

    konami: KonamiDetector,
    celebrate_100: Celebrate100Tracker,
    celebrate_100_until: Option<Instant>,
    momo_peek: MomoPeekController,
    momo_peek_sample: PeekSample,
    last_db_stamp: Option<(u64, Option<SystemTime>)>,
    pending_live_reload: Option<PendingLiveReload>,

    query_generation: crate::ui::request::RequestToken,
    page_generation: crate::ui::request::RequestToken,
    detail_generation: crate::ui::request::RequestToken,
    graph_generation: crate::ui::request::RequestToken,

    list_cursor: Option<ListCursor>,
    list_total_matching: usize,
    loading_next_page: bool,

    search_input: Entity<TextInput>,
    writer_cmd_input: Entity<TextInput>,
    composer_content_input: Entity<TextInput>,
    composer_tags_input: Entity<TextInput>,
    composer_namespace_input: Entity<TextInput>,
    composer_context_input: Entity<TextInput>,
    ingest_path_input: Entity<TextInput>,
    ingest_namespace_input: Entity<TextInput>,
    ingest_extensions_input: Entity<TextInput>,
    ingest_chunk_input: Entity<TextInput>,
    sidebar: Entity<SidebarView>,
    list_view: Entity<MemoryListView>,
    brief_view: Entity<BriefView>,
    review_view: Entity<ReviewView>,
    detail_view: Entity<DetailView>,
    graph_view: Entity<GraphView>,
    palette: Entity<CommandPalette>,
    onboarding: Option<Entity<OnboardingView>>,

    _init_task: Option<Task<()>>,
    _optimize_task: Option<Task<()>>,
    _search_task: Option<Task<()>>,
    _next_page_task: Option<Task<()>>,
    _brief_task: Option<Task<()>>,
    _review_task: Option<Task<()>>,
    _ingest_task: Option<Task<()>>,
    _browse_ingest_task: Option<Task<()>>,
    _detail_task: Option<Task<()>>,
    _graph_task: Option<Task<()>>,
    _harness_task: Option<Task<()>>,
    _harness_detail_task: Option<Task<()>>,
    _diag_task: Option<Task<()>>,
    _dream_diff_task: Option<Task<()>>,
    _bounds_save_task: Option<Task<()>>,
    _notice_task: Option<Task<()>>,
    _celebrate_task: Option<Task<()>>,
    _db_watch_task: Option<Task<()>>,
    _peek_watch_task: Option<Task<()>>,
    _peek_anim_task: Option<Task<()>>,
    _write_task: Option<Task<()>>,
    _writer_ping_task: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl Focusable for MemOSApp {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Drop for MemOSApp {
    fn drop(&mut self) {
        self.write_bridge.shutdown();
        if self.bounds_dirty && !self.smoke_exit_after_first_frame {
            let _ = self.settings.save_to(&AppSettings::config_path());
        }
    }
}

#[cfg(target_os = "windows")]
fn sync_win32_titlebar(window: &Window, theme: ThemePalette) {
    crate::win32::sync_titlebar(window, theme.is_dark);
}

#[cfg(not(target_os = "windows"))]
fn sync_win32_titlebar(_window: &Window, _theme: ThemePalette) {}

#[cfg(test)]
mod tests {
    use super::loaders::{count_new_memory_ids, find_newest_added_id};
    use super::modals::filter_dream_diff_entries;
    use super::*;

    fn dummy_item(id: &str, updated_at: i64) -> MemoryListItem {
        let short: String = id.chars().take(6).collect();
        MemoryListItem {
            id: id.to_string(),
            short_id: Arc::from(short),
            preview: Arc::from(id),
            node_type: Arc::from("observation"),
            namespace: Arc::from("default"),
            provenance: Arc::from("local"),
            source: Arc::from(""),
            harness: Arc::from(""),
            tags: Vec::new(),
            importance: 0.5,
            trust_score: 1.0,
            created_at: updated_at,
            updated_at,
            has_contradiction: false,
            quarantined: false,
        }
    }

    #[test]
    fn live_memory_diff_counts_and_picks_newest_added_id() {
        let old = vec![dummy_item("m1", 100), dummy_item("m2", 90)];
        let new = vec![
            dummy_item("m4", 120),
            dummy_item("m3", 110),
            dummy_item("m1", 100),
            dummy_item("m2", 90),
        ];
        assert_eq!(count_new_memory_ids(&old, &new, 2, 4), 2);
        assert_eq!(find_newest_added_id(&old, &new).as_deref(), Some("m4"));

        // Even when page totals grow beyond visible window, total delta wins cleanly.
        assert_eq!(count_new_memory_ids(&old, &old, 500, 505), 5);
    }

    #[test]
    fn dream_diff_filter_filters_by_kind_cleanly() {
        let entries = vec![
            DreamDiffEntry {
                timestamp: 3000,
                kind: DreamDiffKind::Promoted,
                node_id: "a".to_string(),
                short_id: "aaaa".to_string(),
                summary: "Promoted".to_string(),
                detail: "PROMOTE".to_string(),
            },
            DreamDiffEntry {
                timestamp: 2000,
                kind: DreamDiffKind::Contradiction,
                node_id: "b".to_string(),
                short_id: "bbbb".to_string(),
                summary: "Conflict".to_string(),
                detail: "Conflicts".to_string(),
            },
        ];
        assert_eq!(filter_dream_diff_entries(&entries, None).len(), 2);
        let conflicts = filter_dream_diff_entries(&entries, Some(DreamDiffKind::Contradiction));
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].node_id, "b");
        assert!(filter_dream_diff_entries(&entries, Some(DreamDiffKind::Decayed)).is_empty());
    }

    #[test]
    fn ingest_gate_chunk_parser_and_args_behave_cleanly() {
        assert!(!is_ingest_button_visible(false));
        assert!(is_ingest_button_visible(true));
        assert_eq!(parse_ingest_chunk_chars("").unwrap(), None);
        assert_eq!(parse_ingest_chunk_chars("1200").unwrap(), Some(1200));
        assert!(parse_ingest_chunk_chars("50").is_err());
        assert!(parse_ingest_chunk_chars("abc").is_err());

        let exts = parse_extensions_csv("md, txt, pdf");
        let args = crate::core::write_bridge::build_ingest_tool_args(
            &IngestInput {
                path: "docs".to_string(),
                namespace: Some("documents".to_string()),
                extensions: exts,
                chunk_chars: Some(1200),
                recursive: true,
            },
            "docs",
        );
        assert_eq!(args["path"], "docs");
        assert_eq!(args["namespace"], "documents");
        assert_eq!(args["chunk_chars"], 1200);
        assert_eq!(
            args["extensions"],
            serde_json::json!([".md", ".txt", ".pdf"])
        );

        let modern_ping = PingResult::from_tools(
            "2026-07-28".to_string(),
            crate::core::write_bridge::ProtocolEra::Modern,
            vec!["memos_store".to_string(), "memos_review".to_string()],
            None,
            None,
            None,
        );
        assert_eq!(
            PingResult::settings_footer_mode(false, Some(&modern_ping)),
            "View only"
        );
        assert_eq!(
            PingResult::settings_footer_mode(true, Some(&modern_ping)),
            "Write mode enabled (MCP 2026-07-28)"
        );
        assert_eq!(
            modern_ping.format_settings_status(),
            "Connected · MCP 2026-07-28 · 2 tools · review ✓"
        );
    }
}
