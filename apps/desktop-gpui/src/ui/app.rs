use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use gpui::{
    AccessibleAction, AnyElement, App, AppContext, Bounds, ClipboardItem, Context, Entity,
    FocusHandle, Focusable, FontWeight, Hsla, InteractiveElement, IntoElement, KeyBinding,
    KeyDownEvent, MouseButton, MouseDownEvent, ParentElement, PathPromptOptions, Render, Role,
    ScrollHandle, SharedString, StatefulInteractiveElement, Styled, Subscription, Task,
    TitlebarOptions, Window, WindowBackgroundAppearance, WindowBounds, WindowOptions, actions, div,
    point, prelude::FluentBuilder, px, rgb, rgba, size,
};

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
    AiContextPreview, BriefSnapshot, CONTEXT_PREVIEW_VIEW_LIMIT, ContextPreviewItem, DbOverview,
    DreamDiffEntry, DreamDiffKind, GraphMode, MemoryListItem, QueryFilter, RowDensity, SortOrder,
    ViewMode, WriterSchemaPreflight, describe_filter_target, extract_search_scopes,
    format_ai_context_payload, format_timestamp_ms, remove_last_search_scope, remove_search_scope,
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

const APP_BUILD_DATE: &str = env!("MEMOS_BUILD_DATE");

actions!(
    memos_app,
    [
        OpenPalette,
        FocusSearch,
        SwitchToList,
        SwitchToGraph,
        ToggleTheme
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

fn load_initial_snapshot_with_overview(
    store: &ReadOnlyStore,
    overview: DbOverview,
    filter: &QueryFilter,
) -> Result<InitialLoadResult, DbError> {
    let page = store.query_nodes_page(
        filter,
        &overview.contradiction_node_ids,
        None,
        crate::core::db::LIST_PAGE_SIZE,
    )?;
    let total_matching = if !page.has_more {
        page.items.len()
    } else if filter.is_empty() {
        overview.node_count
    } else {
        store.count_matching_nodes(filter)?.max(page.items.len())
    };
    let health = assess_store_health(store, &overview, now_unix_ms()).ok();
    Ok(InitialLoadResult {
        overview,
        items: page.items,
        next_cursor: page.next_cursor,
        has_more: page.has_more,
        total_matching,
        health,
    })
}

fn load_initial_snapshot_blocking(
    store: &ReadOnlyStore,
    filter: &QueryFilter,
) -> Result<InitialLoadResult, DbError> {
    let overview = store.load_overview()?;
    load_initial_snapshot_with_overview(store, overview, filter)
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

pub fn register_app_key_bindings(cx: &mut App) {
    register_input_key_bindings(cx);

    #[cfg(target_os = "macos")]
    cx.bind_keys([
        KeyBinding::new("cmd-k", OpenPalette, None),
        KeyBinding::new("cmd-f", FocusSearch, None),
        KeyBinding::new("cmd-1", SwitchToList, None),
        KeyBinding::new("cmd-2", SwitchToGraph, None),
    ]);

    #[cfg(not(target_os = "macos"))]
    cx.bind_keys([
        KeyBinding::new("ctrl-k", OpenPalette, None),
        KeyBinding::new("ctrl-f", FocusSearch, None),
        KeyBinding::new("ctrl-1", SwitchToList, None),
        KeyBinding::new("ctrl-2", SwitchToGraph, None),
    ]);
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
            cx.new(|cx| MemOSApp::new(db, st, tel, tl_win, options, window, cx))
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
    show_context_modal: bool,
    context_loading: bool,
    context_preview: Option<AiContextPreview>,
    context_scroll: ScrollHandle,
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
    _context_task: Option<Task<()>>,
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

impl MemOSApp {
    pub(crate) fn new(
        resolved_db: ResolvedDbPath,
        settings: AppSettings,
        telemetry: Arc<TelemetryHandle>,
        timeline: Arc<StartupTimeline>,
        options: LaunchOptions,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        init_icon_font_from_window(window);
        let theme = ThemePalette::resolve(settings.theme, window.appearance());
        sync_win32_titlebar(window, theme);
        let effective_no_fun = prefers_reduced_motion(options.no_fun);
        // Teach GPUI's animation layer the same policy as the logo/Momo easter
        // eggs so with_animation() renders static frames under reduced motion.
        cx.set_reduce_motion(effective_no_fun);
        let focus_handle = cx.focus_handle();
        let initial_view_mode = settings.last_view_mode.unwrap_or(settings.default_view);
        let mut initial_filter = QueryFilter::default();
        let mut initial_saved_view_id: Option<String> = None;
        if let Some(saved_id) = settings.last_saved_view_id.as_deref()
            && let Some(sv) = settings.saved_views.iter().find(|v| v.id == saved_id)
        {
            initial_filter = sv.resolved_filter(now_unix_ms());
            initial_saved_view_id = Some(sv.id.clone());
        }
        if settings.last_sort != SortOrder::Recency || initial_saved_view_id.is_none() {
            initial_filter.sort = settings.last_sort;
        }
        let search_input = cx.new(|cx| {
            let mut input =
                TextInput::new(cx, "Search memories", theme).with_leading_icon(UiIcon::Search);
            if !initial_filter.query.trim().is_empty() {
                input.set_text(initial_filter.query.clone(), cx);
            }
            input
        });
        let save_view_input = cx.new(|cx| TextInput::new(cx, "View name", theme));
        let writer_cmd_input = cx.new(|cx| {
            let mut input = TextInput::new(cx, DEFAULT_WRITER_COMMAND, theme);
            input.set_text(settings.effective_writer_command().to_string(), cx);
            input
        });
        let composer_content_input =
            cx.new(|cx| TextInput::new_multiline(cx, "Write durable memory content…", theme));
        let composer_tags_input = cx
            .new(|cx| TextInput::new(cx, "Comma-separated tags (e.g. auth, architecture)", theme));
        let composer_namespace_input = cx.new(|cx| {
            let mut input = TextInput::new(cx, "default", theme);
            input.set_text("default", cx);
            input
        });
        let composer_context_input =
            cx.new(|cx| TextInput::new(cx, "Optional situational context for retrieval", theme));
        let ingest_path_input =
            cx.new(|cx| TextInput::new(cx, "File or folder path to ingest…", theme));
        let ingest_namespace_input = cx.new(|cx| {
            let mut input = TextInput::new(cx, "default or documents", theme);
            input.set_text("documents", cx);
            input
        });
        let ingest_extensions_input = cx.new(|cx| {
            let mut input = TextInput::new(cx, "md,txt,html,pdf", theme);
            input.set_text("md,txt,html,pdf", cx);
            input
        });
        let ingest_chunk_input = cx.new(|cx| {
            let mut input = TextInput::new(cx, "1200 (optional)", theme);
            input.set_text("1200", cx);
            input
        });
        let write_bridge = Arc::new(WriteBridge::new(
            settings.effective_writer_command(),
            resolved_db.path.clone(),
        ));
        let sidebar = cx.new(|cx| {
            let mut v = SidebarView::new(settings.saved_views.clone(), theme);
            v.set_no_fun(effective_no_fun, cx);
            v.set_filter(initial_filter.clone(), cx);
            v.set_active_saved_view_id(initial_saved_view_id.clone(), cx);
            v
        });
        let initial_view_title = initial_saved_view_id
            .as_deref()
            .and_then(|id| settings.saved_views.iter().find(|v| v.id == id))
            .map(|sv| sv.name.clone())
            .or_else(|| Some("All memories".to_string()));
        let list_view = cx.new(|cx| {
            let mut v = MemoryListView::new(theme);
            v.set_no_fun(effective_no_fun, cx);
            v.set_row_density(settings.row_density, cx);
            v.set_active_view_name(initial_view_title, cx);
            v.set_filter(initial_filter.clone(), cx);
            v
        });
        let brief_view = cx.new(|_| BriefView::new(theme));
        let review_view = cx.new(|_| ReviewView::new(theme, settings.write_mode));
        let detail_view = cx.new(|cx| {
            let mut v = DetailView::new(theme);
            v.set_write_mode(settings.write_mode, cx);
            v
        });
        let graph_view = cx.new(|cx| {
            let mut v = GraphView::new(GraphMode::Namespace, theme);
            v.set_no_fun(effective_no_fun, cx);
            v.set_active_visible(initial_view_mode == ViewMode::Graph, cx);
            v
        });
        let palette = cx.new(|cx| {
            let mut p = CommandPalette::new(theme, window, cx);
            p.set_write_context(settings.write_mode, false, cx);
            p
        });

        let show_onboarding =
            !options.smoke_exit_after_first_frame && !settings.onboarding_completed;
        let mut subs = Vec::new();

        let onboarding = if show_onboarding {
            let ob = cx.new(|cx| {
                OnboardingView::new(resolved_db.path.clone(), settings.clone(), theme, cx)
            });
            subs.push(
                cx.subscribe_in(&ob, window, |this, _, event, window, cx| match event {
                    OnboardingEvent::Complete {
                        settings,
                        selected_db,
                    } => {
                        this.complete_onboarding(settings.clone(), selected_db.clone(), window, cx);
                    }
                    OnboardingEvent::ThemeChanged(mode) => {
                        this.settings.theme = *mode;
                        let resolved = ThemePalette::resolve(*mode, window.appearance());
                        this.apply_theme_palette(resolved, window, cx);
                    }
                }),
            );
            Some(ob)
        } else {
            None
        };
        subs.push(cx.subscribe_in(
            &search_input,
            window,
            |this, _, event, _window, cx| match event {
                InputEvent::Changed(query) => {
                    this.on_search_changed(query.clone(), cx);
                }
                InputEvent::Submit(query) => {
                    this.on_search_submit(query.clone(), cx);
                }
                InputEvent::Cancel => {
                    this.search_input.update(cx, |input, cx| input.clear(cx));
                }
                InputEvent::BackspaceWhenEmpty => {
                    this.remove_last_search_scope(cx);
                }
                InputEvent::MoveUp | InputEvent::MoveDown => {}
            },
        ));

        subs.push(
            cx.subscribe_in(&sidebar, window, |this, _, event, window, cx| {
                this.on_sidebar_event(event.clone(), window, cx);
            }),
        );

        subs.push(cx.subscribe_in(
            &brief_view,
            window,
            |this, _, event, _window, cx| match event {
                BriefEvent::OpenMemory(id) => this.select_memory(id.clone(), false, cx),
                BriefEvent::ViewAll(section) => this.open_brief_section_in_list(*section, cx),
                BriefEvent::ViewAllMemories => {
                    this.active_surface = WorkspaceSurface::Memories;
                    this.sidebar.update(cx, |s, cx| {
                        s.set_active_surface(SidebarSurface::Memories, cx)
                    });
                    this.switch_view(ViewMode::List, cx);
                    this.clear_filters(cx);
                }
            },
        ));

        subs.push(cx.subscribe_in(
            &review_view,
            window,
            |this, _, event, window, cx| match event {
                ReviewEvent::Refresh => this.refresh_review_view(cx),
                ReviewEvent::OpenMemory(id) => this.select_memory(id.clone(), false, cx),
                ReviewEvent::Approve(id) => this.execute_review_decision(id.clone(), true, cx),
                ReviewEvent::Reject(id) => this.execute_review_decision(id.clone(), false, cx),
                ReviewEvent::OpenSettings => this.open_settings_modal(window, cx),
            },
        ));

        for single_ingest in [
            &ingest_path_input,
            &ingest_namespace_input,
            &ingest_extensions_input,
            &ingest_chunk_input,
        ] {
            subs.push(
                cx.subscribe_in(
                    single_ingest,
                    window,
                    |this, _, event, window, cx| match event {
                        InputEvent::Submit(_) => this.submit_ingest(window, cx),
                        InputEvent::Cancel => {
                            this.show_ingest_modal = false;
                            window.focus(&this.focus_handle, cx);
                            cx.notify();
                        }
                        InputEvent::Changed(_) => {
                            if this.ingest_error.is_some() {
                                this.ingest_error = None;
                                cx.notify();
                            }
                        }
                        InputEvent::MoveUp
                        | InputEvent::MoveDown
                        | InputEvent::BackspaceWhenEmpty => {}
                    },
                ),
            );
        }

        subs.push(cx.subscribe_in(
            &list_view,
            window,
            |this, _, event, window, cx| match event {
                ListEvent::Select(id) => this.select_memory(id.clone(), false, cx),
                ListEvent::Highlight(id) => {
                    this.selected_id = Some(id.clone());
                    this.graph_view
                        .update(cx, |g, cx| g.set_selected(Some(id.clone()), false, cx));
                    this.palette.update(cx, |p, cx| {
                        p.set_write_context(this.settings.write_mode, true, cx)
                    });
                    if this.detail_open {
                        this.select_memory(id.clone(), false, cx);
                    } else {
                        cx.notify();
                    }
                }
                ListEvent::Hover(hovered_id) => {
                    this.sync_linked_hover(HoverOrigin::List, hovered_id.clone(), cx);
                }
                ListEvent::PopoverOpened => this.dismiss_popovers(PopoverOwner::List, cx),
                ListEvent::ApplyLiveUpdates { jump_to_newest } => {
                    if let Some(pending) = this.pending_live_reload.take() {
                        this.list_view
                            .update(cx, |l, cx| l.set_pending_new_count(None, cx));
                        this.apply_loaded_snapshot(
                            pending.result,
                            pending.stamp,
                            if *jump_to_newest {
                                pending.newest_id
                            } else {
                                None
                            },
                            cx,
                        );
                    } else {
                        this.list_view
                            .update(cx, |l, cx| l.set_pending_new_count(None, cx));
                        this.schedule_filtered_query(0, cx);
                    }
                }
                ListEvent::ToggleNamespace(ns) => {
                    toggle_opt_string(&mut this.filter.namespace, ns.clone());
                    this.mark_custom_filter_changed(cx);
                }
                ListEvent::ToggleType(ty) => {
                    toggle_opt_string(&mut this.filter.node_type, ty.clone());
                    this.mark_custom_filter_changed(cx);
                }
                ListEvent::ToggleProvenance(prov) => {
                    toggle_opt_string(&mut this.filter.provenance, prov.clone());
                    this.mark_custom_filter_changed(cx);
                }
                ListEvent::ToggleContradictions => {
                    this.filter.has_contradiction = !this.filter.has_contradiction;
                    this.mark_custom_filter_changed(cx);
                }
                ListEvent::SetSort(sort) => {
                    this.set_sort_order(*sort, cx);
                }
                ListEvent::ClearFilters => this.clear_filters(cx),
                ListEvent::RetryLoad => this.spawn_initial_load(cx),
                ListEvent::LoadNextPage => this.spawn_next_page_load(cx),
                ListEvent::CreateStore(path) => this.create_memory_store(path.clone(), cx),
                ListEvent::CopyInitCommand => {
                    cx.write_to_clipboard(ClipboardItem::new_string(CLI_INIT_COMMAND.to_string()));
                    this.set_notice("Copied init command", cx);
                }
                ListEvent::CopyStoreCommand => {
                    cx.write_to_clipboard(ClipboardItem::new_string(CLI_STORE_COMMAND.to_string()));
                    this.set_notice("Copied add command", cx);
                }
                ListEvent::OpenTools => this.open_harnesses_modal(window, cx),
                ListEvent::OpenHealth => this.open_health_modal_from_momo(window, cx),
            },
        ));

        subs.push(cx.subscribe_in(
            &detail_view,
            window,
            |this, _, event, window, cx| match event {
                DetailEvent::SelectMemory(id) => this.select_memory(id.clone(), true, cx),
                DetailEvent::RevealInGraph(id) => this.reveal_in_graph(id.clone(), cx),
                DetailEvent::PreviewContext => this.open_selected_context_modal(window, cx),
                DetailEvent::EditSelected => this.open_edit_memory_composer(window, cx),
                DetailEvent::ForgetSelected => this.open_forget_confirm(cx),
                DetailEvent::Close => this.close_detail(cx),
            },
        ));

        subs.push(
            cx.subscribe_in(
                &writer_cmd_input,
                window,
                |this, _, event, window, cx| match event {
                    InputEvent::Changed(cmd) => {
                        this.settings.writer_command = cmd.clone();
                        this.write_bridge.configure(
                            &this.settings.effective_writer_command(),
                            &this.resolved_db.path,
                        );
                        this.writer_test_status = None;
                        this.bounds_dirty = true;
                        cx.notify();
                    }
                    InputEvent::Submit(_) => {
                        this.settings.save_async();
                        this.bounds_dirty = false;
                        this.run_writer_ping(cx);
                    }
                    InputEvent::Cancel => {
                        window.focus(&this.focus_handle, cx);
                    }
                    InputEvent::MoveUp | InputEvent::MoveDown | InputEvent::BackspaceWhenEmpty => {}
                },
            ),
        );

        for single_input in [
            &composer_tags_input,
            &composer_namespace_input,
            &composer_context_input,
        ] {
            subs.push(cx.subscribe_in(
                single_input,
                window,
                |this, _, event, window, cx| match event {
                    InputEvent::Submit(_) => {
                        this.submit_composer(window, cx);
                    }
                    InputEvent::Cancel => {
                        this.show_composer_modal = false;
                        window.focus(&this.focus_handle, cx);
                        cx.notify();
                    }
                    InputEvent::Changed(_)
                    | InputEvent::MoveUp
                    | InputEvent::MoveDown
                    | InputEvent::BackspaceWhenEmpty => {}
                },
            ));
        }

        subs.push(cx.subscribe_in(
            &composer_content_input,
            window,
            |this, _, event, window, cx| match event {
                InputEvent::Changed(_) => {
                    if this.composer_validation_error.is_some() {
                        this.composer_validation_error = None;
                        cx.notify();
                    }
                }
                InputEvent::Cancel => {
                    this.show_composer_modal = false;
                    window.focus(&this.focus_handle, cx);
                    cx.notify();
                }
                InputEvent::Submit(_)
                | InputEvent::MoveUp
                | InputEvent::MoveDown
                | InputEvent::BackspaceWhenEmpty => {}
            },
        ));

        subs.push(cx.subscribe_in(
            &save_view_input,
            window,
            |this, _, event, window, cx| match event {
                InputEvent::Submit(_) => {
                    this.confirm_save_view(window, cx);
                }
                InputEvent::Cancel => {
                    this.show_save_view_modal = false;
                    window.focus(&this.focus_handle, cx);
                    cx.notify();
                }
                InputEvent::Changed(_)
                | InputEvent::MoveUp
                | InputEvent::MoveDown
                | InputEvent::BackspaceWhenEmpty => {}
            },
        ));

        subs.push(cx.observe_window_bounds(window, |this, window, cx| {
            this.list_view
                .update(cx, |list, cx| list.clear_hover_on_resize(cx));
            if this.smoke_exit_after_first_frame {
                return;
            }
            let next = window_bounds_to_setting(window.window_bounds());
            // Ignore transient/minimized frames: saving a zero or negative
            // size here used to reopen the app with corrupt bounds.
            if !next.width.is_finite()
                || !next.height.is_finite()
                || next.width < 320.0
                || next.height < 240.0
            {
                return;
            }
            if this.settings.window_bounds != Some(next) {
                this.settings.window_bounds = Some(next);
                this.bounds_dirty = true;
                this._bounds_save_task = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor()
                        .timer(Duration::from_millis(200))
                        .await;
                    let _ = this.update(cx, |app, _cx| {
                        if app.bounds_dirty {
                            app.bounds_dirty = false;
                            app.settings.save_async();
                        }
                    });
                }));
            }
        }));

        subs.push(cx.subscribe_in(
            &graph_view,
            window,
            |this, _, event, _window, cx| match event {
                GraphEvent::SwitchMode(mode) => {
                    this.graph_mode = *mode;
                    this.spawn_graph_load(cx);
                }
                GraphEvent::SelectMemory(id) => {
                    this.select_memory(id.clone(), true, cx);
                }
                GraphEvent::Hover(hovered_id) => {
                    this.sync_linked_hover(HoverOrigin::Graph, hovered_id.clone(), cx);
                }
                GraphEvent::PopoverOpened => this.dismiss_popovers(PopoverOwner::Graph, cx),
            },
        ));

        subs.push(
            cx.subscribe_in(&palette, window, |this, _, event, window, cx| match event {
                PaletteEvent::Execute(action) => {
                    this.execute_palette_action(action.clone(), window, cx)
                }
                PaletteEvent::Closed => {
                    if let Some(handle) = this.palette_return_focus.take() {
                        window.focus(&handle, cx);
                    } else {
                        window.focus(&this.focus_handle, cx);
                    }
                }
            }),
        );

        let show_consent_modal = !show_onboarding
            && !options.smoke_exit_after_first_frame
            && settings.crash_reporting_consent.is_none();
        let celebrate_100 = Celebrate100Tracker::new(settings.celebrated_100);
        let initial_stamp = db_file_stamp(&resolved_db.path);

        let mut app = Self {
            focus_handle: focus_handle.clone(),
            palette_return_focus: None,
            timeline,
            smoke_exit_after_first_frame: options.smoke_exit_after_first_frame,
            no_fun: effective_no_fun,
            first_frame_logged: false,
            first_frame_done: false,
            initial_load_done: show_onboarding,
            store_create_in_flight: false,
            store_optimize_in_flight: false,
            window_active: true,
            shared_store: SharedStore::new(),
            resolved_db,
            settings,
            telemetry,
            theme,
            overview: None,
            health_report: None,
            health_status: StoreHealthStatus::Empty,
            active_surface: WorkspaceSurface::Memories,
            view_mode: initial_view_mode,
            graph_mode: GraphMode::Namespace,
            filter: initial_filter,
            active_saved_view_id: initial_saved_view_id,
            today_count: 0,
            pending_review_count: 0,
            selected_id: None,
            detail_open: false,
            hovered_id: None,
            write_bridge,
            writer_preflight: WriterSchemaPreflight::default(),
            writer_testing: false,
            writer_test_status: None,
            write_in_flight: false,
            write_bridge_error: None,
            show_composer_modal: false,
            composer_editing_id: None,
            composer_type: "fact".to_string(),
            composer_pool: "event".to_string(),
            composer_validation_error: None,
            forget_confirm_target: None,
            show_ingest_modal: false,
            ingest_recursive: true,
            ingest_in_flight: false,
            ingest_result: None,
            ingest_error: None,
            harnesses: Vec::new(),
            selected_harness_ix: 0,
            harness_inspector: None,
            show_harnesses_modal: false,
            pending_connect_id: None,
            tools_advanced_open: false,
            show_settings_modal: false,
            settings_scroll: ScrollHandle::new(),
            show_health_modal: false,
            show_dream_diff_modal: false,
            show_shortcuts_modal: false,
            show_context_modal: false,
            context_loading: false,
            context_preview: None,
            context_scroll: ScrollHandle::new(),
            show_save_view_modal: false,
            save_view_input,
            health_filter: HealthPanelFilter::All,
            dream_diff_entries: Vec::new(),
            dream_diff_loading: false,
            dream_diff_filter: None,
            show_overflow_menu: false,
            show_consent_modal,
            compact_layout: false,
            momo_hovered: false,
            last_synced_titlebar_dark: None,
            status_notice: None,
            bounds_dirty: false,
            konami: KonamiDetector::new(),
            celebrate_100,
            celebrate_100_until: None,
            momo_peek: MomoPeekController::new(Instant::now()),
            momo_peek_sample: PeekSample::default(),
            last_db_stamp: initial_stamp,
            pending_live_reload: None,
            query_generation: Default::default(),
            page_generation: Default::default(),
            detail_generation: Default::default(),
            graph_generation: Default::default(),
            list_cursor: None,
            list_total_matching: 0,
            loading_next_page: false,
            search_input,
            writer_cmd_input,
            composer_content_input,
            composer_tags_input,
            composer_namespace_input,
            composer_context_input,
            ingest_path_input,
            ingest_namespace_input,
            ingest_extensions_input,
            ingest_chunk_input,
            sidebar,
            list_view,
            brief_view,
            review_view,
            detail_view,
            graph_view,
            palette,
            onboarding,
            _init_task: None,
            _optimize_task: None,
            _search_task: None,
            _next_page_task: None,
            _brief_task: None,
            _review_task: None,
            _ingest_task: None,
            _browse_ingest_task: None,
            _detail_task: None,
            _graph_task: None,
            _harness_task: None,
            _harness_detail_task: None,
            _diag_task: None,
            _dream_diff_task: None,
            _context_task: None,
            _bounds_save_task: None,
            _notice_task: None,
            _celebrate_task: None,
            _db_watch_task: None,
            _peek_watch_task: None,
            _peek_anim_task: None,
            _write_task: None,
            _writer_ping_task: None,
            _subscriptions: subs,
        };

        if !show_onboarding {
            app.spawn_initial_load(cx);
            window.focus(&focus_handle, cx);
        }
        if !options.smoke_exit_after_first_frame {
            app.start_db_watcher(cx);
            if !effective_no_fun {
                app.start_peek_watcher(cx);
            }
        }
        app
    }

    /// Create a fresh store at `path`, then reload as if it had always existed.
    ///
    /// This is the only write path in the desktop crate that is not gated on
    /// write mode: it touches a path that does not hold a store yet.
    fn create_memory_store(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        if self.store_create_in_flight {
            return;
        }
        self.store_create_in_flight = true;
        self.set_notice("Creating memory store…", cx);
        let create_path = path.clone();

        self._init_task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move { crate::core::store_init::create_store(&create_path) })
                .await;

            let _ = this.update(cx, |app, cx| {
                app.store_create_in_flight = false;
                match res {
                    Ok(()) => {
                        app.set_notice("Memory store created", cx);
                        app.spawn_initial_load(cx);
                        app.refresh_review_view(cx);
                    }
                    Err(err) => {
                        tracing::warn!(error = %err, "failed to create memory store");
                        app.set_notice(err.ui_summary(), cx);
                    }
                }
            });
        }));
    }

    /// Add missing read-path indexes. Explicit, non-destructive, idempotent.
    fn optimize_store(&mut self, cx: &mut Context<Self>) {
        if self.store_optimize_in_flight {
            return;
        }
        self.store_optimize_in_flight = true;
        self.set_notice("Optimising store…", cx);
        let path = self.resolved_db.path.clone();

        self._optimize_task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move { crate::core::store_optimize::optimize_store(&path) })
                .await;

            let _ = this.update(cx, |app, cx| {
                app.store_optimize_in_flight = false;
                match res {
                    Ok(report) => {
                        // The cached connection must reopen: indexes changed.
                        app.shared_store.invalidate();
                        app.set_notice(report.summary(), cx);
                        app.spawn_initial_load(cx);
                    }
                    Err(err) => {
                        tracing::warn!(error = %err, "store optimisation failed");
                        app.set_notice(err.ui_summary(), cx);
                    }
                }
            });
        }));
    }

    fn spawn_initial_load(&mut self, cx: &mut Context<Self>) {
        let db_path = self.resolved_db.path.clone();
        let filter = self.filter.clone();
        let timeline = self.timeline.clone();
        let shared = self.shared_store.clone();
        let record_startup = !self.initial_load_done;
        let fast_phase = record_startup;
        self.list_view.update(cx, |v, cx| v.set_loading(true, cx));

        // Phase one runs inside the same task, before the full load, so the
        // shared connection is free when it starts. It paints totals plus the
        // first page; facets, health and badges arrive in phase two.
        self._init_task = Some(cx.spawn(async move |this, cx| {
            let fast_applied = if fast_phase {
                let fast_db = db_path.clone();
                let fast_filter = filter.clone();
                let fast_shared = shared.clone();
                let fast_timeline = timeline.clone();
                let fast = cx
                    .background_executor()
                    .spawn(async move {
                        let db_open_start = Instant::now();
                        fast_shared.ensure_open(&fast_db)?;
                        fast_timeline.record_span("db_open", db_open_start, Instant::now());
                        fast_shared.with_store(&fast_db, |store| {
                            let (node_count, contradiction_ids) = store.load_list_fast_meta()?;
                            let overview =
                                DbOverview::fast(fast_db.clone(), node_count, contradiction_ids);
                            let list_start = Instant::now();
                            let page = store.query_nodes_page(
                                &fast_filter,
                                &overview.contradiction_node_ids,
                                None,
                                crate::core::db::LIST_PAGE_SIZE,
                            )?;
                            let total_matching = if !page.has_more {
                                page.items.len()
                            } else if fast_filter.is_empty() {
                                node_count
                            } else {
                                store
                                    .count_matching_nodes(&fast_filter)?
                                    .max(page.items.len())
                            };
                            Ok::<_, DbError>((overview, page, total_matching, list_start))
                        })
                    })
                    .await;

                let applied = this.update(cx, |app, cx| {
                    if app.initial_load_done {
                        return false;
                    }
                    if let Ok((overview, page, total_matching, list_start)) = fast {
                        timeline.record_span("first_list_page", list_start, Instant::now());
                        app.apply_fast_snapshot(overview, page, total_matching, cx);
                        true
                    } else {
                        false
                    }
                });
                matches!(applied, Ok(true))
            } else {
                false
            };

            let started = Instant::now();
            let result = cx
                .background_executor()
                .spawn(async move {
                    let db_open_start = Instant::now();
                    shared.ensure_open(&db_path)?;
                    if record_startup && !fast_applied {
                        timeline.record_span("db_open", db_open_start, Instant::now());
                    }

                    let phase = shared.with_store(&db_path, |store| {
                        let overview_start = Instant::now();
                        let overview = store.load_overview()?;
                        if record_startup {
                            timeline.record_span("overview", overview_start, Instant::now());
                        }
                        if fast_applied {
                            let health = assess_store_health(store, &overview, now_unix_ms()).ok();
                            Ok(PhaseTwo {
                                overview,
                                health,
                                full: None,
                            })
                        } else {
                            let list_start = Instant::now();
                            let loaded = load_initial_snapshot_with_overview(
                                store,
                                overview.clone(),
                                &filter,
                            )?;
                            Ok(PhaseTwo {
                                overview,
                                health: None,
                                full: Some((loaded, list_start)),
                            })
                        }
                    })?;
                    Ok::<PhaseTwo, DbError>(phase)
                })
                .await;

            let _ = this.update(cx, |app, cx| {
                let elapsed_ms = started.elapsed().as_secs_f32() * 1000.0;
                match result {
                    Ok(phase) => {
                        let overview = phase.overview;
                        tracing::info!(
                            nodes = overview.node_count,
                            edges = overview.edge_count,
                            elapsed_ms,
                            "database loaded read-only"
                        );
                        // In the fast path health comes from phase two; in the
                        // combined path it already rode along with the list.
                        let health = phase
                            .health
                            .or_else(|| phase.full.as_ref().and_then(|(l, _)| l.health.clone()));
                        app.apply_store_health_and_milestones(&overview, health, cx);
                        app.overview = Some(overview.clone());
                        app.last_db_stamp = db_file_stamp(&app.resolved_db.path);
                        app.sidebar
                            .update(cx, |s, cx| s.set_overview(Some(overview.clone()), cx));

                        if let Some((loaded, list_start)) = phase.full {
                            let total = overview.node_count;
                            let total_matching = loaded.total_matching;
                            app.list_cursor = loaded.next_cursor;
                            app.list_total_matching = total_matching;
                            app.loading_next_page = false;
                            app.page_generation.advance();
                            app._next_page_task = None;
                            app.list_view.update(cx, |list, cx| {
                                list.set_overview(Some(overview), cx);
                                list.set_items(
                                    loaded.items,
                                    !app.filter.is_empty(),
                                    total_matching,
                                    total,
                                    loaded.has_more,
                                    cx,
                                );
                                list.set_selected(None, false, cx);
                            });
                            app.selected_id = None;
                            app.detail_open = false;
                            app.detail_view.update(cx, |d, cx| d.set_detail(None, cx));
                            if record_startup {
                                app.timeline.record_span(
                                    "first_list_page",
                                    list_start,
                                    Instant::now(),
                                );
                            }
                        } else {
                            app.list_view
                                .update(cx, |list, cx| list.set_overview(Some(overview), cx));
                        }
                        app.spawn_brief_and_review_badges(cx);
                        if app.active_surface == WorkspaceSurface::Memories
                            && app.view_mode == ViewMode::Graph
                        {
                            app.spawn_graph_load(cx);
                        } else if app.active_surface == WorkspaceSurface::Review {
                            app.spawn_review_list_load(cx);
                        }
                    }
                    Err(DbError::NotFound) => {
                        tracing::info!(exists = false, elapsed_ms, "database file not found");
                        let path_str = app.resolved_db.path.display().to_string();
                        app.overview = None;
                        app.writer_preflight = WriterSchemaPreflight::default();
                        app.selected_id = None;
                        app.detail_open = false;
                        app.sidebar.update(cx, |s, cx| {
                            s.set_overview(None, cx);
                            s.set_health_report(None, cx);
                        });
                        app.list_view.update(cx, |list, cx| {
                            list.set_overview(None, cx);
                            list.set_missing_db(Some(path_str), cx);
                        });
                        app.detail_view.update(cx, |d, cx| d.set_detail(None, cx));
                    }
                    Err(err) => {
                        let safe_err = sanitize_db_error(&err, &app.resolved_db.path);
                        tracing::warn!(error = %safe_err, "failed to load database");
                        app.list_view
                            .update(cx, |list, cx| list.set_error(Some(safe_err), cx));
                    }
                }
                app.initial_load_done = true;
                let _ = app.timeline.write_report_if_configured();
                app.maybe_finish_startup_exit(cx);
            });
        }));
    }

    fn maybe_finish_startup_exit(&self, cx: &mut Context<Self>) {
        if !self.smoke_exit_after_first_frame || !self.first_frame_done {
            return;
        }
        if !self.timeline.has_report_path() || self.initial_load_done {
            let _ = self.timeline.write_report_if_configured();
            cx.quit();
        }
    }

    fn spawn_harness_detection(&mut self, cx: &mut Context<Self>) {
        self._harness_task = Some(cx.spawn(async move |this, cx| {
            let detected = cx
                .background_executor()
                .spawn(async move { harness::detect_all() })
                .await;

            let _ = this.update(cx, |app, cx| {
                let installed = detected.iter().filter(|h| h.installed).count();
                let total = detected.len();
                tracing::info!(
                    installed_harnesses = installed,
                    total_harnesses = total,
                    "read-only harness detection finished"
                );
                app.harnesses = detected;
                app.sidebar
                    .update(cx, |s, cx| s.set_harness_summary(installed, total, cx));
                if app.show_harnesses_modal && app.harness_inspector.is_none() {
                    app.spawn_harness_detail(app.selected_harness_ix, cx);
                }
                cx.notify();
            });
        }));
    }

    fn spawn_harness_detail(&mut self, ix: usize, cx: &mut Context<Self>) {
        self.selected_harness_ix = ix;
        self.pending_connect_id = None;
        self._harness_detail_task = Some(cx.spawn(async move |this, cx| {
            let details = cx
                .background_executor()
                .spawn(async move {
                    let adapters = harness::all_adapters();
                    adapters.get(ix).map(|adapter| HarnessInspectorData {
                        detection: adapter.detect(),
                        servers: adapter.mcp_servers(),
                        plan: adapter.plan_memos_install(),
                        reveal_path: adapter.reveal_target_path(),
                    })
                })
                .await;

            let _ = this.update(cx, |app, cx| {
                // The initial inspector request can finish after the user has
                // already selected another harness; never let a stale result
                // overwrite the current row.
                if app.selected_harness_ix == ix {
                    app.harness_inspector = details;
                    cx.notify();
                }
            });
        }));
    }

    fn current_view_title(&self) -> String {
        if let Some(active_id) = self.active_saved_view_id.as_deref()
            && let Some(sv) = self.settings.saved_views.iter().find(|v| v.id == active_id)
        {
            return sv.name.clone();
        }
        if self.filter.is_empty() {
            "All memories".to_string()
        } else {
            describe_filter_target(&self.filter)
        }
    }

    fn sync_active_view_name_to_list(&self, cx: &mut Context<Self>) {
        let title = self.current_view_title();
        self.list_view
            .update(cx, |l, cx| l.set_active_view_name(Some(title), cx));
    }

    fn sync_filter_to_views(&self, cx: &mut Context<Self>) {
        let f = self.filter.clone();
        self.sidebar.update(cx, |s, cx| s.set_filter(f.clone(), cx));
        let title = self.current_view_title();
        self.list_view.update(cx, |l, cx| {
            l.set_active_view_name(Some(title), cx);
            l.set_filter(f, cx);
        });
    }

    fn apply_filter_update(&mut self, cx: &mut Context<Self>) {
        self.pending_live_reload = None;
        self.list_cursor = None;
        self.loading_next_page = false;
        self.page_generation.advance();
        self._next_page_task = None;
        self.list_view.update(cx, |l, cx| {
            l.set_pending_new_count(None, cx);
            l.scroll_to_top(cx);
        });
        self.sync_filter_to_views(cx);
        self.schedule_filtered_query(0, cx);
    }

    fn on_search_changed(&mut self, query: String, cx: &mut Context<Self>) {
        self.pending_live_reload = None;
        self.list_view
            .update(cx, |l, cx| l.set_pending_new_count(None, cx));
        let parsed = extract_search_scopes(&query, &mut self.filter, now_unix_ms(), false);
        let effective_query = if parsed.applied_any {
            self.search_input
                .update(cx, |i, cx| i.set_text(parsed.remaining_input.clone(), cx));
            parsed.remaining_input
        } else {
            query
        };
        self.filter.query = effective_query.clone();
        telemetry::set_active_query(&effective_query);
        self.sync_filter_to_views(cx);
        self.schedule_filtered_query(if parsed.applied_any { 0 } else { 120 }, cx);
    }

    fn on_search_submit(&mut self, query: String, cx: &mut Context<Self>) {
        let parsed = extract_search_scopes(&query, &mut self.filter, now_unix_ms(), true);
        let effective_query = if parsed.applied_any {
            self.search_input
                .update(cx, |i, cx| i.set_text(parsed.remaining_input.clone(), cx));
            parsed.remaining_input
        } else {
            query
        };
        self.filter.query = effective_query.clone();
        telemetry::set_active_query(&effective_query);
        self.apply_filter_update(cx);
    }

    fn remove_search_scope_chip(
        &mut self,
        kind: crate::core::model::SearchScopeKind,
        cx: &mut Context<Self>,
    ) {
        if remove_search_scope(&mut self.filter, kind) {
            self.mark_custom_filter_changed(cx);
        }
    }

    fn remove_last_search_scope(&mut self, cx: &mut Context<Self>) {
        if remove_last_search_scope(&mut self.filter).is_some() {
            self.mark_custom_filter_changed(cx);
        }
    }

    fn schedule_filtered_query(&mut self, debounce_ms: u64, cx: &mut Context<Self>) {
        self.page_generation.advance();
        self.list_cursor = None;
        self.loading_next_page = false;
        self._next_page_task = None;
        let request_gen = self.query_generation.advance();
        let db_path = self.resolved_db.path.clone();
        let filter = self.filter.clone();
        let overview_clone = self.overview.clone();
        let shared = self.shared_store.clone();
        self.list_view.update(cx, |l, cx| l.set_loading(true, cx));

        self._search_task =
            Some(cx.spawn(async move |this, cx| {
                if debounce_ms > 0 {
                    cx.background_executor()
                        .timer(Duration::from_millis(debounce_ms))
                        .await;
                }

                let started = Instant::now();
                let result =
                    cx.background_executor()
                        .spawn(async move {
                            shared.with_store(&db_path, |store| {
                                let overview = match overview_clone {
                                    Some(ov) => ov,
                                    None => store.load_overview()?,
                                };
                                let page = store.query_nodes_page(
                                    &filter,
                                    &overview.contradiction_node_ids,
                                    None,
                                    crate::core::db::LIST_PAGE_SIZE,
                                )?;
                                let total_matching = if !page.has_more {
                                    page.items.len()
                                } else if filter.is_empty() {
                                    overview.node_count
                                } else {
                                    store.count_matching_nodes(&filter)?.max(page.items.len())
                                };
                                Ok::<(DbOverview, crate::core::db::ListPageResult, usize), DbError>(
                                    (overview, page, total_matching),
                                )
                            })
                        })
                        .await;

                let _ = this.update(cx, |app, cx| {
                    if !app.query_generation.is_current(request_gen) {
                        return;
                    }
                    let elapsed_ms = started.elapsed().as_secs_f32() * 1000.0;
                    match result {
                        Ok((ov, page, total_matching)) => {
                            tracing::info!(
                                results = page.items.len(),
                                total_matching,
                                has_more = page.has_more,
                                elapsed_ms,
                                has_query = !app.filter.query.trim().is_empty(),
                                "filtered query complete"
                            );
                            let total = ov.node_count;
                            let selected_still_present = app
                                .selected_id
                                .as_deref()
                                .is_some_and(|sel| page.items.iter().any(|it| it.id == sel));
                            app.list_cursor = page.next_cursor;
                            app.list_total_matching = total_matching;
                            app.loading_next_page = false;
                            app.list_view.update(cx, |list, cx| {
                                list.set_items(
                                    page.items,
                                    !app.filter.is_empty(),
                                    total_matching,
                                    total,
                                    page.has_more,
                                    cx,
                                );
                            });
                            if !selected_still_present {
                                app.selected_id = None;
                                app.detail_open = false;
                                app.list_view
                                    .update(cx, |list, cx| list.set_selected(None, false, cx));
                                app.graph_view
                                    .update(cx, |graph, cx| graph.set_selected(None, false, cx));
                                app.detail_view.update(cx, |d, cx| d.set_detail(None, cx));
                            }
                            if app.view_mode == ViewMode::Graph {
                                app.spawn_graph_load(cx);
                            }
                        }
                        Err(DbError::NotFound) => {
                            let path_str = app.resolved_db.path.display().to_string();
                            app.list_view
                                .update(cx, |list, cx| list.set_missing_db(Some(path_str), cx));
                        }
                        Err(err) => {
                            let msg = sanitize_db_error(&err, &app.resolved_db.path);
                            app.list_view
                                .update(cx, |list, cx| list.set_error(Some(msg), cx));
                        }
                    }
                });
            }));
    }

    fn spawn_next_page_load(&mut self, cx: &mut Context<Self>) {
        if self.loading_next_page {
            return;
        }
        let Some(cursor) = self.list_cursor.clone() else {
            self.list_view
                .update(cx, |list, cx| list.cancel_loading_more(cx));
            return;
        };
        self.loading_next_page = true;
        self.page_generation.advance();
        let request_gen = self.page_generation.current();
        let query_gen = self.query_generation.current();
        let db_path = self.resolved_db.path.clone();
        let filter = self.filter.clone();
        let contradiction_ids = self
            .overview
            .as_ref()
            .map(|o| o.contradiction_node_ids.clone())
            .unwrap_or_default();
        let shared = self.shared_store.clone();

        self._next_page_task = Some(cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    shared.with_store(&db_path, |store| {
                        store.query_nodes_page(
                            &filter,
                            &contradiction_ids,
                            Some(&cursor),
                            LIST_NEXT_PAGE_SIZE,
                        )
                    })
                })
                .await;

            let _ = this.update(cx, |app, cx| {
                if !app.page_generation.is_current(request_gen)
                    || !app.query_generation.is_current(query_gen)
                {
                    return;
                }
                app.loading_next_page = false;
                match result {
                    Ok(page) => {
                        app.list_cursor = page.next_cursor;
                        let total_matching = app.list_total_matching;
                        app.list_view.update(cx, |list, cx| {
                            list.append_page(page.items, page.has_more, total_matching, cx);
                        });
                    }
                    Err(err) => {
                        tracing::warn!(error = %err, "failed to load next memory list page");
                        app.list_view
                            .update(cx, |list, cx| list.cancel_loading_more(cx));
                    }
                }
            });
        }));
    }

    fn close_detail(&mut self, cx: &mut Context<Self>) {
        self.detail_open = false;
        self.selected_id = None;
        self.detail_generation.advance();
        self._detail_task = None;
        self.list_view
            .update(cx, |list, cx| list.set_selected(None, false, cx));
        self.graph_view
            .update(cx, |graph, cx| graph.set_selected(None, false, cx));
        self.detail_view.update(cx, |d, cx| d.set_detail(None, cx));
        let write_mode = self.settings.write_mode;
        self.palette
            .update(cx, |p, cx| p.set_write_context(write_mode, false, cx));
        cx.notify();
    }

    fn select_memory(&mut self, id: String, scroll_list: bool, cx: &mut Context<Self>) {
        self.selected_id = Some(id.clone());
        self.detail_open = true;
        let write_mode = self.settings.write_mode;
        self.palette
            .update(cx, |p, cx| p.set_write_context(write_mode, true, cx));
        self.list_view.update(cx, |list, cx| {
            list.set_selected(Some(id.clone()), scroll_list, cx)
        });
        self.graph_view.update(cx, |graph, cx| {
            graph.set_selected(Some(id.clone()), false, cx)
        });

        let request_gen = self.detail_generation.advance();
        let db_path = self.resolved_db.path.clone();
        let shared = self.shared_store.clone();
        self.detail_view.update(cx, |d, cx| d.set_loading(true, cx));

        self._detail_task = Some(cx.spawn(async move |this, cx| {
            let detail_res = cx
                .background_executor()
                .spawn(
                    async move { shared.with_store(&db_path, |store| store.load_node_detail(&id)) },
                )
                .await;

            let _ = this.update(cx, |app, cx| {
                if !app.detail_generation.is_current(request_gen) {
                    return;
                }
                match detail_res {
                    Ok(Some(detail)) => {
                        telemetry::register_sensitive_text(&detail.content);
                        if !detail.summary.is_empty() {
                            telemetry::register_sensitive_text(&detail.summary);
                        }
                        app.detail_view
                            .update(cx, |d, cx| d.set_detail(Some(detail), cx));
                    }
                    Ok(None) => {
                        app.detail_view.update(cx, |d, cx| d.set_detail(None, cx));
                    }
                    Err(err) => {
                        let msg = sanitize_db_error(&err, &app.resolved_db.path);
                        app.detail_view
                            .update(cx, |d, cx| d.set_error(Some(msg), cx));
                    }
                }
            });
        }));
    }

    fn spawn_graph_load(&mut self, cx: &mut Context<Self>) {
        let request_gen = self.graph_generation.advance();
        let db_path = self.resolved_db.path.clone();
        let mode = self.graph_mode;
        let filter = self.filter.clone();
        let overview_clone = self.overview.clone();
        let shared = self.shared_store.clone();

        self.graph_view.update(cx, |g, cx| {
            g.set_mode(mode, cx);
            g.set_loading(true, cx);
        });

        self._graph_task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move {
                    shared.with_store(&db_path, |store| {
                        let overview = match overview_clone {
                            Some(ov) => ov,
                            None => store.load_overview()?,
                        };
                        store.load_graph_snapshot(
                            mode,
                            &filter,
                            &overview.contradiction_node_ids,
                            DEFAULT_GRAPH_NODE_CAP,
                        )
                    })
                })
                .await;

            let _ = this.update(cx, |app, cx| {
                if !app.graph_generation.is_current(request_gen) {
                    return;
                }
                match res {
                    Ok(snapshot) => {
                        app.graph_view
                            .update(cx, |g, cx| g.apply_snapshot(snapshot, cx));
                    }
                    Err(err) => {
                        let msg = sanitize_db_error(&err, &app.resolved_db.path);
                        app.graph_view
                            .update(cx, |g, cx| g.set_error(Some(msg), cx));
                    }
                }
            });
        }));
    }

    fn switch_view(&mut self, mode: ViewMode, cx: &mut Context<Self>) {
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.active_surface = WorkspaceSurface::Memories;
        self.sidebar.update(cx, |s, cx| {
            s.set_active_surface(SidebarSurface::Memories, cx)
        });
        self.graph_view.update(cx, |g, cx| {
            g.set_active_visible(mode == ViewMode::Graph, cx)
        });
        if self.view_mode == mode {
            cx.notify();
            return;
        }
        self.view_mode = mode;
        self.settings.last_view_mode = Some(mode);
        if !self.smoke_exit_after_first_frame {
            self.settings.save_async();
        }
        if mode == ViewMode::Graph {
            self.detail_open = false;
            // Keep the memory the user was reading in focus instead of
            // dumping the whole store at Fit.
            if let Some(id) = self.selected_id.clone() {
                self.graph_view
                    .update(cx, |g, cx| g.set_selected(Some(id), true, cx));
            }
            self.spawn_graph_load(cx);
        }
        cx.notify();
    }

    fn set_sort_order(&mut self, sort: SortOrder, cx: &mut Context<Self>) {
        self.filter.sort = sort;
        self.settings.last_sort = sort;
        if let Some(id) = self.active_saved_view_id.as_deref()
            && let Some(sv) = self.settings.saved_views.iter().find(|v| v.id == id)
            && sv.filter.sort != sort
        {
            self.active_saved_view_id = None;
            self.settings.last_saved_view_id = None;
            self.sidebar
                .update(cx, |s, cx| s.set_active_saved_view_id(None, cx));
        }
        if !self.smoke_exit_after_first_frame {
            self.settings.save_async();
        }
        self.apply_filter_update(cx);
    }

    fn mark_custom_filter_changed(&mut self, cx: &mut Context<Self>) {
        let next_id = if self.filter.is_empty() {
            Some("all".to_string())
        } else {
            None
        };
        if self.active_saved_view_id != next_id {
            self.active_saved_view_id = next_id.clone();
            self.settings.last_saved_view_id = next_id.clone();
            self.sidebar
                .update(cx, |s, cx| s.set_active_saved_view_id(next_id, cx));
        }
        self.apply_filter_update(cx);
    }

    fn reveal_in_graph(&mut self, id: String, cx: &mut Context<Self>) {
        self.selected_id = Some(id.clone());
        self.detail_open = true;
        self.active_surface = WorkspaceSurface::Memories;
        self.sidebar.update(cx, |s, cx| {
            s.set_active_surface(SidebarSurface::Memories, cx)
        });
        let need_load = self.view_mode != ViewMode::Graph;
        self.view_mode = ViewMode::Graph;
        self.settings.last_view_mode = Some(ViewMode::Graph);
        if !self.smoke_exit_after_first_frame {
            self.settings.save_async();
        }
        self.graph_view.update(cx, |g, cx| {
            g.set_active_visible(true, cx);
            g.set_selected(Some(id), true, cx);
        });
        if need_load {
            self.spawn_graph_load(cx);
        }
        cx.notify();
    }

    fn on_sidebar_event(
        &mut self,
        event: SidebarEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            SidebarEvent::SelectSavedView {
                id,
                built_in,
                filter,
            } => {
                let mut filter = *filter;
                if built_in {
                    filter.query = self.filter.query.clone();
                } else {
                    self.search_input
                        .update(cx, |i, cx| i.set_text(filter.query.clone(), cx));
                    telemetry::set_active_query(&filter.query);
                }
                self.active_surface = WorkspaceSurface::Memories;
                self.filter = filter;
                self.active_saved_view_id = Some(id.clone());
                self.settings.last_saved_view_id = Some(id.clone());
                self.settings.last_sort = self.filter.sort;
                if !self.smoke_exit_after_first_frame {
                    self.settings.save_async();
                }
                self.sidebar.update(cx, |s, cx| {
                    s.set_active_surface(SidebarSurface::Memories, cx);
                    s.set_active_saved_view_id(Some(id), cx);
                });
            }
            SidebarEvent::SelectToday => {
                self.open_today_view(cx);
                return;
            }
            SidebarEvent::SelectReview => {
                self.open_review_view(cx);
                return;
            }
            SidebarEvent::ToggleTag(tag) => {
                self.active_surface = WorkspaceSurface::Memories;
                self.sidebar.update(cx, |s, cx| {
                    s.set_active_surface(SidebarSurface::Memories, cx)
                });
                toggle_opt_string(&mut self.filter.tag, tag);
                self.mark_custom_filter_changed(cx);
                return;
            }
            SidebarEvent::ClearFilters => {
                self.active_surface = WorkspaceSurface::Memories;
                self.sidebar.update(cx, |s, cx| {
                    s.set_active_surface(SidebarSurface::Memories, cx)
                });
                self.clear_filters(cx);
                return;
            }
            SidebarEvent::OpenHarnesses => {
                self.open_harnesses_modal(window, cx);
                return;
            }
            SidebarEvent::OpenHealth => {
                self.open_health_modal(HealthPanelFilter::All, window, cx);
                return;
            }
        }
        self.apply_filter_update(cx);
    }

    fn clear_filters(&mut self, cx: &mut Context<Self>) {
        let sort = self.filter.sort;
        self.filter = QueryFilter {
            sort,
            ..Default::default()
        };
        self.active_saved_view_id = Some("all".to_string());
        self.settings.last_saved_view_id = Some("all".to_string());
        if !self.smoke_exit_after_first_frame {
            self.settings.save_async();
        }
        self.sidebar.update(cx, |s, cx| {
            s.set_active_saved_view_id(Some("all".to_string()), cx)
        });
        telemetry::set_active_query("");
        self.search_input.update(cx, |i, cx| i.set_text("", cx));
        self.apply_filter_update(cx);
    }

    fn apply_theme_palette(
        &mut self,
        theme: ThemePalette,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        self.theme = theme;
        sync_win32_titlebar(window, theme);
        self.last_synced_titlebar_dark = Some(theme.is_dark);
        self.search_input.update(cx, |v, cx| v.set_theme(theme, cx));
        self.save_view_input
            .update(cx, |v, cx| v.set_theme(theme, cx));
        self.writer_cmd_input
            .update(cx, |v, cx| v.set_theme(theme, cx));
        self.composer_content_input
            .update(cx, |v, cx| v.set_theme(theme, cx));
        self.composer_tags_input
            .update(cx, |v, cx| v.set_theme(theme, cx));
        self.composer_namespace_input
            .update(cx, |v, cx| v.set_theme(theme, cx));
        self.composer_context_input
            .update(cx, |v, cx| v.set_theme(theme, cx));
        self.ingest_path_input
            .update(cx, |v, cx| v.set_theme(theme, cx));
        self.ingest_namespace_input
            .update(cx, |v, cx| v.set_theme(theme, cx));
        self.ingest_extensions_input
            .update(cx, |v, cx| v.set_theme(theme, cx));
        self.ingest_chunk_input
            .update(cx, |v, cx| v.set_theme(theme, cx));
        self.sidebar.update(cx, |v, cx| v.set_theme(theme, cx));
        self.list_view.update(cx, |v, cx| v.set_theme(theme, cx));
        self.brief_view.update(cx, |v, cx| v.set_theme(theme, cx));
        self.review_view.update(cx, |v, cx| v.set_theme(theme, cx));
        self.detail_view.update(cx, |v, cx| v.set_theme(theme, cx));
        self.graph_view.update(cx, |v, cx| v.set_theme(theme, cx));
        self.palette.update(cx, |v, cx| v.set_theme(theme, cx));
        if let Some(onboarding) = &self.onboarding {
            onboarding.update(cx, |v, cx| v.set_theme(theme, cx));
        }
        cx.notify();
    }

    fn toggle_theme(&mut self, window: &Window, cx: &mut Context<Self>) {
        self.settings.theme = self.settings.theme.toggle_from_dark(self.theme.is_dark);
        self.settings.save_async();
        let resolved = ThemePalette::resolve(self.settings.theme, window.appearance());
        self.apply_theme_palette(resolved, window, cx);
    }

    fn complete_onboarding(
        &mut self,
        next_settings: AppSettings,
        selected_db: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.settings = next_settings;
        self.telemetry.sync_sentry_from_settings(&self.settings);
        self.show_consent_modal = false;
        if selected_db != self.resolved_db.path {
            self.resolved_db = ResolvedDbPath {
                path: selected_db,
                source: DbPathSource::SavedPreference,
            };
        }
        let writer_cmd = self.settings.effective_writer_command().to_string();
        self.write_bridge
            .configure(&writer_cmd, &self.resolved_db.path);
        self.writer_cmd_input
            .update(cx, |v, cx| v.set_text(writer_cmd, cx));
        self.sync_write_mode_to_views(cx);
        self.view_mode = self.settings.default_view;
        let resolved_theme = ThemePalette::resolve(self.settings.theme, window.appearance());
        self.onboarding = None;
        self.apply_theme_palette(resolved_theme, window, cx);
        self.spawn_initial_load(cx);
        self.spawn_harness_detection(cx);
        window.focus(&self.focus_handle, cx);
    }

    fn set_crash_consent(&mut self, opt_in: bool, cx: &mut Context<Self>) {
        self.settings.crash_reporting_consent = Some(opt_in);
        self.show_consent_modal = false;
        self.telemetry.sync_sentry_from_settings(&self.settings);
        self.settings.save_async();
        self.set_notice(
            if opt_in {
                if telemetry::resolve_dsn().is_some() {
                    "Crash reporting enabled (scrubbed Sentry + local)"
                } else {
                    "Crash reporting opted in (local-only, no DSN configured)"
                }
            } else {
                "Crash reporting kept off (local crash logs active)"
            },
            cx,
        );
        cx.notify();
    }

    fn dismiss_popovers(&mut self, keep: PopoverOwner, cx: &mut Context<Self>) {
        if keep != PopoverOwner::Overflow && self.show_overflow_menu {
            self.show_overflow_menu = false;
            cx.notify();
        }
        if keep != PopoverOwner::List {
            self.list_view.update(cx, |l, cx| l.close_popovers(cx));
        }
        if keep != PopoverOwner::Graph {
            self.graph_view.update(cx, |g, cx| g.close_popovers(cx));
        }
    }

    fn has_any_popover_open(&self, cx: &App) -> bool {
        self.show_overflow_menu
            || self.list_view.read(cx).has_open_popover()
            || self.graph_view.read(cx).has_open_popover()
    }

    fn close_all_modals(&mut self) {
        if self.show_settings_modal {
            self.flush_dirty_settings();
        }
        self.show_harnesses_modal = false;
        self.pending_connect_id = None;
        self.show_settings_modal = false;
        self.show_health_modal = false;
        self.show_dream_diff_modal = false;
        self.show_shortcuts_modal = false;
        self.show_context_modal = false;
        self.show_save_view_modal = false;
        self.show_composer_modal = false;
        self.forget_confirm_target = None;
        self.show_ingest_modal = false;
        self.show_consent_modal = false;
    }

    fn open_harnesses_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.close_all_modals();
        self.show_harnesses_modal = true;
        if self.harnesses.is_empty() {
            self.spawn_harness_detection(cx);
        }
        self.spawn_harness_detail(self.selected_harness_ix, cx);
        window.focus(&self.focus_handle, cx);
        cx.notify();
    }

    fn open_settings_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.close_all_modals();
        let writer_cmd = self.settings.effective_writer_command().to_string();
        if self.writer_cmd_input.read(cx).text() != writer_cmd {
            self.writer_cmd_input
                .update(cx, |v, cx| v.set_text(writer_cmd, cx));
        }
        self.show_settings_modal = true;
        window.focus(&self.focus_handle, cx);
        cx.notify();
    }

    fn open_health_modal_from_momo(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_health_modal(self.health_status.default_panel_filter(), window, cx);
    }

    fn open_health_modal(
        &mut self,
        filter: HealthPanelFilter,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.close_all_modals();
        self.health_filter = filter;
        self.show_health_modal = true;
        self._peek_anim_task = None;
        self.momo_peek_sample = PeekSample::default();
        window.focus(&self.focus_handle, cx);
        cx.notify();
    }

    fn open_dream_diff_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.close_all_modals();
        self.show_dream_diff_modal = true;
        self.dream_diff_loading = true;
        window.focus(&self.focus_handle, cx);
        cx.notify();

        let db_path = self.resolved_db.path.clone();
        let shared = self.shared_store.clone();
        self._dream_diff_task = Some(cx.spawn(async move |this, cx| {
            let loaded = cx
                .background_executor()
                .spawn(
                    async move { shared.with_store(&db_path, |store| store.load_dream_diff(120)) },
                )
                .await;
            let _ = this.update(cx, |app, cx| {
                app.dream_diff_loading = false;
                match loaded {
                    Ok(entries) => {
                        app.dream_diff_entries = entries;
                    }
                    Err(err) => {
                        app.dream_diff_entries.clear();
                        app.set_notice(sanitize_db_error(&err, &app.resolved_db.path), cx);
                    }
                }
                cx.notify();
            });
        }));
    }

    fn open_shortcuts_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.close_all_modals();
        self.show_shortcuts_modal = true;
        window.focus(&self.focus_handle, cx);
        cx.notify();
    }

    fn open_selected_context_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(detail) = self.detail_view.read(cx).detail().cloned() else {
            return;
        };
        let item = ContextPreviewItem {
            short_id: detail.short_id.to_string(),
            node_type: detail.node_type,
            namespace: detail.namespace,
            content: detail.content,
            summary: detail.summary,
        };
        let preview = format_ai_context_payload(&[item], 1, "Selected memory");
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.close_all_modals();
        self.context_loading = false;
        self.context_preview = Some(preview);
        self.context_scroll.set_offset(point(px(0.), px(0.)));
        self.show_context_modal = true;
        window.focus(&self.focus_handle, cx);
        cx.notify();
    }

    fn open_view_context_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.close_all_modals();
        self.context_loading = true;
        self.context_preview = None;
        self.context_scroll.set_offset(point(px(0.), px(0.)));
        self.show_context_modal = true;
        window.focus(&self.focus_handle, cx);
        cx.notify();

        let db_path = self.resolved_db.path.clone();
        let filter = self.filter.clone();
        let overview_clone = self.overview.clone();
        let shared = self.shared_store.clone();
        self._context_task = Some(cx.spawn(async move |this, cx| {
            let loaded = cx
                .background_executor()
                .spawn(async move {
                    shared.with_store(&db_path, |store| {
                        let overview = match overview_clone {
                            Some(ov) => ov,
                            None => store.load_overview()?,
                        };
                        let (items, total) = store.load_context_items_for_filter(
                            &filter,
                            &overview.contradiction_node_ids,
                            CONTEXT_PREVIEW_VIEW_LIMIT,
                        )?;
                        let subtitle = describe_filter_target(&filter);
                        Ok::<AiContextPreview, DbError>(format_ai_context_payload(
                            &items, total, subtitle,
                        ))
                    })
                })
                .await;

            let _ = this.update(cx, |app, cx| {
                app.context_loading = false;
                match loaded {
                    Ok(preview) => {
                        app.context_preview = Some(preview);
                    }
                    Err(err) => {
                        app.show_context_modal = false;
                        app.set_notice(sanitize_db_error(&err, &app.resolved_db.path), cx);
                    }
                }
                cx.notify();
            });
        }));
    }

    fn open_save_view_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.close_all_modals();
        let suggested = self.settings.suggested_view_name(&self.filter);
        self.save_view_input
            .update(cx, |input, cx| input.set_text(suggested, cx));
        self.show_save_view_modal = true;
        let handle = self.save_view_input.focus_handle(cx);
        window.focus(&handle, cx);
        cx.notify();
    }

    fn confirm_save_view(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let raw = self.save_view_input.read(cx).text().to_string();
        let view = self
            .settings
            .add_custom_saved_view(&raw, self.filter.clone());
        let saved_id = view.id.clone();
        let saved_name = view.name.clone();
        self.active_saved_view_id = Some(saved_id.clone());
        self.settings.last_saved_view_id = Some(saved_id.clone());
        self.settings.last_sort = self.filter.sort;
        self.settings.save_async();
        let updated_views = self.settings.saved_views.clone();
        self.sidebar.update(cx, |s, cx| {
            s.set_saved_views(updated_views, cx);
            s.set_active_saved_view_id(Some(saved_id), cx);
        });
        self.sync_active_view_name_to_list(cx);
        self.show_save_view_modal = false;
        window.focus(&self.focus_handle, cx);
        self.set_notice(format!("Saved view \"{saved_name}\""), cx);
    }

    fn delete_saved_view(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(existing_name) = self
            .settings
            .saved_views
            .iter()
            .find(|v| v.id == id && !v.built_in)
            .map(|v| v.name.clone())
        else {
            return;
        };
        let was_active = self.active_saved_view_id.as_deref() == Some(id);
        if self.settings.remove_custom_saved_view(id) {
            self.settings.save_async();
            let updated_views = self.settings.saved_views.clone();
            let next_active = self.settings.last_saved_view_id.clone();
            self.active_saved_view_id = next_active.clone();
            self.sidebar.update(cx, |s, cx| {
                s.set_saved_views(updated_views, cx);
                s.set_active_saved_view_id(next_active, cx);
            });
            if was_active {
                self.clear_filters(cx);
            } else {
                self.sync_active_view_name_to_list(cx);
            }
            self.set_notice(format!("Deleted saved view \"{existing_name}\""), cx);
        }
    }

    fn apply_writer_preflight(&mut self, preflight: WriterSchemaPreflight, cx: &mut Context<Self>) {
        self.writer_preflight = preflight.clone();
        if !preflight.compatible && self.settings.write_mode {
            self.settings.write_mode = false;
            self.bounds_dirty = false;
            self.settings.save_async();
            self.sync_write_mode_to_views(cx);
            if let Some(msg) = preflight.human_message() {
                self.set_notice(msg, cx);
            }
        }
    }

    fn apply_store_health_and_milestones(
        &mut self,
        overview: &DbOverview,
        health: Option<StoreHealthReport>,
        cx: &mut Context<Self>,
    ) {
        self.apply_writer_preflight(overview.writer_preflight.clone(), cx);
        let status = health
            .as_ref()
            .map(|h| h.status)
            .unwrap_or(if overview.node_count == 0 {
                StoreHealthStatus::Empty
            } else if overview.contradiction_count > 0 {
                StoreHealthStatus::Contradictions
            } else {
                StoreHealthStatus::Healthy
            });
        self.health_report = health.clone();
        self.health_status = status;
        self.sidebar.update(cx, |s, cx| {
            s.set_health_status(status, cx);
            s.set_health_report(health.as_ref(), cx);
        });
        self.list_view
            .update(cx, |l, cx| l.set_health_status(status, cx));

        match self
            .celebrate_100
            .observe_count(overview.node_count, self.no_fun)
        {
            Celebrate100Outcome::None => {}
            Celebrate100Outcome::PersistOnly => {
                self.settings.celebrated_100 = true;
                self.settings.save_async();
            }
            Celebrate100Outcome::AnimateAndPersist => {
                self.settings.celebrated_100 = true;
                self.settings.save_async();
                if !cx.reduce_motion() {
                    self.celebrate_100_until = Some(Instant::now() + CELEBRATE_100_DURATION);
                    self._celebrate_task = Some(cx.spawn(async move |this, cx| {
                        cx.background_executor().timer(CELEBRATE_100_DURATION).await;
                        let _ = this.update(cx, |app, cx| {
                            app.celebrate_100_until = None;
                            cx.notify();
                        });
                    }));
                }
            }
        }
    }

    fn is_celebrating_100(&self) -> bool {
        self.celebrate_100_until
            .is_some_and(|until| Instant::now() < until)
    }

    fn has_overlay_open(&self, cx: &App) -> bool {
        self.onboarding.is_some()
            || self.palette.read(cx).is_open()
            || self.show_harnesses_modal
            || self.show_settings_modal
            || self.show_health_modal
            || self.show_dream_diff_modal
            || self.show_shortcuts_modal
            || self.show_context_modal
            || self.show_save_view_modal
            || self.show_composer_modal
            || self.forget_confirm_target.is_some()
            || self.show_ingest_modal
            || self.show_consent_modal
    }

    fn record_window_activity(&mut self) {
        self.momo_peek.record_activity(Instant::now());
    }

    fn start_db_watcher(&mut self, cx: &mut Context<Self>) {
        let shared = self.shared_store.clone();
        self._db_watch_task = Some(cx.spawn(async move |this, cx| {
            loop {
                // Back off while the window is in the background: a store that
                // is not being watched does not need a 1.5 s poll.
                let active = this
                    .read_with(cx, |app, _| app.window_active)
                    .unwrap_or(true);
                cx.background_executor()
                    .timer(Duration::from_millis(if active { 1500 } else { 8000 }))
                    .await;
                let info = this.read_with(cx, |app, _| {
                    if app.onboarding.is_some() {
                        return None;
                    }
                    let current = db_file_stamp(&app.resolved_db.path);
                    if current.is_some() && current != app.last_db_stamp {
                        Some((app.resolved_db.path.clone(), app.filter.clone(), current))
                    } else {
                        None
                    }
                });
                let Ok(Some((db_path, filter, stamp))) = info else {
                    if info.is_err() {
                        break;
                    }
                    continue;
                };

                let reload_shared = shared.clone();
                let reloaded = cx
                    .background_executor()
                    .spawn(async move {
                        reload_shared.with_store(&db_path, |store| {
                            load_initial_snapshot_blocking(store, &filter)
                        })
                    })
                    .await;

                if let Ok(loaded) = reloaded {
                    let _ = this.update(cx, |app, cx| {
                        let is_browsing = app.selected_id.is_some()
                            || app.detail_open
                            || app.list_view.read(cx).is_browsing_or_scrolled();
                        if is_browsing {
                            let old_total =
                                app.overview.as_ref().map(|o| o.node_count).unwrap_or(0);
                            let (new_count, newest_id) = {
                                let existing = app.list_view.read(cx).items();
                                (
                                    count_new_memory_ids(
                                        existing,
                                        &loaded.items,
                                        old_total,
                                        loaded.overview.node_count,
                                    ),
                                    find_newest_added_id(existing, &loaded.items),
                                )
                            };
                            app.last_db_stamp = stamp;
                            app.pending_live_reload = Some(PendingLiveReload {
                                result: loaded,
                                stamp,
                                newest_id,
                            });
                            app.list_view
                                .update(cx, |l, cx| l.set_pending_new_count(Some(new_count), cx));
                            if app.active_surface == WorkspaceSurface::Today {
                                app.spawn_brief_and_review_badges(cx);
                            }
                        } else {
                            app.apply_loaded_snapshot(loaded, stamp, None, cx);
                        }
                    });
                }
            }
        }));
    }

    /// First-paint apply: list + totals only. Deliberately does not touch
    /// health, milestones, brief, graph or review; the full load owns those.
    fn apply_fast_snapshot(
        &mut self,
        overview: DbOverview,
        page: crate::core::db::ListPageResult,
        total_matching: usize,
        cx: &mut Context<Self>,
    ) {
        if self.active_surface != WorkspaceSurface::Memories {
            return;
        }
        let total = overview.node_count;
        let filtered = !self.filter.is_empty();
        self.list_cursor = page.next_cursor;
        self.list_total_matching = total_matching;
        self.loading_next_page = false;
        self.overview = Some(overview.clone());
        self.sidebar
            .update(cx, |s, cx| s.set_overview(Some(overview.clone()), cx));
        self.list_view.update(cx, |list, cx| {
            list.set_overview(Some(overview), cx);
            list.set_items(
                page.items,
                filtered,
                total_matching,
                total,
                page.has_more,
                cx,
            );
        });
        cx.notify();
    }

    fn apply_loaded_snapshot(
        &mut self,
        loaded: InitialLoadResult,
        stamp: Option<(u64, Option<SystemTime>)>,
        jump_to_id: Option<String>,
        cx: &mut Context<Self>,
    ) {
        self.last_db_stamp = stamp;
        self.pending_live_reload = None;
        let total = loaded.overview.node_count;
        let total_matching = loaded.total_matching;
        let has_more = loaded.has_more;
        self.list_cursor = loaded.next_cursor;
        self.list_total_matching = total_matching;
        self.loading_next_page = false;
        self.page_generation.advance();
        self._next_page_task = None;
        let ov = loaded.overview.clone();
        let ov_list = loaded.overview.clone();

        self.apply_store_health_and_milestones(&loaded.overview, loaded.health, cx);
        self.overview = Some(loaded.overview);
        self.sidebar
            .update(cx, |s, cx| s.set_overview(Some(ov), cx));
        self.list_view.update(cx, |list, cx| {
            list.set_pending_new_count(None, cx);
            list.set_overview(Some(ov_list), cx);
            list.set_items(
                loaded.items,
                !self.filter.is_empty(),
                total_matching,
                total,
                has_more,
                cx,
            );
            if jump_to_id.is_some() {
                list.scroll_to_top(cx);
            }
        });

        if let Some(target_id) = jump_to_id {
            self.select_memory(target_id, true, cx);
        }
        // A reload must not close the detail pane just because the selected
        // memory fell outside the first page: that would throw away the
        // user's reading position. Explicit deletes clear `selected_id`
        // before reloading, so a genuinely removed memory still closes it.

        self.spawn_brief_and_review_badges(cx);
        if self.active_surface == WorkspaceSurface::Memories && self.view_mode == ViewMode::Graph {
            self.spawn_graph_load(cx);
        } else if self.active_surface == WorkspaceSurface::Review {
            self.spawn_review_list_load(cx);
        }
        cx.notify();
    }

    fn flush_dirty_settings(&mut self) {
        if self.bounds_dirty {
            self.bounds_dirty = false;
            self.settings.save_async();
        }
    }

    fn sync_write_mode_to_views(&mut self, cx: &mut Context<Self>) {
        let enabled = self.settings.write_mode;
        let has_selection = self.selected_id.is_some();
        self.detail_view
            .update(cx, |d, cx| d.set_write_mode(enabled, cx));
        self.review_view
            .update(cx, |r, cx| r.set_write_mode(enabled, cx));
        self.palette
            .update(cx, |p, cx| p.set_write_context(enabled, has_selection, cx));
        if !enabled {
            self.show_composer_modal = false;
            self.forget_confirm_target = None;
            self.show_ingest_modal = false;
            self.write_bridge_error = None;
            self.write_bridge.shutdown();
        }
    }

    fn sync_linked_hover(
        &mut self,
        origin: HoverOrigin,
        id: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if self.hovered_id == id {
            return;
        }
        self.hovered_id = id.clone();
        if origin != HoverOrigin::List {
            let list_id = id.clone();
            self.list_view
                .update(cx, |l, cx| l.set_external_hovered_id(list_id, cx));
        }
        if origin != HoverOrigin::Graph {
            self.graph_view
                .update(cx, |g, cx| g.set_external_hovered_id(id, cx));
        }
    }

    fn set_row_density(&mut self, density: RowDensity, cx: &mut Context<Self>) {
        if self.settings.row_density == density {
            return;
        }
        self.settings.row_density = density;
        self.bounds_dirty = false;
        self.settings.save_async();
        self.list_view
            .update(cx, |l, cx| l.set_row_density(density, cx));
        self.set_notice(format!("Row density set to {}", density.label()), cx);
        cx.notify();
    }

    fn set_write_mode(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if enabled && !self.writer_preflight.compatible {
            self.settings.write_mode = false;
            self.bounds_dirty = false;
            self.settings.save_async();
            self.sync_write_mode_to_views(cx);
            if let Some(msg) = self.writer_preflight.human_message() {
                self.set_notice(msg, cx);
            }
            cx.notify();
            return;
        }
        self.settings.write_mode = enabled;
        self.bounds_dirty = false;
        self.settings.save_async();
        let cmd = self.settings.effective_writer_command().to_string();
        self.write_bridge.configure(&cmd, &self.resolved_db.path);
        self.writer_test_status = None;
        self.sync_write_mode_to_views(cx);
        self.set_notice(
            if enabled {
                "Write mode enabled (MemOS MCP)"
            } else {
                "Read-only mode restored"
            },
            cx,
        );
        cx.notify();
    }

    fn reset_writer_command(&mut self, cx: &mut Context<Self>) {
        let recommended = recommended_writer_command();
        self.settings.writer_command = recommended.clone();
        self.bounds_dirty = false;
        self.settings.save_async();
        self.write_bridge
            .configure(&recommended, &self.resolved_db.path);
        self.writer_cmd_input
            .update(cx, |v, cx| v.set_text(recommended, cx));
        self.writer_test_status = None;
        self.write_bridge_error = None;
        self.set_notice("Writer command reset to default", cx);
        cx.notify();
    }

    fn use_local_writer_command(&mut self, command: String, cx: &mut Context<Self>) {
        self.settings.writer_command = command.clone();
        self.bounds_dirty = false;
        self.settings.save_async();
        self.write_bridge
            .configure(&command, &self.resolved_db.path);
        self.writer_cmd_input
            .update(cx, |v, cx| v.set_text(command, cx));
        self.writer_test_status = None;
        self.write_bridge_error = None;
        self.set_notice("Switched writer command to local CLI", cx);
        cx.notify();
    }

    fn active_writer_ping(&self) -> Option<PingResult> {
        if let Some(Ok(info)) = &self.writer_test_status {
            return Some(info.clone());
        }
        self.write_bridge.connected_info()
    }

    fn run_writer_ping(&mut self, cx: &mut Context<Self>) {
        self.flush_dirty_settings();
        let cmd = self.settings.effective_writer_command();
        self.write_bridge.configure(&cmd, &self.resolved_db.path);
        self.writer_testing = true;
        self.writer_test_status = None;
        cx.notify();

        let bridge = self.write_bridge.clone();
        self._writer_ping_task = Some(cx.spawn(async move |this, cx| {
            let outcome = cx
                .background_executor()
                .spawn(async move { bridge.ping() })
                .await;
            let _ = this.update(cx, |app, cx| {
                app.writer_testing = false;
                match outcome {
                    Ok(info) => {
                        app.writer_test_status = Some(Ok(info));
                        app.write_bridge_error = None;
                    }
                    Err(err) => {
                        app.writer_test_status = Some(Err(err.ui_summary()));
                    }
                }
                cx.notify();
            });
        }));
    }

    fn open_new_memory_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.settings.write_mode {
            self.set_notice("Enable write mode in Settings to add memories", cx);
            return;
        }
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.close_all_modals();
        self.composer_editing_id = None;
        self.composer_type = self
            .filter
            .node_type
            .clone()
            .unwrap_or_else(|| "fact".to_string());
        self.composer_pool = "event".to_string();
        self.composer_validation_error = None;
        let default_ns = self.filter.namespace.clone().unwrap_or_default();
        self.composer_content_input.update(cx, |v, cx| v.clear(cx));
        self.composer_tags_input.update(cx, |v, cx| v.clear(cx));
        self.composer_namespace_input
            .update(cx, |v, cx| v.set_text(default_ns, cx));
        self.composer_context_input.update(cx, |v, cx| v.clear(cx));
        self.show_composer_modal = true;
        let focus = self.composer_content_input.focus_handle(cx);
        window.focus(&focus, cx);
        cx.notify();
    }

    fn open_edit_memory_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.settings.write_mode {
            self.set_notice("Enable write mode in Settings to edit memories", cx);
            return;
        }
        let Some(target_id) = self.selected_id.clone() else {
            self.set_notice("Select a memory first", cx);
            return;
        };

        let detail_opt = self
            .detail_view
            .read(cx)
            .detail()
            .filter(|d| d.id == target_id)
            .cloned();

        let (node_type, pool, tags_csv, namespace, body_text) = if let Some(d) = detail_opt {
            let pool = if matches!(d.pool.as_str(), "event" | "note" | "procedure") {
                d.pool.clone()
            } else {
                "event".to_string()
            };
            let ns = if d.namespace == "default" || d.namespace.is_empty() {
                String::new()
            } else {
                d.namespace.clone()
            };
            let text = if !d.content.trim().is_empty() {
                d.content.clone()
            } else {
                d.summary.clone()
            };
            (d.node_type.clone(), pool, d.tags.join(", "), ns, text)
        } else if let Some(item) = self
            .list_view
            .read(cx)
            .items()
            .iter()
            .find(|it| it.id == target_id)
            .cloned()
        {
            let ns = if item.namespace.as_ref() == "default" || item.namespace.is_empty() {
                String::new()
            } else {
                item.namespace.to_string()
            };
            let tags_joined = item
                .tags
                .iter()
                .map(|t| t.as_ref())
                .collect::<Vec<_>>()
                .join(", ");
            (
                item.node_type.to_string(),
                "event".to_string(),
                tags_joined,
                ns,
                item.preview.to_string(),
            )
        } else {
            self.set_notice("Selected memory is no longer available", cx);
            return;
        };

        self.dismiss_popovers(PopoverOwner::None, cx);
        self.close_all_modals();
        self.composer_editing_id = Some(target_id);
        self.composer_type = if node_type.trim().is_empty() {
            "fact".to_string()
        } else {
            node_type
        };
        self.composer_pool = pool;
        self.composer_validation_error = None;
        self.composer_content_input
            .update(cx, |v, cx| v.set_text(body_text, cx));
        self.composer_tags_input
            .update(cx, |v, cx| v.set_text(tags_csv, cx));
        self.composer_namespace_input
            .update(cx, |v, cx| v.set_text(namespace, cx));
        self.composer_context_input.update(cx, |v, cx| v.clear(cx));
        self.show_composer_modal = true;
        let focus = self.composer_content_input.focus_handle(cx);
        window.focus(&focus, cx);
        cx.notify();
    }

    fn submit_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.write_in_flight {
            return;
        }
        if !self.settings.write_mode {
            self.show_composer_modal = false;
            self.set_notice("Write mode is disabled", cx);
            return;
        }
        let content = self
            .composer_content_input
            .read(cx)
            .text()
            .trim()
            .to_string();
        if content.is_empty() {
            self.composer_validation_error =
                Some("Enter memory content before saving.".to_string());
            cx.notify();
            return;
        }
        let tags: Vec<String> = self
            .composer_tags_input
            .read(cx)
            .text()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string)
            .collect();
        let namespace = {
            let ns = self
                .composer_namespace_input
                .read(cx)
                .text()
                .trim()
                .to_string();
            if ns.is_empty() { None } else { Some(ns) }
        };
        let context = {
            let ctx = self
                .composer_context_input
                .read(cx)
                .text()
                .trim()
                .to_string();
            if ctx.is_empty() { None } else { Some(ctx) }
        };

        let input = StoreInput {
            content,
            node_type: Some(self.composer_type.clone()),
            tags,
            namespace,
            pool: Some(self.composer_pool.clone()),
            context,
        };
        let editing_id = self.composer_editing_id.take();
        self.show_composer_modal = false;
        self.composer_validation_error = None;
        window.focus(&self.focus_handle, cx);

        let action = if let Some(original_id) = editing_id {
            WriteRetryAction::Edit { original_id, input }
        } else {
            WriteRetryAction::Store { input }
        };
        self.execute_write_action(action, cx);
    }

    fn open_forget_confirm(&mut self, cx: &mut Context<Self>) {
        if !self.settings.write_mode {
            self.set_notice("Enable write mode in Settings to forget memories", cx);
            return;
        }
        let Some(target_id) = self.selected_id.clone() else {
            self.set_notice("Select a memory first", cx);
            return;
        };

        let detail_opt = self
            .detail_view
            .read(cx)
            .detail()
            .filter(|d| d.id == target_id)
            .cloned();
        let (short_id, raw_preview) = if let Some(d) = detail_opt {
            let text = if !d.summary.trim().is_empty() {
                d.summary.clone()
            } else {
                d.content.clone()
            };
            (d.short_id.clone(), text)
        } else if let Some(item) = self
            .list_view
            .read(cx)
            .items()
            .iter()
            .find(|it| it.id == target_id)
        {
            (item.short_id.to_string(), item.preview.to_string())
        } else {
            let short: String = target_id.chars().take(8).collect();
            (short, String::new())
        };

        let first_line = raw_preview
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("Selected memory")
            .to_string();
        let preview = if first_line.chars().count() > 110 {
            let clipped: String = first_line.chars().take(109).collect();
            format!("{clipped}…")
        } else {
            first_line
        };

        self.dismiss_popovers(PopoverOwner::None, cx);
        self.close_all_modals();
        self.forget_confirm_target = Some(ForgetTarget {
            id: target_id,
            short_id,
            preview,
        });
        cx.notify();
    }

    fn confirm_forget(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.write_in_flight {
            self.set_notice("Wait for the current save to finish", cx);
            return;
        }
        let Some(target) = self.forget_confirm_target.take() else {
            return;
        };
        window.focus(&self.focus_handle, cx);
        if !self.settings.write_mode {
            self.set_notice("Write mode is disabled", cx);
            return;
        }
        self.execute_write_action(WriteRetryAction::Forget { id: target.id }, cx);
    }

    fn retry_failed_write(&mut self, cx: &mut Context<Self>) {
        if self.write_in_flight {
            return;
        }
        let Some(banner) = self.write_bridge_error.clone() else {
            return;
        };
        if !self.settings.write_mode {
            self.write_bridge_error = None;
            cx.notify();
            return;
        }
        self.execute_write_action(banner.retry_action, cx);
    }

    fn execute_write_action(&mut self, action: WriteRetryAction, cx: &mut Context<Self>) {
        if !self.settings.write_mode {
            self.set_notice("Write mode is disabled", cx);
            return;
        }
        self.flush_dirty_settings();
        let cmd = self.settings.effective_writer_command().to_string();
        self.write_bridge.configure(&cmd, &self.resolved_db.path);
        let bridge = self.write_bridge.clone();
        let retry_action = action.clone();
        self.write_in_flight = true;
        self.write_bridge_error = None;
        cx.notify();

        self._write_task = Some(cx.spawn(async move |this, cx| {
            let outcome = cx
                .background_executor()
                .spawn(async move {
                    match action {
                        WriteRetryAction::Store { input } => match bridge.store(input) {
                            Ok(stored) => Ok::<_, (BridgeError, Option<WriteRetryAction>)>((
                                Some(stored.id),
                                None,
                                "Memory saved".to_string(),
                            )),
                            Err(err) => Err((err, None)),
                        },
                        WriteRetryAction::Edit { original_id, input } => {
                            match bridge.store(input) {
                                Ok(stored) => {
                                    match bridge.supersede(&original_id, Some(&stored.id)) {
                                        Ok(_) => Ok((
                                            Some(stored.id),
                                            Some(original_id),
                                            "Saved as a new version".to_string(),
                                        )),
                                        Err(err) => Err((
                                            err,
                                            Some(WriteRetryAction::FinishEdit {
                                                original_id,
                                                new_id: stored.id,
                                            }),
                                        )),
                                    }
                                }
                                Err(err) => Err((err, None)),
                            }
                        }
                        WriteRetryAction::FinishEdit {
                            original_id,
                            new_id,
                        } => match bridge.supersede(&original_id, Some(&new_id)) {
                            Ok(_) => Ok((
                                Some(new_id),
                                Some(original_id),
                                "Saved as a new version".to_string(),
                            )),
                            Err(err) => Err((
                                err,
                                Some(WriteRetryAction::FinishEdit {
                                    original_id,
                                    new_id,
                                }),
                            )),
                        },
                        WriteRetryAction::Forget { id } => match bridge.forget(&id) {
                            Ok(_) => Ok((None, Some(id), "Memory forgotten".to_string())),
                            Err(err) => Err((err, None)),
                        },
                        WriteRetryAction::Review { id, approve } => {
                            let action = if approve { "approve" } else { "reject" }.to_string();
                            match bridge.review(ReviewInput {
                                action,
                                id: Some(id),
                                namespace: None,
                            }) {
                                Ok(done) => Ok((None, None, done.summary)),
                                Err(err) => Err((err, None)),
                            }
                        }
                    }
                })
                .await;

            let _ = this.update(cx, |app, cx| {
                app.write_in_flight = false;
                match outcome {
                    Ok((jump_id, removed_id, toast)) => {
                        app.write_bridge_error = None;
                        if let Some(old_id) = removed_id
                            && app.selected_id.as_deref() == Some(old_id.as_str())
                        {
                            app.selected_id = None;
                            app.detail_open = false;
                        }
                        app.set_notice(toast, cx);
                        app.reload_store_after_write(jump_id, cx);
                    }
                    Err((err, retry_override)) => {
                        let summary = err.ui_summary();
                        tracing::warn!(error = %summary, "MCP write operation failed");
                        app.write_bridge_error = Some(BridgeErrorBanner {
                            command: cmd,
                            message: summary,
                            retry_action: retry_override.unwrap_or(retry_action),
                        });
                        cx.notify();
                    }
                }
            });
        }));
    }

    fn reload_store_after_write(&mut self, jump_to_id: Option<String>, cx: &mut Context<Self>) {
        let db_path = self.resolved_db.path.clone();
        let filter = self.filter.clone();
        let shared = self.shared_store.clone();
        self._init_task = Some(cx.spawn(async move |this, cx| {
            let reloaded = cx
                .background_executor()
                .spawn(async move {
                    shared.with_store(&db_path, |store| {
                        load_initial_snapshot_blocking(store, &filter)
                    })
                })
                .await;

            let _ = this.update(cx, |app, cx| match reloaded {
                Ok(loaded) => {
                    let stamp = db_file_stamp(&app.resolved_db.path);
                    app.apply_loaded_snapshot(loaded, stamp, jump_to_id, cx);
                }
                Err(DbError::NotFound) => {
                    app.overview = None;
                    app.writer_preflight = WriterSchemaPreflight::default();
                    app.close_detail(cx);
                }
                Err(err) => {
                    let msg = sanitize_db_error(&err, &app.resolved_db.path);
                    app.set_notice(msg, cx);
                }
            });
        }));
    }

    fn spawn_brief_and_review_badges(&mut self, cx: &mut Context<Self>) {
        let db_path = self.resolved_db.path.clone();
        let contradiction_ids = self
            .overview
            .as_ref()
            .map(|o| o.contradiction_node_ids.clone())
            .unwrap_or_default();
        let shared = self.shared_store.clone();
        if self.active_surface == WorkspaceSurface::Today {
            self.brief_view.update(cx, |b, cx| b.set_loading(true, cx));
        }

        self._brief_task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move {
                    shared.with_store(&db_path, |store| {
                        let now_ms = now_unix_ms();
                        let snapshot = store.load_brief(now_ms, &contradiction_ids, 5)?;
                        let pending_review = store.count_pending_review().unwrap_or(0);
                        Ok::<(BriefSnapshot, usize), DbError>((snapshot, pending_review))
                    })
                })
                .await;

            let _ = this.update(cx, |app, cx| match res {
                Ok((snapshot, pending_review)) => {
                    let today_count = snapshot.total_count();
                    app.today_count = today_count;
                    app.pending_review_count = pending_review;
                    app.sidebar.update(cx, |s, cx| {
                        s.set_special_counts(today_count, pending_review, cx);
                    });
                    app.brief_view
                        .update(cx, |b, cx| b.set_snapshot(snapshot, cx));
                }
                Err(err) => {
                    let msg = sanitize_db_error(&err, &app.resolved_db.path);
                    app.brief_view
                        .update(cx, |b, cx| b.set_error(Some(msg), cx));
                }
            });
        }));
    }

    fn open_today_view(&mut self, cx: &mut Context<Self>) {
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.active_surface = WorkspaceSurface::Today;
        self.sidebar
            .update(cx, |s, cx| s.set_active_surface(SidebarSurface::Today, cx));
        self.graph_view
            .update(cx, |g, cx| g.set_active_visible(false, cx));
        self.spawn_brief_and_review_badges(cx);
        cx.notify();
    }

    fn open_brief_section_in_list(&mut self, section: BriefSectionKind, cx: &mut Context<Self>) {
        let now_ms = now_unix_ms();
        let next_filter = section.to_filter(now_ms);
        self.active_surface = WorkspaceSurface::Memories;
        self.view_mode = ViewMode::List;
        self.filter = next_filter;
        self.active_saved_view_id = if section == BriefSectionKind::Contradictions {
            Some("contradictions".to_string())
        } else {
            None
        };
        self.settings.last_view_mode = Some(ViewMode::List);
        self.sidebar.update(cx, |s, cx| {
            s.set_active_surface(SidebarSurface::Memories, cx);
            s.set_active_saved_view_id(self.active_saved_view_id.clone(), cx);
        });
        self.list_view.update(cx, |l, cx| {
            l.set_active_view_name(Some(section.view_name().to_string()), cx);
        });
        self.search_input.update(cx, |i, cx| i.set_text("", cx));
        self.apply_filter_update(cx);
        cx.notify();
    }

    fn open_review_view(&mut self, cx: &mut Context<Self>) {
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.active_surface = WorkspaceSurface::Review;
        self.sidebar
            .update(cx, |s, cx| s.set_active_surface(SidebarSurface::Review, cx));
        self.graph_view
            .update(cx, |g, cx| g.set_active_visible(false, cx));
        self.refresh_review_view(cx);
        cx.notify();
    }

    fn refresh_review_view(&mut self, cx: &mut Context<Self>) {
        // Never start the MCP writer just to list review candidates. The
        // writer's read pass can re-sync node_tags and mutate a store that the
        // UI is presenting as read-only.
        if self.settings.write_mode && self.writer_preflight.compatible {
            self.spawn_review_list_load(cx);
        } else {
            self.spawn_read_only_review_load(cx);
        }
    }

    /// List the review queue straight from SQLite when the writer is off.
    ///
    /// The queue is read-only here: approve/reject remain gated on write mode,
    /// but the user can still see what their agents have queued up.
    fn spawn_read_only_review_load(&mut self, cx: &mut Context<Self>) {
        let db_path = self.resolved_db.path.clone();
        let shared = self.shared_store.clone();
        self.review_view.update(cx, |r, cx| {
            r.set_load_error(None, cx);
            r.set_loading(true, cx);
        });

        self._review_task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move {
                    shared.with_store(&db_path, |store| store.load_pending_review(500))
                })
                .await;

            let _ = this.update(cx, |app, cx| match res {
                Ok(items) => {
                    let count = items.len();
                    app.pending_review_count = count;
                    app.sidebar
                        .update(cx, |s, cx| s.set_pending_review_count(count, cx));
                    app.review_view.update(cx, |r, cx| r.set_items(items, cx));
                }
                Err(err) => {
                    tracing::warn!(error = %err, "failed to list pending review from sqlite");
                    app.review_view.update(cx, |r, cx| {
                        r.set_load_error(Some(ReviewLoadError::Other(err.to_string())), cx)
                    });
                }
            });
        }));
    }

    fn spawn_review_list_load(&mut self, cx: &mut Context<Self>) {
        let cmd = self.settings.effective_writer_command();
        self.write_bridge.configure(&cmd, &self.resolved_db.path);
        let bridge = self.write_bridge.clone();
        self.review_view.update(cx, |r, cx| r.set_loading(true, cx));

        self._review_task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move {
                    bridge.review(ReviewInput {
                        action: "list".to_string(),
                        id: None,
                        namespace: None,
                    })
                })
                .await;

            let _ = this.update(cx, |app, cx| match res {
                Ok(review) => {
                    let count = review.items.len();
                    app.pending_review_count = count;
                    app.sidebar
                        .update(cx, |s, cx| s.set_pending_review_count(count, cx));
                    app.review_view
                        .update(cx, |r, cx| r.set_items(review.items, cx));
                }
                Err(err) => {
                    let load_err = if err.is_capability_missing() {
                        ReviewLoadError::CapabilityMissing(err.ui_summary())
                    } else {
                        ReviewLoadError::Other(err.ui_summary())
                    };
                    app.review_view
                        .update(cx, |r, cx| r.set_load_error(Some(load_err), cx));
                }
            });
        }));
    }

    fn execute_review_decision(&mut self, id: String, approve: bool, cx: &mut Context<Self>) {
        if !self.settings.write_mode {
            self.set_notice("Turn on editing to review", cx);
            return;
        }
        let cmd = self.settings.effective_writer_command().to_string();
        self.write_bridge.configure(&cmd, &self.resolved_db.path);
        let bridge = self.write_bridge.clone();
        let retry_id = id.clone();
        self.review_view
            .update(cx, |r, cx| r.set_busy_id(Some(id.clone()), cx));
        let action = if approve { "approve" } else { "reject" }.to_string();

        self._review_task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move {
                    bridge.review(ReviewInput {
                        action,
                        id: Some(id),
                        namespace: None,
                    })
                })
                .await;

            let _ = this.update(cx, |app, cx| match res {
                Ok(done) => {
                    app.set_notice(done.summary, cx);
                    app.reload_store_after_write(None, cx);
                    app.spawn_review_list_load(cx);
                }
                Err(err) => {
                    let msg = err.ui_summary();
                    app.review_view.update(cx, |r, cx| r.set_busy_id(None, cx));
                    app.write_bridge_error = Some(BridgeErrorBanner {
                        command: cmd,
                        message: msg,
                        retry_action: WriteRetryAction::Review {
                            id: retry_id,
                            approve,
                        },
                    });
                    cx.notify();
                }
            });
        }));
    }

    fn open_ingest_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !is_ingest_button_visible(self.settings.write_mode) {
            self.set_notice("Enable write mode to ingest files", cx);
            return;
        }
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.close_all_modals();
        let cmd = self.settings.effective_writer_command();
        self.write_bridge.configure(&cmd, &self.resolved_db.path);
        self.ingest_error = self
            .write_bridge
            .cached_supports_tool("memos_ingest")
            .and_then(|res| res.err())
            .map(|err| err.ui_summary());
        self.ingest_result = None;
        self.ingest_in_flight = false;
        self.show_ingest_modal = true;
        let path_focus = self.ingest_path_input.focus_handle(cx);
        window.focus(&path_focus, cx);
        cx.notify();
    }

    fn browse_ingest_path(&mut self, cx: &mut Context<Self>) {
        let receiver = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: true,
            multiple: false,
            prompt: Some("Select file or folder to ingest into MemOS".into()),
        });
        self._browse_ingest_task = Some(cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = receiver.await
                && let Some(selected) = paths.into_iter().next()
            {
                let display = selected.to_string_lossy().to_string();
                let _ = this.update(cx, |app, cx| {
                    app.ingest_path_input
                        .update(cx, |i, cx| i.set_text(display, cx));
                    app.ingest_error = None;
                    cx.notify();
                });
            }
        }));
    }

    fn submit_ingest(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.settings.write_mode {
            self.ingest_error = Some("Enable write mode in Settings before ingesting.".to_string());
            cx.notify();
            return;
        }
        if self.ingest_in_flight {
            return;
        }
        let path = self.ingest_path_input.read(cx).text().trim().to_string();
        if path.is_empty() {
            self.ingest_error = Some("Select a file or folder path first.".to_string());
            cx.notify();
            return;
        }
        let chunk_chars = match parse_ingest_chunk_chars(self.ingest_chunk_input.read(cx).text()) {
            Ok(val) => val,
            Err(err) => {
                self.ingest_error = Some(err);
                cx.notify();
                return;
            }
        };
        let ns_raw = self
            .ingest_namespace_input
            .read(cx)
            .text()
            .trim()
            .to_string();
        let namespace = if ns_raw.is_empty() {
            None
        } else {
            Some(ns_raw)
        };
        let extensions = parse_extensions_csv(self.ingest_extensions_input.read(cx).text());
        let input = IngestInput {
            path,
            namespace,
            extensions,
            chunk_chars,
            recursive: self.ingest_recursive,
        };

        let cmd = self.settings.effective_writer_command().to_string();
        self.write_bridge.configure(&cmd, &self.resolved_db.path);
        let bridge = self.write_bridge.clone();
        self.ingest_in_flight = true;
        self.ingest_error = None;
        self.ingest_result = None;
        window.focus(&self.focus_handle, cx);
        cx.notify();

        self._ingest_task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move { bridge.ingest(input) })
                .await;

            let _ = this.update(cx, |app, cx| {
                app.ingest_in_flight = false;
                match res {
                    Ok(summary) => {
                        app.ingest_error = None;
                        app.ingest_result = Some(summary.clone());
                        app.set_notice(
                            format!("Ingest complete: {}", summary.format_summary()),
                            cx,
                        );
                        app.reload_store_after_write(None, cx);
                    }
                    Err(err) => {
                        app.ingest_error = Some(err.ui_summary());
                        cx.notify();
                    }
                }
            });
        }));
    }

    fn render_ingest_modal(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let current_ns = self
            .ingest_namespace_input
            .read(cx)
            .text()
            .trim()
            .to_string();

        div()
            .id("ingest-backdrop")
            .absolute()
            .inset_0()
            .bg(theme.glass_scrim)
            .px(px(24.))
            .py(px(20.))
            .flex()
            .items_center()
            .justify_center()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    this.show_ingest_modal = false;
                    window.focus(&this.focus_handle, cx);
                    cx.notify();
                }),
            )
            .child(
                div()
                    .id("ingest-dialog")
                    .role(Role::Dialog)
                    .aria_label("Ingest documents")
                    .w_full()
                    .max_w(px(560.))
                    .max_h(gpui::relative(0.9))
                    .rounded(px(16.))
                    .bg(theme.glass_panel)
                    .border_1()
                    .border_color(theme.glass_border)
                    .shadow_lg()
                    .overflow_hidden()
                    .flex()
                    .flex_col()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .px(px(16.))
                            .py(px(12.))
                            .border_b_1()
                            .border_color(theme.border_subtle)
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(8.))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(2.))
                                    .child(
                                        div()
                                            .text_size(px(15.))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(theme.text_primary)
                                            .child("Ingest files or folder"),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .text_color(theme.text_muted)
                                            .child("Chunk and index Markdown, text, HTML, or PDF via memos_ingest."),
                                    ),
                            )
                            .child(
                                div()
                                    .id("ingest-close-x")
                                    .focusable()
                                    .role(Role::Button)
                                    .aria_label("Close ingest dialog")
                                    .w(px(28.))
                                    .h(px(28.))
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .hover(move |s| s.bg(theme.bg_hover))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.show_ingest_modal = false;
                                        window.focus(&this.focus_handle, cx);
                                        cx.notify();
                                    }))
                                    .child(render_ui_icon(UiIcon::Close, 14.0, theme.text_secondary)),
                            ),
                    )
                    .child(
                        div()
                            .p(px(16.))
                            .flex()
                            .flex_col()
                            .gap(px(12.))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(5.))
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text_primary)
                                            .child("File or folder path"),
                                    )
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .gap(px(8.))
                                            .child(
                                                div()
                                                    .flex_1()
                                                    .min_w(px(0.))
                                                    .child(self.ingest_path_input.clone()),
                                            )
                                            .child(
                                                div()
                                                    .id("ingest-browse-btn")
                                                    .focusable()
                                                    .role(Role::Button)
                                                    .cursor_pointer()
                                                    .h(px(32.))
                                                    .px(px(12.))
                                                    .rounded(px(6.))
                                                    .bg(theme.bg_elevated)
                                                    .border_1()
                                                    .border_color(theme.border_subtle)
                                                    .hover(move |s| s.bg(theme.bg_selected))
                                                    .flex()
                                                    .items_center()
                                                    .text_size(px(12.))
                                                    .text_color(theme.text_primary)
                                                    .on_click(cx.listener(|this, _, _, cx| {
                                                        this.browse_ingest_path(cx);
                                                    }))
                                                    .child("Browse…"),
                                            ),
                                    ),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(5.))
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .justify_between()
                                            .gap(px(8.))
                                            .child(
                                                div()
                                                    .text_size(px(12.))
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(theme.text_primary)
                                                    .child("Namespace"),
                                            )
                                            .child(
                                                div()
                                                    .flex()
                                                    .items_center()
                                                    .gap(px(6.))
                                                    .children(["default", "documents"].into_iter().enumerate().map(|(ix, preset)| {
                                                        let active = current_ns == preset;
                                                        div()
                                                            .id(("ingest-ns-preset", ix))
                                                            .cursor_pointer()
                                                            .px(px(7.))
                                                            .py(px(2.))
                                                            .rounded(px(4.))
                                                            .bg(if active { theme.bg_selected } else { theme.bg_elevated })
                                                            .border_1()
                                                            .border_color(if active { theme.accent } else { theme.border_subtle })
                                                            .text_size(px(11.))
                                                            .text_color(theme.text_secondary)
                                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                                this.ingest_namespace_input.update(cx, |i, cx| i.set_text(preset, cx));
                                                            }))
                                                            .child(preset)
                                                    })),
                                            ),
                                    )
                                    .child(self.ingest_namespace_input.clone()),
                            )
                            .child(
                                div()
                                    .w_full()
                                    .flex()
                                    .items_start()
                                    .gap(px(10.))
                                    .child(
                                        div()
                                            .flex_1()
                                            .flex()
                                            .flex_col()
                                            .gap(px(5.))
                                            .child(
                                                div()
                                                    .text_size(px(12.))
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(theme.text_primary)
                                                    .child("Extensions"),
                                            )
                                            .child(self.ingest_extensions_input.clone()),
                                    )
                                    .child(
                                        div()
                                            .w(px(150.))
                                            .flex()
                                            .flex_col()
                                            .gap(px(5.))
                                            .child(
                                                div()
                                                    .text_size(px(12.))
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(theme.text_primary)
                                                    .child("Chunk size (chars)"),
                                            )
                                            .child(self.ingest_chunk_input.clone()),
                                    ),
                            )
                            .child(
                                div()
                                    .id("ingest-recursive-toggle")
                                    .focusable()
                                    .role(Role::CheckBox)
                                    .cursor_pointer()
                                    .py(px(4.))
                                    .flex()
                                    .items_center()
                                    .gap(px(8.))
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.ingest_recursive = !this.ingest_recursive;
                                        cx.notify();
                                    }))
                                    .child(
                                        div()
                                            .w(px(16.))
                                            .h(px(16.))
                                            .rounded(px(4.))
                                            .border_1()
                                            .border_color(if self.ingest_recursive {
                                                theme.accent
                                            } else {
                                                theme.border_strong
                                            })
                                            .bg(if self.ingest_recursive {
                                                theme.accent
                                            } else {
                                                theme.bg_sunken
                                            })
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .when(self.ingest_recursive, |b| {
                                                b.child(render_ui_icon(
                                                    UiIcon::Check,
                                                    11.0,
                                                    theme.primary_btn_fg,
                                                ))
                                            }),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .text_color(theme.text_primary)
                                            .child("Include subfolders recursively"),
                                    ),
                            )
                            .when(self.ingest_in_flight, |col| {
                                col.child(
                                    div()
                                        .id("ingest-spinner")
                                        .px(px(12.))
                                        .py(px(8.))
                                        .rounded(px(6.))
                                        .bg(theme.bg_sunken)
                                        .border_1()
                                        .border_color(theme.border_subtle)
                                        .flex()
                                        .items_center()
                                        .gap(px(8.))
                                        .child(status_dot(theme.accent))
                                        .child(
                                            div()
                                                .text_size(px(12.))
                                                .text_color(theme.text_secondary)
                                                .child("Ingesting files via memos_ingest…"),
                                        ),
                                )
                            })
                            .when_some(self.ingest_result.clone(), |col, counts| {
                                let stats = [
                                    ("Added", counts.added),
                                    ("Updated", counts.updated),
                                    ("Unchanged", counts.unchanged),
                                    ("Removed", counts.removed),
                                    ("Skipped", counts.skipped),
                                    ("Errors", counts.errors),
                                    ("Chunks", counts.chunks),
                                ];
                                col.child(
                                    div()
                                        .id("ingest-result-card")
                                        .p(px(10.))
                                        .rounded(px(6.))
                                        .bg(theme.bg_sunken)
                                        .border_1()
                                        .border_color(theme.success)
                                        .flex()
                                        .flex_wrap()
                                        .gap(px(10.))
                                        .children(stats.into_iter().map(|(label, val)| {
                                            div()
                                                .px(px(8.))
                                                .py(px(4.))
                                                .rounded(px(5.))
                                                .bg(theme.bg_elevated)
                                                .flex()
                                                .items_center()
                                                .gap(px(5.))
                                                .child(
                                                    div()
                                                        .text_size(px(11.))
                                                        .text_color(theme.text_muted)
                                                        .child(label),
                                                )
                                                .child(
                                                    div()
                                                        .text_size(px(12.))
                                                        .font_weight(FontWeight::SEMIBOLD)
                                                        .font_features(tabular_nums())
                                                        .text_color(theme.text_primary)
                                                        .child(SharedString::from(val.to_string())),
                                                )
                                        })),
                                )
                            })
                            .when_some(self.ingest_error.clone(), |col, err| {
                                col.child(
                                    div()
                                        .id("ingest-error-box")
                                        .p(px(10.))
                                        .rounded(px(6.))
                                        .bg(theme.bg_sunken)
                                        .border_1()
                                        .border_color(theme.danger)
                                        .flex()
                                        .items_center()
                                        .justify_between()
                                        .gap(px(8.))
                                        .child(
                                            div()
                                                .flex_1()
                                                .text_size(px(12.))
                                                .text_color(theme.danger)
                                                .child(SharedString::from(err)),
                                        )
                                        .child(
                                            div()
                                                .flex_shrink_0()
                                                .flex()
                                                .items_center()
                                                .gap(px(6.))
                                                .child(
                                                    div()
                                                        .id("ingest-settings-btn")
                                                        .focusable()
                                                        .role(Role::Button)
                                                        .aria_label("Open Settings")
                                                        .cursor_pointer()
                                                        .h(px(26.))
                                                        .px(px(10.))
                                                        .rounded(px(5.))
                                                        .bg(theme.bg_elevated)
                                                        .border_1()
                                                        .border_color(theme.border_subtle)
                                                        .hover(move |s| s.bg(theme.bg_selected))
                                                        .flex()
                                                        .items_center()
                                                        .text_size(px(12.))
                                                        .text_color(theme.text_primary)
                                                        .on_click(cx.listener(
                                                            |this, _, window, cx| {
                                                                this.show_ingest_modal = false;
                                                                this.open_settings_modal(
                                                                    window, cx,
                                                                );
                                                            },
                                                        ))
                                                        .child("Settings"),
                                                )
                                                .child(
                                                    div()
                                                        .id("ingest-retry-btn")
                                                        .focusable()
                                                        .role(Role::Button)
                                                        .cursor_pointer()
                                                        .h(px(26.))
                                                        .px(px(10.))
                                                        .rounded(px(5.))
                                                        .bg(theme.bg_elevated)
                                                        .border_1()
                                                        .border_color(theme.border_subtle)
                                                        .hover(move |s| s.bg(theme.bg_selected))
                                                        .flex()
                                                        .items_center()
                                                        .text_size(px(12.))
                                                        .text_color(theme.text_primary)
                                                        .on_click(cx.listener(
                                                            |this, _, window, cx| {
                                                                this.submit_ingest(window, cx);
                                                            },
                                                        ))
                                                        .child("Retry"),
                                                ),
                                        ),
                                )
                            }),
                    )
                    .child(
                        div()
                            .px(px(16.))
                            .py(px(12.))
                            .border_t_1()
                            .border_color(theme.border_subtle)
                            .flex()
                            .items_center()
                            .justify_end()
                            .gap(px(8.))
                            .child(
                                div()
                                    .id("ingest-cancel-btn")
                                    .focusable()
                                    .role(Role::Button)
                                    .cursor_pointer()
                                    .h(px(32.))
                                    .px(px(12.))
                                    .rounded(px(6.))
                                    .bg(theme.bg_elevated)
                                    .border_1()
                                    .border_color(theme.border_subtle)
                                    .hover(move |s| s.bg(theme.bg_selected))
                                    .flex()
                                    .items_center()
                                    .text_size(px(13.))
                                    .text_color(theme.text_primary)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.show_ingest_modal = false;
                                        window.focus(&this.focus_handle, cx);
                                        cx.notify();
                                    }))
                                    .child(if self.ingest_result.is_some() {
                                        "Done"
                                    } else {
                                        "Cancel"
                                    }),
                            )
                            .child(
                                div()
                                    .id("ingest-submit-btn")
                                    .focusable()
                                    .role(Role::Button)
                                    .cursor_pointer()
                                    .h(px(32.))
                                    .px(px(14.))
                                    .rounded(px(6.))
                                    .bg(theme.accent)
                                    .hover(move |s| s.opacity(0.92))
                                    .flex()
                                    .items_center()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.primary_btn_fg)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.submit_ingest(window, cx);
                                    }))
                                    .child(if self.ingest_in_flight {
                                        "Ingesting…"
                                    } else {
                                        "Ingest"
                                    }),
                            ),
                    ),
            )
            .into_any_element()
    }

    fn render_write_error_banner(
        &self,
        banner: BridgeErrorBanner,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        div()
            .id("write-bridge-error-banner")
            .w_full()
            .min_w(px(0.))
            .px(px(16.))
            .py(px(8.))
            .bg(theme.bg_panel)
            .border_b_1()
            .border_color(theme.danger)
            .flex()
            .flex_wrap()
            .items_center()
            .justify_between()
            .gap(px(10.))
            .child(
                div()
                    .flex_1()
                    .min_w(px(220.))
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(8.))
                    .child(render_ui_icon(UiIcon::Warning, 14.0, theme.danger))
                    .child(
                        div()
                            .id("write-banner-message")
                            .role(Role::Status)
                            .aria_label(banner.message.clone())
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text_primary)
                            .child(SharedString::from(banner.message)),
                    )
                    .child(
                        div()
                            .id("write-banner-command")
                            .role(Role::Note)
                            .aria_label(format!("Command: {}", banner.command))
                            .px(px(6.))
                            .py(px(2.))
                            .rounded(px(4.))
                            .bg(theme.bg_sunken)
                            .border_1()
                            .border_color(theme.border_subtle)
                            .font_family("Consolas")
                            .text_size(px(11.))
                            .text_color(theme.text_muted)
                            .truncate()
                            .child(SharedString::from(format!("Command: {}", banner.command))),
                    ),
            )
            .child(
                div()
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .child(
                        div()
                            .id("write-banner-retry-btn")
                            .focusable()
                            .role(Role::Button)
                            .aria_label("Retry write")
                            .h(px(26.))
                            .px(px(10.))
                            .rounded(px(6.))
                            .cursor_pointer()
                            .bg(theme.bg_elevated)
                            .border_1()
                            .border_color(theme.border_subtle)
                            .hover(move |s| s.bg(theme.bg_selected))
                            .flex()
                            .items_center()
                            .text_size(px(12.))
                            .text_color(theme.text_primary)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.retry_failed_write(cx);
                            }))
                            .child(if self.write_in_flight {
                                "Retrying…"
                            } else {
                                "Retry"
                            }),
                    )
                    .child(
                        div()
                            .id("write-banner-settings-btn")
                            .focusable()
                            .role(Role::Button)
                            .aria_label("Open Settings")
                            .h(px(26.))
                            .px(px(10.))
                            .rounded(px(6.))
                            .cursor_pointer()
                            .bg(theme.bg_elevated)
                            .border_1()
                            .border_color(theme.border_subtle)
                            .hover(move |s| s.bg(theme.bg_selected))
                            .flex()
                            .items_center()
                            .text_size(px(12.))
                            .text_color(theme.text_primary)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.open_settings_modal(window, cx);
                            }))
                            .child("Settings"),
                    )
                    .child(
                        div()
                            .id("write-banner-dismiss-btn")
                            .focusable()
                            .role(Role::Button)
                            .aria_label("Dismiss error")
                            .w(px(26.))
                            .h(px(26.))
                            .rounded(px(6.))
                            .cursor_pointer()
                            .hover(move |s| s.bg(theme.bg_elevated))
                            .flex()
                            .items_center()
                            .justify_center()
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.write_bridge_error = None;
                                cx.notify();
                            }))
                            .child(render_ui_icon(UiIcon::Close, 13.0, theme.text_muted)),
                    ),
            )
            .into_any_element()
    }

    fn render_composer_modal(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let is_edit = self.composer_editing_id.is_some();
        let title = if is_edit { "Edit memory" } else { "New memory" };
        let submit_label = if self.write_in_flight {
            "Saving…"
        } else if is_edit {
            "Save new version"
        } else {
            "Save memory"
        };

        let mut type_choices = vec!["fact", "preference", "decision", "procedure", "note"];
        if !type_choices.contains(&self.composer_type.as_str())
            && !self.composer_type.trim().is_empty()
        {
            type_choices.push("custom");
        }
        let active_type = self.composer_type.clone();
        let pool_choices = [
            ("event", "event"),
            ("note", "note"),
            ("procedure", "procedure"),
        ];

        div()
            .id("composer-backdrop")
            .absolute()
            .inset_0()
            .bg(theme.glass_scrim)
            .px(px(24.))
            .py(px(20.))
            .flex()
            .items_center()
            .justify_center()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    this.show_composer_modal = false;
                    window.focus(&this.focus_handle, cx);
                    cx.notify();
                }),
            )
            .child(
                div()
                    .id("composer-dialog")
                    .role(Role::Dialog)
                    .aria_label(title)
                    .w_full()
                    .max_w(px(580.))
                    .max_h(gpui::relative(0.9))
                    .rounded(px(16.))
                    .bg(theme.glass_panel)
                    .border_1()
                    .border_color(theme.glass_border)
                    .shadow_lg()
                    .overflow_hidden()
                    .flex()
                    .flex_col()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| {
                        cx.stop_propagation();
                    })
                    .child(
                        div()
                            .px(px(16.))
                            .py(px(12.))
                            .border_b_1()
                            .border_color(theme.border_subtle)
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(8.))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(2.))
                                    .child(
                                        div()
                                            .text_size(px(15.))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(theme.text_primary)
                                            .child(title),
                                    )
                                    .when(is_edit, |col| {
                                        col.child(
                                            div()
                                                .text_size(px(12.))
                                                .text_color(theme.text_muted)
                                                .child("Creates a new version via memos_store and supersedes the original."),
                                        )
                                    }),
                            )
                            .child(
                                div()
                                    .id("close-composer-modal")
                                    .focusable()
                                    .role(Role::Button)
                                    .aria_label("Close composer")
                                    .w(px(28.))
                                    .h(px(28.))
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .hover(move |s| s.bg(theme.bg_elevated))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.show_composer_modal = false;
                                        window.focus(&this.focus_handle, cx);
                                        cx.notify();
                                    }))
                                    .child(render_ui_icon(
                                        UiIcon::Close,
                                        14.0,
                                        theme.text_secondary,
                                    )),
                            ),
                    )
                    .child(
                        div()
                            .id("composer-scroll-body")
                            .flex_1()
                            .min_h_0()
                            .overflow_y_scroll()
                            .p(px(16.))
                            .flex()
                            .flex_col()
                            .gap(px(12.))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(6.))
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .justify_between()
                                            .child(
                                                div()
                                                    .text_size(px(13.))
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(theme.text_primary)
                                                    .child("Content"),
                                            )
                                            .child(
                                                div()
                                                    .text_size(px(12.))
                                                    .text_color(theme.text_muted)
                                                    .child("Required"),
                                            ),
                                    )
                                    .child(self.composer_content_input.clone()),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(6.))
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text_primary)
                                            .child("Type"),
                                    )
                                    .child(
                                        div()
                                            .flex()
                                            .flex_wrap()
                                            .gap(px(6.))
                                            .children(type_choices.into_iter().enumerate().map(
                                                |(ix, ty_key)| {
                                                    let value = if ty_key == "custom" {
                                                        active_type.clone()
                                                    } else {
                                                        ty_key.to_string()
                                                    };
                                                    let selected = self.composer_type == value;
                                                    let val_for_click = value.clone();
                                                    div()
                                                        .id(("composer-type-pill", ix))
                                                        .focusable()
                                                        .role(Role::Button)
                                                        .aria_label(format!("Type {value}"))
                                                        .aria_selected(selected)
                                                        .h(px(28.))
                                                        .px(px(10.))
                                                        .rounded(px(6.))
                                                        .cursor_pointer()
                                                        .bg(if selected {
                                                            theme.bg_selected
                                                        } else {
                                                            theme.bg_elevated
                                                        })
                                                        .border_1()
                                                        .border_color(if selected {
                                                            theme.accent
                                                        } else {
                                                            theme.border_subtle
                                                        })
                                                        .hover(move |s| s.bg(theme.bg_selected))
                                                        .flex()
                                                        .items_center()
                                                        .text_size(px(12.))
                                                        .text_color(if selected {
                                                            theme.text_primary
                                                        } else {
                                                            theme.text_secondary
                                                        })
                                                        .on_click(cx.listener(
                                                            move |this, _, _, cx| {
                                                                this.composer_type =
                                                                    val_for_click.clone();
                                                                cx.notify();
                                                            },
                                                        ))
                                                        .child(SharedString::from(value))
                                                },
                                            )),
                                    ),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(6.))
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text_primary)
                                            .child("Pool"),
                                    )
                                    .child(
                                        div()
                                            .flex()
                                            .flex_wrap()
                                            .gap(px(6.))
                                            .children(pool_choices.into_iter().enumerate().map(
                                                |(ix, (pool_val, label))| {
                                                    let selected = self.composer_pool == pool_val;
                                                    div()
                                                        .id(("composer-pool-pill", ix))
                                                        .focusable()
                                                        .role(Role::Button)
                                                        .aria_label(format!("Pool {label}"))
                                                        .aria_selected(selected)
                                                        .h(px(28.))
                                                        .px(px(10.))
                                                        .rounded(px(6.))
                                                        .cursor_pointer()
                                                        .bg(if selected {
                                                            theme.bg_selected
                                                        } else {
                                                            theme.bg_elevated
                                                        })
                                                        .border_1()
                                                        .border_color(if selected {
                                                            theme.accent
                                                        } else {
                                                            theme.border_subtle
                                                        })
                                                        .hover(move |s| s.bg(theme.bg_selected))
                                                        .flex()
                                                        .items_center()
                                                        .text_size(px(12.))
                                                        .text_color(if selected {
                                                            theme.text_primary
                                                        } else {
                                                            theme.text_secondary
                                                        })
                                                        .on_click(cx.listener(
                                                            move |this, _, _, cx| {
                                                                this.composer_pool =
                                                                    pool_val.to_string();
                                                                cx.notify();
                                                            },
                                                        ))
                                                        .child(label)
                                                },
                                            )),
                                    ),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(6.))
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .justify_between()
                                            .child(
                                                div()
                                                    .text_size(px(13.))
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(theme.text_primary)
                                                    .child("Tags"),
                                            )
                                            .child(
                                                div()
                                                    .text_size(px(12.))
                                                    .text_color(theme.text_muted)
                                                    .child("Comma-separated"),
                                            ),
                                    )
                                    .child(self.composer_tags_input.clone()),
                            )
                            .child(
                                div()
                                    .flex()
                                    .when(self.compact_layout, |f| f.flex_col())
                                    .gap(px(10.))
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w(px(0.))
                                            .flex()
                                            .flex_col()
                                            .gap(px(6.))
                                            .child(
                                                div()
                                                    .text_size(px(13.))
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(theme.text_primary)
                                                    .child("Namespace"),
                                            )
                                            .child(self.composer_namespace_input.clone()),
                                    )
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w(px(0.))
                                            .flex()
                                            .flex_col()
                                            .gap(px(6.))
                                            .child(
                                                div()
                                                    .text_size(px(13.))
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(theme.text_primary)
                                                    .child("Context"),
                                            )
                                            .child(self.composer_context_input.clone()),
                                    ),
                            )
                            .when_some(self.composer_validation_error.clone(), |col, msg| {
                                col.child(
                                    div()
                                        .px(px(10.))
                                        .py(px(8.))
                                        .rounded(px(6.))
                                        .bg(theme.bg_app)
                                        .border_1()
                                        .border_color(theme.danger)
                                        .text_size(px(12.))
                                        .text_color(theme.danger)
                                        .child(SharedString::from(msg)),
                                )
                            }),
                    )
                    .child(
                        div()
                            .px(px(16.))
                            .py(px(12.))
                            .bg(theme.bg_sunken)
                            .border_t_1()
                            .border_color(theme.border_subtle)
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(8.))
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(theme.text_muted)
                                    .child("via MemOS MCP"),
                            )
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.))
                                    .child(
                                        div()
                                            .id("composer-cancel-btn")
                                            .focusable()
                                            .role(Role::Button)
                                            .aria_label("Cancel")
                                            .h(px(32.))
                                            .px(px(12.))
                                            .rounded(px(6.))
                                            .cursor_pointer()
                                            .bg(theme.bg_elevated)
                                            .border_1()
                                            .border_color(theme.border_subtle)
                                            .hover(move |s| s.bg(theme.bg_selected))
                                            .flex()
                                            .items_center()
                                            .text_size(px(13.))
                                            .text_color(theme.text_primary)
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.show_composer_modal = false;
                                                window.focus(&this.focus_handle, cx);
                                                cx.notify();
                                            }))
                                            .child("Cancel"),
                                    )
                                    .child(
                                        div()
                                            .id("composer-submit-btn")
                                            .focusable()
                                            .role(Role::Button)
                                            .aria_label(submit_label)
                                            .h(px(32.))
                                            .px(px(14.))
                                            .rounded(px(6.))
                                            .cursor_pointer()
                                            .bg(theme.accent)
                                            .hover(move |s| s.opacity(0.92))
                                            .flex()
                                            .items_center()
                                            .text_size(px(13.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.primary_btn_fg)
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.submit_composer(window, cx);
                                            }))
                                            .child(submit_label),
                                    ),
                            ),
                    ),
            )
            .into_any_element()
    }

    fn render_forget_confirm_modal(
        &self,
        target: ForgetTarget,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        div()
            .id("forget-confirm-backdrop")
            .absolute()
            .inset_0()
            .bg(rgba(0x00000088))
            .px(px(24.))
            .flex()
            .items_center()
            .justify_center()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    this.forget_confirm_target = None;
                    window.focus(&this.focus_handle, cx);
                    cx.notify();
                }),
            )
            .child(
                div()
                    .id("forget-confirm-dialog")
                    .role(Role::Dialog)
                    .aria_label("Forget memory")
                    .w_full()
                    .max_w(px(440.))
                    .rounded(px(10.))
                    .bg(theme.bg_panel)
                    .border_1()
                    .border_color(theme.border_subtle)
                    .overflow_hidden()
                    .flex()
                    .flex_col()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| {
                        cx.stop_propagation();
                    })
                    .child(
                        div()
                            .h(px(44.))
                            .px(px(16.))
                            .border_b_1()
                            .border_color(theme.border_subtle)
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(
                                div()
                                    .text_size(px(15.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme.text_primary)
                                    .child("Forget memory?"),
                            )
                            .child(
                                div()
                                    .id("close-forget-modal")
                                    .focusable()
                                    .role(Role::Button)
                                    .aria_label("Close forget dialog")
                                    .w(px(28.))
                                    .h(px(28.))
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .hover(move |s| s.bg(theme.bg_elevated))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.forget_confirm_target = None;
                                        window.focus(&this.focus_handle, cx);
                                        cx.notify();
                                    }))
                                    .child(render_ui_icon(
                                        UiIcon::Close,
                                        14.0,
                                        theme.text_secondary,
                                    )),
                            ),
                    )
                    .child(
                        div()
                            .p(px(16.))
                            .flex()
                            .flex_col()
                            .gap(px(12.))
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .line_height(px(18.))
                                    .text_color(theme.text_secondary)
                                    .child("Calls memos_forget through your configured MemOS MCP server and removes this memory from the active store."),
                            )
                            .child(
                                div()
                                    .p(px(10.))
                                    .rounded(px(6.))
                                    .bg(theme.bg_app)
                                    .border_1()
                                    .border_color(theme.border_subtle)
                                    .flex()
                                    .flex_col()
                                    .gap(px(4.))
                                    .child(
                                        div()
                                            .font_family("Consolas")
                                            .text_size(px(11.))
                                            .text_color(theme.text_muted)
                                            .child(SharedString::from(format!(
                                                "mem:{}",
                                                target.short_id
                                            ))),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .text_color(theme.text_primary)
                                            .child(SharedString::from(target.preview)),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .px(px(16.))
                            .py(px(12.))
                            .bg(theme.bg_sunken)
                            .border_t_1()
                            .border_color(theme.border_subtle)
                            .flex()
                            .items_center()
                            .justify_end()
                            .gap(px(8.))
                            .child(
                                div()
                                    .id("forget-cancel-btn")
                                    .focusable()
                                    .role(Role::Button)
                                    .aria_label("Cancel")
                                    .h(px(30.))
                                    .px(px(12.))
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .bg(theme.bg_elevated)
                                    .border_1()
                                    .border_color(theme.border_subtle)
                                    .hover(move |s| s.bg(theme.bg_selected))
                                    .flex()
                                    .items_center()
                                    .text_size(px(13.))
                                    .text_color(theme.text_primary)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.forget_confirm_target = None;
                                        window.focus(&this.focus_handle, cx);
                                        cx.notify();
                                    }))
                                    .child("Cancel"),
                            )
                            .child(
                                div()
                                    .id("forget-confirm-btn")
                                    .focusable()
                                    .role(Role::Button)
                                    .aria_label("Confirm forget memory")
                                    .h(px(30.))
                                    .px(px(14.))
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .bg(theme.danger)
                                    .hover(move |s| s.opacity(0.92))
                                    .flex()
                                    .items_center()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(rgb(0xFFFFFF))
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.confirm_forget(window, cx);
                                    }))
                                    .child("Forget memory"),
                            ),
                    ),
            )
            .into_any_element()
    }

    fn start_peek_watcher(&mut self, cx: &mut Context<Self>) {
        self._peek_watch_task = Some(cx.spawn(async move |this, cx| {
            loop {
                let active = this
                    .read_with(cx, |app, _| app.window_active)
                    .unwrap_or(true);
                cx.background_executor()
                    .timer(Duration::from_secs(if active { 15 } else { 60 }))
                    .await;
                let res = this.update(cx, |app, cx| {
                    let suppressed = app.has_overlay_open(cx);
                    let reduce = cx.reduce_motion();
                    if app.momo_peek.should_start_peek(
                        Instant::now(),
                        suppressed,
                        reduce,
                        app.no_fun,
                    ) {
                        app.start_peek_animation(cx);
                    }
                });
                if res.is_err() {
                    break;
                }
            }
        }));
    }

    fn start_peek_animation(&mut self, cx: &mut Context<Self>) {
        if self._peek_anim_task.is_some() || self.no_fun || cx.reduce_motion() {
            return;
        }
        self._peek_anim_task = Some(cx.spawn(async move |this, cx| {
            loop {
                let mut keep_going = false;
                let res = this.update(cx, |app, cx| {
                    let suppressed = app.has_overlay_open(cx);
                    let sample = app.momo_peek.poll(
                        Instant::now(),
                        suppressed,
                        cx.reduce_motion(),
                        app.no_fun,
                    );
                    app.momo_peek_sample = sample;
                    keep_going = sample.animating;
                    if !keep_going {
                        app._peek_anim_task = None;
                    }
                    cx.notify();
                });
                if res.is_err() || !keep_going {
                    break;
                }
                cx.background_executor()
                    .timer(Duration::from_millis(33))
                    .await;
            }
        }));
    }

    fn on_root_key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.record_window_activity();
        let mods = event.keystroke.modifiers;
        let key_lower = event.keystroke.key.to_ascii_lowercase();

        if key_lower == "escape" && !mods.control && !mods.alt && !mods.platform {
            if self.forget_confirm_target.is_some() {
                self.forget_confirm_target = None;
                window.focus(&self.focus_handle, cx);
                cx.notify();
                return;
            }
            if self.show_composer_modal {
                self.show_composer_modal = false;
                window.focus(&self.focus_handle, cx);
                cx.notify();
                return;
            }
            if self.show_ingest_modal {
                self.show_ingest_modal = false;
                window.focus(&self.focus_handle, cx);
                cx.notify();
                return;
            }
            if self.show_save_view_modal {
                self.show_save_view_modal = false;
                window.focus(&self.focus_handle, cx);
                cx.notify();
                return;
            }
            if self.show_context_modal {
                self.show_context_modal = false;
                window.focus(&self.focus_handle, cx);
                cx.notify();
                return;
            }
            if self.show_shortcuts_modal {
                self.show_shortcuts_modal = false;
                window.focus(&self.focus_handle, cx);
                cx.notify();
                return;
            }
            if self.show_dream_diff_modal {
                self.show_dream_diff_modal = false;
                window.focus(&self.focus_handle, cx);
                cx.notify();
                return;
            }
            if self.show_health_modal {
                self.show_health_modal = false;
                window.focus(&self.focus_handle, cx);
                cx.notify();
                return;
            }
            if self.show_settings_modal {
                self.show_settings_modal = false;
                self.flush_dirty_settings();
                window.focus(&self.focus_handle, cx);
                cx.notify();
                return;
            }
            if self.show_harnesses_modal {
                self.show_harnesses_modal = false;
                self.pending_connect_id = None;
                window.focus(&self.focus_handle, cx);
                cx.notify();
                return;
            }
            if self.has_any_popover_open(cx) {
                self.dismiss_popovers(PopoverOwner::None, cx);
                return;
            }
            if self.detail_open && !self.has_overlay_open(cx) {
                self.close_detail(cx);
                return;
            }
        }

        if self.search_input.focus_handle(cx).is_focused(window) || self.has_overlay_open(cx) {
            self.konami.reset();
            return;
        }
        if mods.control || mods.alt || mods.platform || mods.function {
            return;
        }
        if matches!(
            key_lower.as_str(),
            "shift" | "control" | "alt" | "super" | "meta" | "capslock"
        ) {
            return;
        }

        let is_question = event.keystroke.key == "?" || (key_lower == "/" && mods.shift);
        if is_question && !event.is_held {
            self.open_shortcuts_modal(window, cx);
            return;
        }
        if key_lower == "/" && !mods.shift && !event.is_held {
            let h = self.search_input.focus_handle(cx);
            window.focus(&h, cx);
            return;
        }

        match self.active_surface {
            WorkspaceSurface::Today => match key_lower.as_str() {
                "j" | "down" => self.brief_view.update(cx, |b, cx| b.select_relative(1, cx)),
                "k" | "up" => self
                    .brief_view
                    .update(cx, |b, cx| b.select_relative(-1, cx)),
                "enter" if !event.is_held => {
                    self.brief_view.update(cx, |b, cx| b.open_selected(cx));
                }
                _ => {}
            },
            WorkspaceSurface::Review => match key_lower.as_str() {
                "j" | "down" => self
                    .review_view
                    .update(cx, |r, cx| r.select_relative(1, cx)),
                "k" | "up" => self
                    .review_view
                    .update(cx, |r, cx| r.select_relative(-1, cx)),
                "enter" if !event.is_held => {
                    self.review_view.update(cx, |r, cx| r.open_selected(cx));
                }
                _ => {}
            },
            WorkspaceSurface::Memories if self.view_mode == ViewMode::List => {
                match key_lower.as_str() {
                    "j" | "down" => {
                        self.list_view.update(cx, |l, cx| l.select_relative(1, cx));
                    }
                    "k" | "up" => {
                        self.list_view.update(cx, |l, cx| l.select_relative(-1, cx));
                    }
                    "home" => {
                        self.list_view.update(cx, |l, cx| l.select_edge(true, cx));
                    }
                    "end" => {
                        self.list_view.update(cx, |l, cx| l.select_edge(false, cx));
                    }
                    "enter" if !event.is_held => {
                        self.list_view.update(cx, |l, cx| l.open_selected(cx));
                    }
                    _ => {}
                }
            }
            WorkspaceSurface::Memories if self.view_mode == ViewMode::Graph => {
                match key_lower.as_str() {
                    "j" | "down" | "right" => {
                        self.graph_view.update(cx, |g, cx| g.step_keyboard(1, cx));
                    }
                    "k" | "up" | "left" => {
                        self.graph_view.update(cx, |g, cx| g.step_keyboard(-1, cx));
                    }
                    "home" => {
                        self.graph_view
                            .update(cx, |g, cx| g.step_keyboard(isize::MIN, cx));
                    }
                    "end" => {
                        self.graph_view
                            .update(cx, |g, cx| g.step_keyboard(isize::MAX, cx));
                    }
                    "enter" if !event.is_held => {
                        if let Some(id) = self.graph_view.read(cx).keyboard_selected_id() {
                            self.select_memory(id, false, cx);
                        }
                    }
                    _ => {}
                }
            }
            WorkspaceSurface::Memories => {}
        }

        if self.no_fun || event.is_held {
            return;
        }

        let k = KonamiKey::from_key_name(&key_lower);
        if self.konami.push(k, Instant::now()) {
            let currently_on = self.graph_view.read(cx).is_constellation();
            if !currently_on {
                if self.view_mode != ViewMode::Graph {
                    self.switch_view(ViewMode::Graph, cx);
                }
                self.graph_view.update(cx, |g, cx| {
                    g.set_active_visible(true, cx);
                    g.set_constellation(true, cx);
                });
            } else {
                self.graph_view
                    .update(cx, |g, cx| g.set_constellation(false, cx));
            }
        }
    }

    fn open_logs_folder(&mut self, cx: &mut Context<Self>) {
        let dir = telemetry::log_dir();
        cx.background_executor()
            .spawn(async move {
                let _ = std::fs::create_dir_all(&dir);
                let _ = open::that(dir);
            })
            .detach();
        self.set_notice("Opened logs directory", cx);
    }

    fn reveal_database_file(&mut self, cx: &mut Context<Self>) {
        let db_path = self.resolved_db.path.clone();
        cx.background_executor()
            .spawn(async move {
                reveal_path_in_file_manager(&db_path);
            })
            .detach();
        self.set_notice("Revealed database in file manager", cx);
    }

    fn copy_database_path(&mut self, cx: &mut Context<Self>) {
        let path_str = self.resolved_db.path.display().to_string();
        cx.write_to_clipboard(ClipboardItem::new_string(path_str));
        self.set_notice("Database path copied", cx);
    }

    fn copy_diagnostics(&mut self, cx: &mut Context<Self>) {
        let resolved_db = self.resolved_db.clone();
        let overview = self.overview.clone();
        let settings = self.settings.clone();
        let log_directory = telemetry::log_dir();
        let harnesses = self.harnesses.clone();

        self._diag_task = Some(cx.spawn(async move |this, cx| {
            let text = cx
                .background_executor()
                .spawn(async move {
                    telemetry::build_diagnostics_text(
                        &resolved_db,
                        overview.as_ref(),
                        &settings,
                        &log_directory,
                        &harnesses,
                    )
                })
                .await;

            let _ = this.update(cx, |app, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string(text));
                app.set_notice("Diagnostics copied to clipboard (no memory text)", cx);
            });
        }));
    }

    fn set_notice(&mut self, msg: impl Into<String>, cx: &mut Context<Self>) {
        self.status_notice = Some(msg.into());
        cx.notify();
        self._notice_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(2600))
                .await;
            let _ = this.update(cx, |app, cx| {
                app.status_notice = None;
                cx.notify();
            });
        }));
    }

    fn open_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.palette_return_focus = window.focused(cx);
        let items = self.list_view.read(cx).items().to_vec();
        let saved_views = self.settings.saved_views.clone();
        let write_mode = self.settings.write_mode;
        let has_selection = self.selected_id.is_some();
        self.palette.update(cx, |p, cx| {
            p.set_write_context(write_mode, has_selection, cx);
            p.open(&items, &saved_views, window, cx);
        });
    }

    fn execute_palette_action(
        &mut self,
        action: PaletteAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match action {
            PaletteAction::JumpToMemory(id) => {
                self.select_memory(id, true, cx);
            }
            PaletteAction::SwitchView(mode) => self.switch_view(mode, cx),
            PaletteAction::OpenToday => self.open_today_view(cx),
            PaletteAction::OpenReview => self.open_review_view(cx),
            PaletteAction::SwitchGraphMode(gm) => {
                self.graph_mode = gm;
                self.view_mode = ViewMode::Graph;
                self.settings.last_view_mode = Some(ViewMode::Graph);
                if !self.smoke_exit_after_first_frame {
                    self.settings.save_async();
                }
                self.graph_view
                    .update(cx, |g, cx| g.set_active_visible(true, cx));
                self.spawn_graph_load(cx);
                cx.notify();
            }
            PaletteAction::FitGraphView => {
                let was_graph = self.view_mode == ViewMode::Graph;
                if !was_graph {
                    self.switch_view(ViewMode::Graph, cx);
                }
                self.graph_view.update(cx, |g, cx| {
                    g.set_active_visible(true, cx);
                    g.fit_view(cx);
                });
            }
            PaletteAction::SetSort(sort) => {
                self.set_sort_order(sort, cx);
            }
            PaletteAction::NewMemory => {
                self.open_new_memory_composer(window, cx);
                return;
            }
            PaletteAction::EditSelectedMemory => {
                self.open_edit_memory_composer(window, cx);
                return;
            }
            PaletteAction::ForgetSelectedMemory => self.open_forget_confirm(cx),
            PaletteAction::ToggleTheme => self.toggle_theme(window, cx),
            PaletteAction::ToggleRowDensity => {
                let next = match self.settings.row_density {
                    RowDensity::Comfortable => RowDensity::Compact,
                    RowDensity::Compact => RowDensity::Comfortable,
                };
                self.set_row_density(next, cx);
            }
            PaletteAction::OpenHealth => self.open_health_modal(HealthPanelFilter::All, window, cx),
            PaletteAction::OpenDreamDiff => self.open_dream_diff_modal(window, cx),
            PaletteAction::PreviewContext => self.open_view_context_modal(window, cx),
            PaletteAction::SaveCurrentView => {
                self.open_save_view_modal(window, cx);
                return;
            }
            PaletteAction::DeleteSavedView(id) => self.delete_saved_view(&id, cx),
            PaletteAction::OpenShortcuts => self.open_shortcuts_modal(window, cx),
            PaletteAction::CopyActiveMarkdown => self.copy_active_memory_markdown(cx),
            PaletteAction::OpenHarnesses => self.open_harnesses_modal(window, cx),
            PaletteAction::OpenSettings => self.open_settings_modal(window, cx),
            PaletteAction::OptimizeStore => self.optimize_store(cx),
            PaletteAction::OpenLogs => self.open_logs_folder(cx),
            PaletteAction::CopyDiagnostics => self.copy_diagnostics(cx),
            PaletteAction::ClearFilters => self.clear_filters(cx),
        }
        window.focus(&self.focus_handle, cx);
    }

    fn copy_active_memory_markdown(&mut self, cx: &mut Context<Self>) {
        let md = if let Some(detail) = self.detail_view.read(cx).detail() {
            let mut lines = Vec::new();
            let trimmed_summary = detail.summary.trim();
            let heading = if trimmed_summary.is_empty() {
                detail.short_id.as_ref()
            } else {
                trimmed_summary
            };
            lines.push(format!("## [mem:{}] {}", detail.short_id, heading));
            lines.push(String::new());
            lines.push(format!(
                "- Type: `{}` · Namespace: `{}` · Trust: `{:.2}` · Importance: `{:.2}`",
                detail.node_type, detail.namespace, detail.trust_score, detail.importance
            ));
            if !detail.tags.is_empty() {
                let tags = detail
                    .tags
                    .iter()
                    .map(|t| format!("#{t}"))
                    .collect::<Vec<_>>()
                    .join(" ");
                lines.push(format!("- Tags: {tags}"));
            }
            let body = if !detail.content.trim().is_empty() {
                detail.content.trim()
            } else {
                trimmed_summary
            };
            if !body.is_empty() {
                lines.push(String::new());
                lines.push(body.to_string());
            }
            Some(lines.join("\n"))
        } else if let Some(sel_id) = self.selected_id.as_deref() {
            self.list_view
                .read(cx)
                .items()
                .iter()
                .find(|item| item.id == sel_id)
                .map(|item| {
                    format!(
                        "## [mem:{}] {}\n\n- Type: `{}` · Namespace: `{}`\n",
                        item.short_id, item.preview, item.node_type, item.namespace
                    )
                })
        } else {
            None
        };

        if let Some(markdown) = md {
            cx.write_to_clipboard(ClipboardItem::new_string(markdown));
            self.status_notice = Some("Copied active memory as Markdown.".to_string());
        } else {
            self.status_notice = Some("Select a memory first to copy as Markdown.".to_string());
        }
        cx.notify();
    }

    fn on_open_palette(&mut self, _: &OpenPalette, window: &mut Window, cx: &mut Context<Self>) {
        if self.palette.read(cx).is_open() {
            self.palette.update(cx, |p, cx| p.close(cx));
        } else {
            self.open_palette(window, cx);
        }
    }

    fn on_focus_search(&mut self, _: &FocusSearch, window: &mut Window, cx: &mut Context<Self>) {
        let h = self.search_input.focus_handle(cx);
        window.focus(&h, cx);
    }

    fn on_switch_list(&mut self, _: &SwitchToList, _: &mut Window, cx: &mut Context<Self>) {
        self.switch_view(ViewMode::List, cx);
    }

    fn on_switch_graph(&mut self, _: &SwitchToGraph, _: &mut Window, cx: &mut Context<Self>) {
        self.switch_view(ViewMode::Graph, cx);
    }

    fn on_toggle_theme(&mut self, _: &ToggleTheme, window: &mut Window, cx: &mut Context<Self>) {
        self.toggle_theme(window, cx);
    }

    fn render_consent_modal(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let has_dsn = telemetry::resolve_dsn().is_some();
        div()
            .id("consent-backdrop")
            .absolute()
            .inset_0()
            .bg(rgba(0x00000099))
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .id("consent-dialog")
                    .role(Role::Dialog)
                    .aria_label("Crash reporting consent")
                    .w(px(480.))
                    .p(px(24.))
                    .rounded(px(10.))
                    .bg(theme.bg_panel)
                    .border_1()
                    .border_color(theme.border_subtle)
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(
                                div()
                                    .text_size(px(19.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme.text_primary)
                                    .child("Crash reporting"),
                            )
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.))
                                    .child(status_dot(theme.success))
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .text_color(theme.text_muted)
                                            .child("Off by default"),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(13.))
                            .line_height(px(18.))
                            .text_color(theme.text_secondary)
                            .child("Local rotating logs and offline crash reports always work without a network connection."),
                    )
                    .child(
                        div()
                            .p(px(12.))
                            .rounded(px(6.))
                            .bg(theme.bg_app)
                            .border_1()
                            .border_color(theme.border_subtle)
                            .text_size(px(12.))
                            .line_height(px(17.))
                            .text_color(theme.text_muted)
                            .child(if has_dsn {
                                "If you opt in, Sentry sends panic diagnostics containing only app version, OS, error kind, and a random install ID. Memory content, search queries, and paths are stripped."
                            } else {
                                "No Sentry DSN is configured in this build, so crash reports remain strictly local on your machine."
                            }),
                    )
                    .child(
                        div()
                            .flex()
                            .justify_end()
                            .gap(px(8.))
                            .pt(px(4.))
                            .child(
                                div()
                                    .id("consent-decline")
                                    .focusable()
                                    .role(Role::Button)
                                    .aria_label("Keep crash reports off")
                                    .h(px(34.))
                                    .px(px(14.))
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .bg(theme.bg_elevated)
                                    .border_1()
                                    .border_color(theme.border_subtle)
                                    .hover(move |s| s.bg(theme.bg_selected))
                                    .flex()
                                    .items_center()
                                    .text_size(px(13.))
                                    .text_color(theme.text_primary)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.set_crash_consent(false, cx);
                                    }))
                                    .child("Keep off"),
                            )
                            .child(
                                div()
                                    .id("consent-accept")
                                    .focusable()
                                    .role(Role::Button)
                                    .aria_label("Enable scrubbed crash reports")
                                    .h(px(34.))
                                    .px(px(14.))
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .bg(theme.accent)
                                    .flex()
                                    .items_center()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.primary_btn_fg)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.set_crash_consent(true, cx);
                                    }))
                                    .child("Enable scrubbed reports"),
                            ),
                    ),
            )
            .into_any_element()
    }

    fn render_harnesses_modal(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let installed_count = self.harnesses.iter().filter(|d| d.installed).count();
        let total_harnesses = self.harnesses.len();
        let opencode_v2_installed = self
            .harnesses
            .iter()
            .any(|h| h.id == "opencode" && h.installed);
        let opencode_v1_installed = self
            .harnesses
            .iter()
            .any(|h| h.id == "opencode-v1" && h.installed);
        let harness_rows: Vec<AnyElement> = self
            .harnesses
            .iter()
            .enumerate()
            .map(|(ix, det)| {
                let selected = ix == self.selected_harness_ix;
                let dot_color = if det.memos_configured {
                    theme.success
                } else if det.installed {
                    theme.text_secondary
                } else {
                    theme.border
                };
                let is_legacy_sibling = !det.installed
                    && ((det.id == "opencode-v1" && opencode_v2_installed)
                        || (det.id == "opencode" && opencode_v1_installed));
                let base_sub = if let Some(ver) = det.version.as_deref() {
                    ver.to_string()
                } else if det.memos_configured {
                    "Connected".to_string()
                } else if det.installed {
                    "Installed".to_string()
                } else if is_legacy_sibling {
                    "Not detected · legacy".to_string()
                } else {
                    "Not found".to_string()
                };
                let subtitle = if det.print_only {
                    format!("{base_sub} · Print-only")
                } else {
                    base_sub
                };
                div()
                    .id(("harness-row", ix))
                    .focusable()
                    .role(Role::ListItem)
                    .aria_label(if det.display_name.contains(det.id) {
                        format!("{} · {}", det.display_name, subtitle)
                    } else {
                        format!("{} ({}) · {}", det.display_name, det.id, subtitle)
                    })
                    .aria_selected(selected)
                    .w_full()
                    .h(px(48.))
                    .px(px(10.))
                    .rounded(px(6.))
                    .cursor_pointer()
                    .bg(if selected {
                        theme.bg_selected
                    } else {
                        gpui::transparent_black()
                    })
                    .hover(move |s| s.bg(theme.bg_elevated))
                    .focus_visible(move |s| s.border_1().border_color(theme.accent))
                    // Select on press, not release. The first click after the modal
                    // opens was only painting hover; the inspector caught up on the
                    // second click. Press-to-select makes the row and inspector agree
                    // immediately.
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _, _, cx| {
                            this.spawn_harness_detail(ix, cx);
                        }),
                    )
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .w(px(2.))
                            .h(px(22.))
                            .rounded(px(1.))
                            .flex_shrink_0()
                            .bg(if selected {
                                theme.accent
                            } else {
                                gpui::transparent_black()
                            }),
                    )
                    .child(status_dot(dot_color))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(1.))
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .font_weight(if selected {
                                        FontWeight::MEDIUM
                                    } else {
                                        FontWeight::NORMAL
                                    })
                                    .text_color(theme.text_primary)
                                    .truncate()
                                    .child(det.display_name),
                            )
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(theme.text_muted)
                                    .truncate()
                                    .child(SharedString::from(subtitle)),
                            ),
                    )
                    .into_any_element()
            })
            .collect();

        let inspector_pane: AnyElement = if let Some(info) = &self.harness_inspector {
            let harness_id = info.detection.id;
            let harness_display = info.detection.display_name;
            let stdio_snippet = info.plan.stdio_snippet.clone();
            let target_cfg_text = info.plan.target_config_path.display().to_string();
            let backup_cfg_text = info.plan.backup_path.display().to_string();
            let diff_preview_text = info.plan.diff_preview.clone();
            let connect_pending = self.pending_connect_id == Some(harness_id);
            let reveal_target = info.reveal_path.clone();
            let db_path_for_launch = self.resolved_db.path.clone();
            let config_summary = info
                .detection
                .config_paths
                .first()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| {
                    format!("{} (not created)", info.plan.target_config_path.display())
                });
            let status_color = if info.detection.memos_configured {
                theme.success
            } else if info.detection.installed {
                theme.text_secondary
            } else {
                theme.text_muted
            };
            let inspector_is_legacy = !info.detection.installed
                && ((info.detection.id == "opencode-v1" && opencode_v2_installed)
                    || (info.detection.id == "opencode" && opencode_v1_installed));
            let status_text = if info.detection.memos_configured {
                "MemOS MCP connected"
            } else if info.detection.installed {
                "Installed · Ready to connect"
            } else if inspector_is_legacy {
                "Legacy · not detected (other OpenCode major installed)"
            } else {
                "Not detected on this machine"
            };
            let servers_list: Vec<AnyElement> = info
                .servers
                .iter()
                .map(|srv| {
                    let transport = match &srv.transport {
                        McpTransport::Stdio { command, args } => {
                            format!("stdio: {} {}", command, args.join(" "))
                        }
                        McpTransport::Http { url } => format!("http: {url}"),
                    };
                    div()
                        .p(px(8.))
                        .rounded(px(6.))
                        .bg(theme.bg_app)
                        .border_1()
                        .border_color(theme.border_subtle)
                        .text_size(px(12.))
                        .text_color(theme.text_secondary)
                        .child(SharedString::from(format!(
                            "{} ({transport}) — {}",
                            srv.name,
                            srv.source_path.display()
                        )))
                        .into_any_element()
                })
                .collect();

            let is_print_only = info.detection.print_only || info.plan.print_only;
            let plan_notes = info.plan.notes.clone();

            div()
                .id("harness-detail-scroll")
                .flex_1()
                .min_w_0()
                .min_h_0()
                .overflow_y_scroll()
                .p(px(20.))
                .flex()
                .flex_col()
                .gap(px(16.))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(6.))
                        .child(
                            div()
                                .flex()
                                .flex_wrap()
                                .items_center()
                                .gap(px(8.))
                                .child(
                                    div()
                                        .text_size(px(19.))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(theme.text_primary)
                                        .child(info.detection.display_name),
                                )
                                .when(is_print_only, |row| {
                                    row.child(
                                        div()
                                            .id("harness-print-only-badge")
                                            .role(Role::Status)
                                            .aria_label("Print-only")
                                            .h(px(20.))
                                            .px(px(8.))
                                            .rounded(px(99.))
                                            .bg(theme.bg_elevated)
                                            .border_1()
                                            .border_color(theme.border)
                                            .flex()
                                            .items_center()
                                            .text_size(px(11.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text_secondary)
                                            .child("Print-only"),
                                    )
                                }),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .child(status_dot(status_color))
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .text_color(theme.text_secondary)
                                        .child(match &info.detection.version {
                                            Some(v) => format!("{status_text} · {v}"),
                                            None => status_text.to_string(),
                                        }),
                                ),
                        )
                        .child(
                            div()
                                .text_size(px(13.))
                                .line_height(px(18.))
                                .text_color(theme.text_muted)
                                .child(if is_print_only {
                                    "Print-only integration: copy the generated snippet below without overwriting your existing tool config files."
                                } else {
                                    "Launch an isolated session wired to your local MemOS store without modifying global config files."
                                }),
                        )
                        .when(!plan_notes.trim().is_empty(), |col| {
                            col.child(
                                div()
                                    .id("harness-plan-notes")
                                    .role(Role::Note)
                                    .aria_label(plan_notes.clone())
                                    .mt(px(4.))
                                    .p(px(10.))
                                    .rounded(px(6.))
                                    .bg(theme.bg_app)
                                    .border_1()
                                    .border_color(theme.border_subtle)
                                    .text_size(px(12.))
                                    .line_height(px(17.))
                                    .text_color(theme.text_secondary)
                                    .child(SharedString::from(plan_notes)),
                            )
                        }),
                )
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(8.))
                        .child(
                            div()
                                .id("harness-launch-memos-btn")
                                .focusable()
                                .role(Role::Button)
                                .aria_label(format!("Connect {harness_display}"))
                                .h(px(34.))
                                .px(px(16.))
                                .rounded(px(6.))
                                .cursor_pointer()
                                .bg(theme.accent)
                                .focus_visible(move |s| s.border_2().border_color(theme.text_primary))
                                .flex()
                                .items_center()
                                .text_size(px(13.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.primary_btn_fg)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.pending_connect_id = Some(harness_id);
                                    cx.notify();
                                }))
                                .child("Connect"),
                        )
                        .child(
                            div()
                                .id("launch-harness-btn")
                                .focusable()
                                .role(Role::Button)
                                .aria_label(format!("Open {harness_display} in terminal"))
                                .h(px(34.))
                                .px(px(12.))
                                .rounded(px(6.))
                                .cursor_pointer()
                                .bg(theme.bg_elevated)
                                .border_1()
                                .border_color(theme.border_subtle)
                                .hover(move |s| s.bg(theme.bg_selected))
                                .flex()
                                .items_center()
                                .text_size(px(13.))
                                .text_color(theme.text_primary)
                                .on_click(cx.listener(move |_this, _, _, cx| {
                                    cx.spawn(async move |weak, cx| {
                                        let outcome = cx
                                            .background_executor()
                                            .spawn(async move {
                                                let adapter = harness::all_adapters()
                                                    .into_iter()
                                                    .find(|a| a.id() == harness_id)
                                                    .ok_or_else(|| {
                                                        anyhow::anyhow!("Tool adapter missing")
                                                    })?;
                                                adapter.launch()
                                            })
                                            .await;
                                        let _ = weak.update(cx, |app, cx| match outcome {
                                            Ok(()) => app.set_notice(
                                                format!("Opened {harness_display} in terminal"),
                                                cx,
                                            ),
                                            Err(err) => app.set_notice(
                                                format!(
                                                    "Could not open {harness_display}: {err}"
                                                ),
                                                cx,
                                            ),
                                        });
                                    })
                                    .detach();
                                }))
                                .child("Open terminal"),
                        )
                        .child(
                            div()
                                .id("harness-copy-snippet-btn")
                                .focusable()
                                .role(Role::Button)
                                .aria_label(format!("Copy MCP snippet for {harness_display}"))
                                .h(px(34.))
                                .px(px(12.))
                                .rounded(px(6.))
                                .cursor_pointer()
                                .bg(theme.bg_elevated)
                                .border_1()
                                .border_color(theme.border_subtle)
                                .hover(move |s| s.bg(theme.bg_selected))
                                .flex()
                                .items_center()
                                .text_size(px(13.))
                                .text_color(theme.text_primary)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    cx.write_to_clipboard(ClipboardItem::new_string(
                                        stdio_snippet.clone(),
                                    ));
                                    this.set_notice(
                                        format!("Copied MCP snippet for {harness_display}"),
                                        cx,
                                    );
                                }))
                                .child("Copy MCP snippet"),
                        ),
                )
                .when(connect_pending, |col| {
                    let db_path_confirmed = db_path_for_launch.clone();
                    col.child(
                        div()
                            .id("harness-connect-confirm")
                            .p(px(14.))
                            .rounded(px(8.))
                            .bg(theme.bg_app)
                            .border_1()
                            .border_color(theme.border_subtle)
                            .flex()
                            .flex_col()
                            .gap(px(10.))
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme.text_primary)
                                    .child(format!("Review connection plan for {harness_display}")),
                            )
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .line_height(px(17.))
                                    .text_color(theme.text_secondary)
                                    .child("Isolated session launch sets MEMOS_DB and leaves your global config file untouched. Config & backup plan:"),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(4.))
                                    .text_size(px(12.))
                                    .text_color(theme.text_muted)
                                    .child(SharedString::from(format!("Target config: {target_cfg_text}")))
                                    .child(SharedString::from(format!("Backup path:   {backup_cfg_text}"))),
                            )
                            .child(
                                div()
                                    .id("harness-connect-diff-scroll")
                                    .max_h(px(96.))
                                    .overflow_y_scroll()
                                    .p(px(10.))
                                    .rounded(px(6.))
                                    .bg(theme.bg_sunken)
                                    .border_1()
                                    .border_color(theme.border_subtle)
                                    .text_size(px(12.))
                                    .line_height(px(17.))
                                    .text_color(theme.text_secondary)
                                    .child(SharedString::from(diff_preview_text.clone())),
                            )
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_end()
                                    .gap(px(8.))
                                    .child(
                                        div()
                                            .id("harness-cancel-connect-btn")
                                            .focusable()
                                            .role(Role::Button)
                                            .aria_label("Cancel connect")
                                            .cursor_pointer()
                                            .h(px(30.))
                                            .px(px(12.))
                                            .rounded(px(6.))
                                            .bg(theme.bg_elevated)
                                            .border_1()
                                            .border_color(theme.border_subtle)
                                            .hover(move |s| s.bg(theme.bg_selected))
                                            .flex()
                                            .items_center()
                                            .text_size(px(12.))
                                            .text_color(theme.text_primary)
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.pending_connect_id = None;
                                                cx.notify();
                                            }))
                                            .child("Cancel"),
                                    )
                                    .child(
                                        div()
                                            .id("harness-confirm-connect-btn")
                                            .focusable()
                                            .role(Role::Button)
                                            .aria_label(format!("Confirm connect {harness_display}"))
                                            .cursor_pointer()
                                            .h(px(30.))
                                            .px(px(14.))
                                            .rounded(px(6.))
                                            .bg(theme.accent)
                                            .hover(move |s| s.opacity(0.9))
                                            .flex()
                                            .items_center()
                                            .text_size(px(12.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.primary_btn_fg)
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                this.pending_connect_id = None;
                                                let db_path = db_path_confirmed.clone();
                                                cx.spawn(async move |weak, cx| {
                                                    let outcome = cx
                                                        .background_executor()
                                                        .spawn(async move {
                                                            let adapter = harness::all_adapters()
                                                                .into_iter()
                                                                .find(|a| a.id() == harness_id)
                                                                .ok_or_else(|| {
                                                                    anyhow::anyhow!("Tool adapter missing")
                                                                })?;
                                                            adapter.launch_with_memos(&db_path)
                                                        })
                                                        .await;
                                                    let _ = weak.update(cx, |app, cx| match outcome {
                                                        Ok(spec) => {
                                                            let note = if spec.uses_temp_mcp_config {
                                                                format!(
                                                                    "Connected {harness_display} with temporary MCP config"
                                                                )
                                                            } else {
                                                                format!(
                                                                    "Connected {harness_display} with MEMOS_DB env"
                                                                )
                                                            };
                                                            app.set_notice(note, cx);
                                                        }
                                                        Err(err) => {
                                                            app.set_notice(
                                                                format!(
                                                                    "Could not launch {harness_display}: {err}"
                                                                ),
                                                                cx,
                                                            );
                                                        }
                                                    });
                                                })
                                                .detach();
                                                cx.notify();
                                            }))
                                            .child("Confirm & launch"),
                                    ),
                            ),
                    )
                })
                .child(
                    div()
                        .border_t_1()
                        .border_color(theme.border_subtle)
                        .pt(px(12.))
                        .flex()
                        .flex_col()
                        .gap(px(10.))
                        .child(
                            div()
                                .id("tools-advanced-toggle")
                                .focusable()
                                .cursor_pointer()
                                .h(px(28.))
                                .px(px(4.))
                                .rounded(px(6.))
                                .hover(move |s| s.bg(theme.bg_elevated))
                                .flex()
                                .items_center()
                                .justify_between()
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.tools_advanced_open = !this.tools_advanced_open;
                                    cx.notify();
                                }))
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(theme.text_primary)
                                        .child("Advanced"),
                                )
                                .child(render_ui_icon(
                                    if self.tools_advanced_open {
                                        UiIcon::ChevronDown
                                    } else {
                                        UiIcon::ChevronRight
                                    },
                                    14.0,
                                    theme.text_muted,
                                )),
                        )
                        .when(self.tools_advanced_open, |adv| {
                            adv.child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(10.))
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .justify_between()
                                            .gap(px(8.))
                                            .child(
                                                div()
                                                    .flex_1()
                                                    .min_w_0()
                                                    .text_size(px(12.))
                                                    .text_color(theme.text_muted)
                                                    .truncate()
                                                    .child(format!("Config: {config_summary}")),
                                            )
                                            .child(
                                                div()
                                                    .id("harness-reveal-config-btn")
                                                    .focusable()
                                                    .h(px(26.))
                                                    .px(px(8.))
                                                    .rounded(px(6.))
                                                    .cursor_pointer()
                                                    .bg(theme.bg_elevated)
                                                    .border_1()
                                                    .border_color(theme.border_subtle)
                                                    .hover(move |s| s.bg(theme.bg_selected))
                                                    .flex()
                                                    .items_center()
                                                    .text_size(px(12.))
                                                    .text_color(if reveal_target.is_some() {
                                                        theme.text_primary
                                                    } else {
                                                        theme.text_muted
                                                    })
                                                    .on_click(cx.listener(move |this, _, _, cx| {
                                                        if let Some(target) = &reveal_target {
                                                            cx.reveal_path(target);
                                                            this.set_notice(
                                                                "Revealed config location",
                                                                cx,
                                                            );
                                                        } else {
                                                            this.set_notice(
                                                                "No config file on disk",
                                                                cx,
                                                            );
                                                        }
                                                    }))
                                                    .child("Reveal"),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text_muted)
                                            .child("Detected MCP servers"),
                                    )
                                    .when(servers_list.is_empty(), |el| {
                                        el.child(
                                            div()
                                                .text_size(px(12.))
                                                .text_color(theme.text_muted)
                                                .child("No existing MCP entries found."),
                                        )
                                    })
                                    .children(servers_list)
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text_muted)
                                            .child(SharedString::from(format!(
                                                "Install plan preview (not applied · backup: {})",
                                                info.plan.backup_path.display()
                                            ))),
                                    )
                                    .child(
                                        div()
                                            .w_full()
                                            .min_w_0()
                                            .p(px(10.))
                                            .rounded(px(6.))
                                            .bg(theme.bg_app)
                                            .border_1()
                                            .border_color(theme.border_subtle)
                                            .text_size(px(12.))
                                            .text_color(theme.text_secondary)
                                            .child(SharedString::from(
                                                info.plan.diff_preview.clone(),
                                            )),
                                    ),
                            )
                        }),
                )
                .into_any_element()
        } else {
            div()
                .flex_1()
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(13.))
                .text_color(theme.text_muted)
                .child("Checking installed tools…")
                .into_any_element()
        };

        div()
            .id("harness-backdrop")
            .absolute()
            .inset_0()
            .bg(theme.glass_scrim)
            .px(px(24.))
            .py(px(24.))
            .flex()
            .items_center()
            .justify_center()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    this.show_harnesses_modal = false;
                    this.pending_connect_id = None;
                    cx.notify();
                }),
            )
            .child(
                div()
                    .id("harness-dialog")
                    .role(Role::Dialog)
                    .aria_label("Tools")
                    .w_full()
                    .max_w(px(780.))
                    .h(px(580.))
                    .max_h(gpui::relative(0.88))
                    .rounded(px(16.))
                    .bg(theme.glass_panel)
                    .border_1()
                    .border_color(theme.glass_border)
                    .shadow_lg()
                    .overflow_hidden()
                    .flex()
                    .flex_col()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| {
                        cx.stop_propagation();
                    })
                    .child(
                        div()
                            .h(px(48.))
                            .px(px(16.))
                            .border_b_1()
                            .border_color(theme.border_subtle)
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.))
                                    .child(
                                        div()
                                            .text_size(px(15.))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(theme.text_primary)
                                            .child("Tools"),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .text_color(theme.text_muted)
                                            .font_features(tabular_nums())
                                            .child(SharedString::from(format!(
                                                "{installed_count} installed · {total_harnesses} supported"
                                            ))),
                                    ),
                            )
                            .child(
                                div()
                                    .id("close-harness-modal")
                                    .focusable()
                                    .role(Role::Button)
                                    .aria_label("Close tools modal")
                                    .w(px(28.))
                                    .h(px(28.))
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .hover(move |s| s.bg(theme.bg_elevated))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.show_harnesses_modal = false;
                                        this.pending_connect_id = None;
                                        window.focus(&this.focus_handle, cx);
                                        cx.notify();
                                    }))
                                    .child(render_ui_icon(
                                        UiIcon::Close,
                                        14.0,
                                        theme.text_secondary,
                                    )),
                            ),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_h_0()
                            .flex()
                            .child(
                                div()
                                    .id("harness-list-scroll")
                                    .w(px(224.))
                                    .h_full()
                                    .min_h_0()
                                    .overflow_y_scroll()
                                    .p(px(8.))
                                    .border_r_1()
                                    .border_color(theme.border_subtle)
                                    .flex()
                                    .flex_col()
                                    .gap(px(2.))
                                    .children(harness_rows),
                            )
                            .child(inspector_pane),
                    ),
            )
            .into_any_element()
    }

    fn render_settings_modal(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let dialog_h = (window.viewport_size().height.as_f32() * 0.88).max(420.0);
        let crash_on = self.settings.crash_reporting_enabled();
        let write_mode = self.settings.write_mode && self.writer_preflight.compatible;
        let preflight = self.writer_preflight.clone();
        let themes = [
            (ThemeMode::System, "System"),
            (ThemeMode::Light, "Light"),
            (ThemeMode::Dark, "Dark"),
        ];
        let default_views = [(ViewMode::List, "List"), (ViewMode::Graph, "Graph")];
        let densities = [
            (RowDensity::Comfortable, "Comfortable (64 px)"),
            (RowDensity::Compact, "Compact (48 px)"),
        ];

        div()
            .id("settings-backdrop")
            .absolute()
            .inset_0()
            .bg(theme.glass_scrim)
            .px(px(24.))
            .py(px(20.))
            .flex()
            .items_center()
            .justify_center()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    this.show_settings_modal = false;
                    this.flush_dirty_settings();
                    window.focus(&this.focus_handle, cx);
                    cx.notify();
                }),
            )
            .child(
                div()
                    .id("settings-dialog")
                    .role(Role::Dialog)
                    .aria_label("Settings")
                    .w(px(520.))
                    .max_w(gpui::relative(0.92))
                    .h(px(dialog_h))
                    .max_h(gpui::relative(0.92))
                    .rounded(px(16.))
                    .bg(theme.glass_panel)
                    .border_1()
                    .border_color(theme.glass_border)
                    .shadow_lg()
                    .overflow_hidden()
                    .flex()
                    .flex_col()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| {
                        cx.stop_propagation();
                    })
                    .child(
                        div()
                            .h(px(52.))
                            .px(px(24.))
                            .border_b_1()
                            .border_color(theme.border_subtle)
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(
                                div()
                                    .text_size(px(17.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme.text_primary)
                                    .child("Settings"),
                            )
                            .child(
                                div()
                                    .id("close-settings-modal")
                                    .focusable()
                                    .role(Role::Button)
                                    .aria_label("Close settings")
                                    .w(px(28.))
                                    .h(px(28.))
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .hover(move |s| s.bg(theme.bg_elevated))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.show_settings_modal = false;
                                        this.flush_dirty_settings();
                                        window.focus(&this.focus_handle, cx);
                                        cx.notify();
                                    }))
                                    .child(render_ui_icon(
                                        UiIcon::Close,
                                        14.0,
                                        theme.text_secondary,
                                    )),
                            ),
                    )
                    .child(
                        div()
                            .id("settings-scroll-wrap")
                            .relative()
                            .flex_1()
                            .w_full()
                            .min_w(px(0.))
                            .min_h_0()
                            .child(
                                div()
                                    .id("settings-scroll-body")
                                    .w_full()
                                    .min_w(px(0.))
                                    .h_full()
                                    .overflow_y_scroll()
                                    .overflow_x_hidden()
                                    .track_scroll(&self.settings_scroll)
                                    .p(px(24.))
                            .flex()
                            .flex_col()
                            .gap(px(16.))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(8.))
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text_primary)
                                            .child("Appearance"),
                                    )
                                    .child(
                                        div()
                                            .p(px(3.))
                                            .rounded(px(8.))
                                            .bg(theme.bg_app)
                                            .border_1()
                                            .border_color(theme.border_subtle)
                                            .flex()
                                            .items_center()
                                            .gap(px(3.))
                                            .children(themes.into_iter().enumerate().map(
                                                |(ix, (mode, label))| {
                                                    let active = self.settings.theme == mode;
                                                    div()
                                                        .id(("settings-theme", ix))
                                                        .focusable()
                                                        .role(Role::Button)
                                                        .aria_label(format!("Theme {label}"))
                                                        .aria_selected(active)
                                                        .cursor_pointer()
                                                        .flex_1()
                                                        .h(px(30.))
                                                        .rounded(px(6.))
                                                        .bg(if active {
                                                            theme.bg_elevated
                                                        } else {
                                                            gpui::transparent_black()
                                                        })
                                                        .when(active, |el| {
                                                            el.border_1().border_color(theme.border)
                                                        })
                                                        .flex()
                                                        .items_center()
                                                        .justify_center()
                                                        .text_size(px(13.))
                                                        .text_color(if active {
                                                            theme.text_primary
                                                        } else {
                                                            theme.text_muted
                                                        })
                                                        .on_click(cx.listener(
                                                            move |this, _, window, cx| {
                                                                this.settings.theme = mode;
                                                                this.settings.save_async();
                                                                let resolved =
                                                                    ThemePalette::resolve(
                                                                        mode,
                                                                        window.appearance(),
                                                                    );
                                                                this.apply_theme_palette(
                                                                    resolved, window, cx,
                                                                );
                                                            },
                                                        ))
                                                        .child(label)
                                                },
                                            )),
                                    ),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(8.))
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text_primary)
                                            .child("Default view"),
                                    )
                                    .child(
                                        div()
                                            .p(px(3.))
                                            .rounded(px(8.))
                                            .bg(theme.bg_app)
                                            .border_1()
                                            .border_color(theme.border_subtle)
                                            .flex()
                                            .items_center()
                                            .gap(px(3.))
                                            .children(default_views.into_iter().enumerate().map(
                                                |(ix, (vm, label))| {
                                                    let active = self.settings.default_view == vm;
                                                    div()
                                                        .id(("settings-view", ix))
                                                        .focusable()
                                                        .role(Role::Button)
                                                        .aria_label(format!("Default view {label}"))
                                                        .aria_selected(active)
                                                        .cursor_pointer()
                                                        .flex_1()
                                                        .h(px(30.))
                                                        .rounded(px(6.))
                                                        .bg(if active {
                                                            theme.bg_elevated
                                                        } else {
                                                            gpui::transparent_black()
                                                        })
                                                        .when(active, |el| {
                                                            el.border_1().border_color(theme.border)
                                                        })
                                                        .flex()
                                                        .items_center()
                                                        .justify_center()
                                                        .text_size(px(13.))
                                                        .text_color(if active {
                                                            theme.text_primary
                                                        } else {
                                                            theme.text_muted
                                                        })
                                                        .on_click(cx.listener(
                                                            move |this, _, _, cx| {
                                                                this.settings.default_view = vm;
                                                                this.settings.save_async();
                                                                cx.notify();
                                                            },
                                                        ))
                                                        .child(label)
                                                },
                                            )),
                                    ),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(8.))
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text_primary)
                                            .child("Row density"),
                                    )
                                    .child(
                                        div()
                                            .p(px(3.))
                                            .rounded(px(8.))
                                            .bg(theme.bg_app)
                                            .border_1()
                                            .border_color(theme.border_subtle)
                                            .flex()
                                            .items_center()
                                            .gap(px(3.))
                                            .children(densities.into_iter().enumerate().map(
                                                |(ix, (density, label))| {
                                                    let active = self.settings.row_density == density;
                                                    div()
                                                        .id(("settings-density", ix))
                                                        .focusable()
                                                        .role(Role::Button)
                                                        .aria_label(format!("Row density {label}"))
                                                        .aria_selected(active)
                                                        .cursor_pointer()
                                                        .flex_1()
                                                        .h(px(30.))
                                                        .rounded(px(6.))
                                                        .bg(if active {
                                                            theme.bg_elevated
                                                        } else {
                                                            gpui::transparent_black()
                                                        })
                                                        .when(active, |el| {
                                                            el.border_1().border_color(theme.border)
                                                        })
                                                        .flex()
                                                        .items_center()
                                                        .justify_center()
                                                        .text_size(px(13.))
                                                        .text_color(if active {
                                                            theme.text_primary
                                                        } else {
                                                            theme.text_muted
                                                        })
                                                        .on_click(cx.listener(
                                                            move |this, _, _, cx| {
                                                                this.set_row_density(density, cx);
                                                            },
                                                        ))
                                                        .child(label)
                                                },
                                            )),
                                    ),
                            )
                            .child(
                                div()
                                    .border_t_1()
                                    .border_color(theme.border_subtle)
                                    .pt(px(16.))
                                    .flex()
                                    .flex_col()
                                    .gap(px(12.))
                                    .child(
                                        div()
                                            .id("settings-write-mode-toggle")
                                            .focusable()
                                            .role(Role::Switch)
                                            .aria_label("Write mode (MCP)")
                                            .aria_selected(write_mode)
                                            .cursor_pointer()
                                            .flex()
                                            .items_center()
                                            .justify_between()
                                            .gap(px(12.))
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                this.set_write_mode(!write_mode, cx);
                                            }))
                                            .child(
                                                div()
                                                    .flex_1()
                                                    .min_w(px(0.))
                                                    .flex()
                                                    .flex_col()
                                                    .gap(px(3.))
                                                    .child(
                                                        div()
                                                            .text_size(px(13.))
                                                            .font_weight(FontWeight::MEDIUM)
                                                            .text_color(theme.text_primary)
                                                            .child("Let your AI save changes"),
                                                    )
                                                    .child(
                                                        div()
                                                            .text_size(px(12.))
                                                            .line_height(px(17.))
                                                            .text_color(theme.text_muted)
                                                            .child("Approve, edit, forget, and add memories. Every change is logged and can be traced back."),
                                                    ),
                                            )
                                            .child(
                                                div()
                                                    .w(px(36.))
                                                    .h(px(20.))
                                                    .p(px(2.))
                                                    .rounded_full()
                                                    .flex_shrink_0()
                                                    .bg(if write_mode {
                                                        theme.success
                                                    } else {
                                                        theme.bg_elevated
                                                    })
                                                    .border_1()
                                                    .border_color(theme.border)
                                                    .flex()
                                                    .items_center()
                                                    .justify_end()
                                                    .when(!write_mode, |t| t.justify_start())
                                                    .child(
                                                        div()
                                                            .w(px(14.))
                                                            .h(px(14.))
                                                            .rounded_full()
                                                            .bg(theme.text_primary),
                                                    ),
                                            ),
                                    )
                                    .when_some(preflight.human_message(), |col, msg| {
                                        col.child(
                                            div()
                                                .id("settings-write-preflight-warning")
                                                .role(Role::Status)
                                                .aria_label(msg.clone())
                                                .p(px(10.))
                                                .rounded(px(6.))
                                                .bg(theme.bg_sunken)
                                                .border_1()
                                                .border_color(theme.warning)
                                                .flex()
                                                .items_start()
                                                .gap(px(8.))
                                                .child(
                                                    div().pt(px(2.)).flex_shrink_0().child(
                                                        render_ui_icon(
                                                            UiIcon::Warning,
                                                            14.0,
                                                            theme.warning,
                                                        ),
                                                    ),
                                                )
                                                .child(
                                                    div()
                                                        .flex_1()
                                                        .min_w(px(0.))
                                                        .text_size(px(12.))
                                                        .line_height(px(17.))
                                                        .text_color(theme.text_secondary)
                                                        .child(SharedString::from(msg)),
                                                ),
                                        )
                                    })
                                    .child(
                                        div()
                                            .flex()
                                            .flex_col()
                                            .gap(px(8.))
                                            .child(
                                                div()
                                                    .text_size(px(12.))
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(theme.text_secondary)
                                                    .child("Writer command"),
                                            )
                                            .child(self.writer_cmd_input.clone())
                                            .child(
                                                div()
                                                    .flex()
                                                    .flex_wrap()
                                                    .items_center()
                                                    .justify_start()
                                                    .gap(px(8.))
                                                    .child(
                                                        div()
                                                            .id("settings-writer-test")
                                                            .focusable()
                                                            .role(Role::Button)
                                                            .aria_label("Test writer connection")
                                                            .h(px(28.))
                                                            .px(px(10.))
                                                            .rounded(px(6.))
                                                            .cursor_pointer()
                                                            .bg(theme.bg_elevated)
                                                            .border_1()
                                                            .border_color(theme.border_subtle)
                                                            .hover(move |s| s.bg(theme.bg_selected))
                                                            .flex()
                                                            .items_center()
                                                            .text_size(px(12.))
                                                            .text_color(theme.text_primary)
                                                            .on_click(cx.listener(|this, _, _, cx| {
                                                                this.run_writer_ping(cx);
                                                            }))
                                                            .child(if self.writer_testing {
                                                                "Testing…"
                                                            } else {
                                                                "Test connection"
                                                            }),
                                                    )
                                                    .when_some(detect_local_writer(), |row, local| {
                                                        let local_cmd = local.command.clone();
                                                        let already_active = self
                                                            .settings
                                                            .effective_writer_command()
                                                            == local_cmd;
                                                        row.child(
                                                            div()
                                                                .id("settings-writer-use-local")
                                                                .focusable()
                                                                .role(Role::Button)
                                                                .aria_label("Use local CLI")
                                                                .tooltip(tooltip_view(
                                                                    SharedString::from(format!(
                                                                        "Switch to local writer: {}",
                                                                        local.command
                                                                    )),
                                                                    theme,
                                                                ))
                                                                .h(px(28.))
                                                                .px(px(10.))
                                                                .rounded(px(6.))
                                                                .cursor_pointer()
                                                                .bg(if already_active {
                                                                    theme.bg_selected
                                                                } else {
                                                                    theme.bg_elevated
                                                                })
                                                                .border_1()
                                                                .border_color(if already_active {
                                                                    theme.accent
                                                                } else {
                                                                    theme.border_subtle
                                                                })
                                                                .hover(move |s| s.bg(theme.bg_selected))
                                                                .flex()
                                                                .items_center()
                                                                .text_size(px(12.))
                                                                .text_color(theme.text_primary)
                                                                .on_click(cx.listener(
                                                                    move |this, _, _, cx| {
                                                                        this.use_local_writer_command(
                                                                            local_cmd.clone(),
                                                                            cx,
                                                                        );
                                                                    },
                                                                ))
                                                                .child("Use local CLI"),
                                                        )
                                                    })
                                                    .child(
                                                        div()
                                                            .id("settings-writer-reset")
                                                            .focusable()
                                                            .role(Role::Button)
                                                            .aria_label("Reset writer command to default")
                                                            .h(px(28.))
                                                            .px(px(10.))
                                                            .rounded(px(6.))
                                                            .cursor_pointer()
                                                            .bg(gpui::transparent_black())
                                                            .border_1()
                                                            .border_color(theme.border_subtle)
                                                            .hover(move |s| s.bg(theme.bg_elevated))
                                                            .flex()
                                                            .items_center()
                                                            .text_size(px(12.))
                                                            .text_color(theme.text_secondary)
                                                            .on_click(cx.listener(|this, _, _, cx| {
                                                                this.reset_writer_command(cx);
                                                            }))
                                                            .child("Reset to default"),
                                                    )
                                                    .child(
                                                        div()
                                                            .text_size(px(11.))
                                                            .text_color(theme.text_muted)
                                                            .child(format!("Fallback: {DEFAULT_WRITER_COMMAND}")),
                                                    ),
                                            )
                                            .when_some(
                                                self.writer_test_status.clone(),
                                                |col, status| {
                                                    let (dot_color, text_color, msg) = match status {
                                                        Ok(info) => (
                                                            theme.success,
                                                            theme.success,
                                                            info.format_settings_status(),
                                                        ),
                                                        Err(err) => {
                                                            (theme.danger, theme.danger, err)
                                                        }
                                                    };
                                                    col.child(
                                                        div()
                                                            .id("settings-writer-status")
                                                            .role(Role::Status)
                                                            .aria_label(msg.clone())
                                                            .px(px(8.))
                                                            .py(px(6.))
                                                            .rounded(px(6.))
                                                            .bg(theme.bg_sunken)
                                                            .border_1()
                                                            .border_color(theme.border_subtle)
                                                            .flex()
                                                            .items_center()
                                                            .gap(px(6.))
                                                            .child(status_dot(dot_color))
                                                            .child(
                                                                div()
                                                                    .flex_1()
                                                                    .min_w(px(0.))
                                                                    .text_size(px(12.))
                                                                    .text_color(text_color)
                                                                    .child(SharedString::from(msg)),
                                                            ),
                                                    )
                                                },
                                            ),
                                    ),
                            )
                            .child(
                                div()
                                    .id("settings-privacy-toggle")
                                    .focusable()
                                    .role(Role::Switch)
                                    .aria_label("Crash reporting")
                                    .aria_selected(crash_on)
                                    .cursor_pointer()
                                    .border_t_1()
                                    .border_color(theme.border_subtle)
                                    .pt(px(16.))
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .gap(px(12.))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.set_crash_consent(!crash_on, cx);
                                    }))
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w(px(0.))
                                            .flex()
                                            .flex_col()
                                            .gap(px(3.))
                                            .child(
                                                div()
                                                    .text_size(px(13.))
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(theme.text_primary)
                                                    .child("Crash reporting"),
                                            )
                                            .child(
                                                div()
                                                    .text_size(px(12.))
                                                    .text_color(theme.text_muted)
                                                    .child("Sends scrubbed panic reports only; memory text stays local."),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .w(px(36.))
                                            .h(px(20.))
                                            .p(px(2.))
                                            .rounded_full()
                                            .flex_shrink_0()
                                            .bg(if crash_on {
                                                theme.success
                                            } else {
                                                theme.bg_elevated
                                            })
                                            .border_1()
                                            .border_color(theme.border)
                                            .flex()
                                            .items_center()
                                            .justify_end()
                                            .when(!crash_on, |t| t.justify_start())
                                            .child(
                                                div()
                                                    .w(px(14.))
                                                    .h(px(14.))
                                                    .rounded_full()
                                                    .bg(theme.text_primary),
                                            ),
                                    ),
                            )
                            .child(
                                div()
                                    .border_t_1()
                                    .border_color(theme.border_subtle)
                                    .pt(px(16.))
                                    .flex()
                                    .flex_col()
                                    .gap(px(8.))
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .justify_between()
                                            .gap(px(8.))
                                            .child(
                                                div()
                                                    .text_size(px(13.))
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(theme.text_primary)
                                                    .child("Database"),
                                            )
                                            .child(
                                                div()
                                                    .text_size(px(11.))
                                                    .text_color(theme.text_muted)
                                                    .child(self.resolved_db.source.label()),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .text_color(theme.text_secondary)
                                            .truncate()
                                            .child(self.resolved_db.path.display().to_string()),
                                    )
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .justify_start()
                                            .gap(px(8.))
                                            .child(
                                                div()
                                                    .id("settings-reveal-db")
                                                    .focusable()
                                                    .role(Role::Button)
                                                    .aria_label("Reveal database")
                                                    .h(px(28.))
                                                    .px(px(10.))
                                                    .rounded(px(6.))
                                                    .cursor_pointer()
                                                    .bg(theme.bg_elevated)
                                                    .border_1()
                                                    .border_color(theme.border_subtle)
                                                    .hover(move |s| s.bg(theme.bg_selected))
                                                    .flex()
                                                    .items_center()
                                                    .text_size(px(12.))
                                                    .text_color(theme.text_primary)
                                                    .on_click(cx.listener(|this, _, _, cx| {
                                                        this.reveal_database_file(cx);
                                                    }))
                                                    .child("Reveal database"),
                                            )
                                            .child(
                                                div()
                                                    .id("settings-copy-db-path")
                                                    .focusable()
                                                    .role(Role::Button)
                                                    .aria_label("Copy database path")
                                                    .h(px(28.))
                                                    .px(px(10.))
                                                    .rounded(px(6.))
                                                    .cursor_pointer()
                                                    .bg(gpui::transparent_black())
                                                    .border_1()
                                                    .border_color(theme.border_subtle)
                                                    .hover(move |s| s.bg(theme.bg_elevated))
                                                    .flex()
                                                    .items_center()
                                                    .text_size(px(12.))
                                                    .text_color(theme.text_secondary)
                                                    .on_click(cx.listener(|this, _, _, cx| {
                                                        this.copy_database_path(cx);
                                                    }))
                                                    .child("Copy path"),
                                            )
                                            .child(
                                                div()
                                                    .id("settings-optimize-store")
                                                    .focusable()
                                                    .role(Role::Button)
                                                    .aria_label("Optimize store indexes")
                                                    .tooltip(tooltip_view(
                                                        SharedString::from(
                                                            "Adds missing read-path indexes. Safe and repeatable.",
                                                        ),
                                                        theme,
                                                    ))
                                                    .h(px(28.))
                                                    .px(px(10.))
                                                    .rounded(px(6.))
                                                    .cursor_pointer()
                                                    .bg(gpui::transparent_black())
                                                    .border_1()
                                                    .border_color(theme.border_subtle)
                                                    .hover(move |s| s.bg(theme.bg_elevated))
                                                    .flex()
                                                    .items_center()
                                                    .text_size(px(12.))
                                                    .text_color(theme.text_secondary)
                                                    .on_click(cx.listener(|this, _, _, cx| {
                                                        this.optimize_store(cx);
                                                    }))
                                                    .child(if self.store_optimize_in_flight {
                                                        "Optimising…"
                                                    } else {
                                                        "Optimize store"
                                                    }),
                                            ),
                                    ),
                            )
                            .child(
                                div()
                                    .border_t_1()
                                    .border_color(theme.border_subtle)
                                    .pt(px(16.))
                                    .flex()
                                    .flex_col()
                                    .gap(px(8.))
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text_primary)
                                            .child("Diagnostics"),
                                    )
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .justify_start()
                                            .gap(px(8.))
                                            .child(
                                                div()
                                                    .id("settings-open-logs")
                                                    .focusable()
                                                    .h(px(28.))
                                                    .px(px(10.))
                                                    .rounded(px(6.))
                                                    .cursor_pointer()
                                                    .bg(theme.bg_elevated)
                                                    .border_1()
                                                    .border_color(theme.border_subtle)
                                                    .hover(move |s| s.bg(theme.bg_selected))
                                                    .flex()
                                                    .items_center()
                                                    .text_size(px(12.))
                                                    .text_color(theme.text_primary)
                                                    .on_click(cx.listener(|this, _, _, cx| {
                                                        this.open_logs_folder(cx);
                                                    }))
                                                    .child("Open logs folder"),
                                            )
                                            .child(
                                                div()
                                                    .id("settings-copy-diag")
                                                    .focusable()
                                                    .h(px(28.))
                                                    .px(px(10.))
                                                    .rounded(px(6.))
                                                    .cursor_pointer()
                                                    .bg(gpui::transparent_black())
                                                    .border_1()
                                                    .border_color(theme.border_subtle)
                                                    .hover(move |s| s.bg(theme.bg_elevated))
                                                    .flex()
                                                    .items_center()
                                                    .text_size(px(12.))
                                                    .text_color(theme.text_secondary)
                                                    .on_click(cx.listener(|this, _, _, cx| {
                                                        this.copy_diagnostics(cx);
                                                    }))
                                                    .child("Copy diagnostics"),
                                            ),
                                    ),
                            ),
                        )
                        .child(render_vertical_scroll_overlay(
                            self.settings_scroll.clone(),
                            theme.bg_panel,
                            theme,
                        ))
                    )
                    .child(
                        div()
                            .id("settings-about-footer")
                            .px(px(24.))
                            .py(px(12.))
                            .bg(theme.bg_sunken)
                            .border_t_1()
                            .border_color(theme.border_subtle)
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .justify_between()
                            .gap(px(12.))
                            .text_size(px(12.))
                            .text_color(theme.text_muted)
                            .font_features(tabular_nums())
                            .child(format!(
                                "v{} · Built {}",
                                telemetry::APP_VERSION,
                                APP_BUILD_DATE
                            ))
                            .child({
                                let active_ping = self.active_writer_ping();
                                let footer_mode =
                                    PingResult::settings_footer_mode(write_mode, active_ping.as_ref());
                                div()
                                    .id("settings-footer-mode")
                                    .role(Role::Status)
                                    .aria_label(footer_mode.clone())
                                    .child(SharedString::from(footer_mode))
                            }),
                    ),
            )
            .into_any_element()
    }

    fn apply_health_fix_filter(&mut self, filter: QueryFilter, cx: &mut Context<Self>) {
        self.show_health_modal = false;
        self.filter = filter;
        self.view_mode = ViewMode::List;
        self.settings.last_view_mode = Some(ViewMode::List);
        self.graph_view.update(cx, |g, cx| {
            g.set_active_visible(false, cx);
        });
        self.mark_custom_filter_changed(cx);
    }

    fn render_health_modal(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let report = self.health_report.as_ref();
        let status = self.health_status;
        let score = report.map(|h| h.score).unwrap_or(0);
        let dot_color = match status {
            StoreHealthStatus::Healthy | StoreHealthStatus::Many => theme.success,
            StoreHealthStatus::Contradictions => theme.danger,
            StoreHealthStatus::Stale => theme.warning,
            StoreHealthStatus::Empty => theme.text_muted,
        };
        let score_color = if status == StoreHealthStatus::Empty {
            theme.text_muted
        } else if score >= 80 {
            theme.success
        } else if score >= 50 {
            theme.warning
        } else {
            theme.danger
        };

        let filter = self.health_filter;
        let filter_pills = HealthPanelFilter::ALL
            .into_iter()
            .enumerate()
            .map(|(ix, f)| {
                let active = filter == f;
                div()
                    .id(("health-filter-pill", ix))
                    .focusable()
                    .cursor_pointer()
                    .h(px(28.))
                    .px(px(10.))
                    .rounded(px(6.))
                    .bg(if active {
                        theme.bg_selected
                    } else {
                        theme.bg_elevated
                    })
                    .border_1()
                    .border_color(if active {
                        theme.accent
                    } else {
                        theme.border_subtle
                    })
                    .hover(move |s| s.bg(theme.bg_selected))
                    .flex()
                    .items_center()
                    .text_size(px(12.))
                    .font_weight(if active {
                        FontWeight::MEDIUM
                    } else {
                        FontWeight::NORMAL
                    })
                    .text_color(theme.text_primary)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.health_filter = f;
                        cx.notify();
                    }))
                    .child(f.label())
            });

        #[derive(Clone, Copy)]
        enum HealthFixKind {
            Contradictions,
            StaleOrDrifted,
            Duplicates,
            LowTrust,
        }
        struct HealthFixRow {
            id: &'static str,
            kind: HealthFixKind,
            title: String,
            subtitle: String,
            badge_color: Hsla,
        }

        let now_ms = now_unix_ms();
        let stale_cutoff_ms =
            now_ms.saturating_sub(crate::core::health::STALE_STORE_AGE_DAYS * 86_400_000);
        let mut fix_rows: Vec<HealthFixRow> = Vec::new();
        if let Some(h) = report {
            if h.contradiction_count > 0
                && matches!(
                    filter,
                    HealthPanelFilter::All | HealthPanelFilter::Contradictions
                )
            {
                fix_rows.push(HealthFixRow {
                    id: "health-fix-contradictions",
                    kind: HealthFixKind::Contradictions,
                    title: "Contradicting memories".to_string(),
                    subtitle: format!("{} conflict pair(s) need review", h.contradiction_count),
                    badge_color: theme.danger,
                });
            }
            let stale_total = h.expired_count + h.drifted_source_count + h.stale_count;
            if stale_total > 0
                && matches!(filter, HealthPanelFilter::All | HealthPanelFilter::Stale)
            {
                fix_rows.push(HealthFixRow {
                    id: "health-fix-stale",
                    kind: HealthFixKind::StaleOrDrifted,
                    title: "Stale, expired, or drifted memories".to_string(),
                    subtitle: format!(
                        "{} expired · {} drifted · {} >90d old",
                        h.expired_count, h.drifted_source_count, h.stale_count
                    ),
                    badge_color: theme.warning,
                });
            }
            if h.duplicate_count > 0 && filter == HealthPanelFilter::All {
                fix_rows.push(HealthFixRow {
                    id: "health-fix-duplicates",
                    kind: HealthFixKind::Duplicates,
                    title: "Exact duplicate memories".to_string(),
                    subtitle: format!("{} excess copy record(s)", h.duplicate_count),
                    badge_color: theme.warning,
                });
            }
            if h.low_trust_count > 0
                && matches!(filter, HealthPanelFilter::All | HealthPanelFilter::Stale)
            {
                fix_rows.push(HealthFixRow {
                    id: "health-fix-low-trust",
                    kind: HealthFixKind::LowTrust,
                    title: "Low-trust memories".to_string(),
                    subtitle: format!("{} record(s) with trust < 0.50", h.low_trust_count),
                    badge_color: theme.text_muted,
                });
            }
        }

        let summary_rows: Vec<(String, String)> = if let Some(h) = report {
            match filter {
                HealthPanelFilter::Contradictions => vec![
                    (
                        "Contradictions".to_string(),
                        format!("{}", h.contradiction_count),
                    ),
                    (
                        "Quarantined".to_string(),
                        format!("{}", h.quarantined_count),
                    ),
                    ("Total memories".to_string(), format!("{}", h.node_count)),
                ],
                HealthPanelFilter::Stale => vec![
                    (
                        "Expired memories".to_string(),
                        format!("{}", h.expired_count),
                    ),
                    (
                        "Drifted sources".to_string(),
                        format!("{}", h.drifted_source_count),
                    ),
                    ("Aged (>90d)".to_string(), format!("{}", h.stale_count)),
                    (
                        "Newest update".to_string(),
                        h.newest_updated_at
                            .map(crate::core::model::format_timestamp_ms)
                            .unwrap_or_else(|| "—".to_string()),
                    ),
                ],
                HealthPanelFilter::All => vec![
                    ("Memories".to_string(), format!("{}", h.node_count)),
                    ("Edges".to_string(), format!("{}", h.edge_count)),
                    (
                        "Duplicate copies".to_string(),
                        format!("{}", h.duplicate_count),
                    ),
                    (
                        "Low-trust (< 0.50)".to_string(),
                        format!("{}", h.low_trust_count),
                    ),
                    (
                        "FTS5 index".to_string(),
                        if h.has_fts5 { "Ready" } else { "Absent" }.to_string(),
                    ),
                ],
            }
        } else {
            vec![("Status".to_string(), "Store unavailable".to_string())]
        };

        let show_contradiction_jump = report.is_some_and(|h| h.contradiction_count > 0)
            && matches!(
                filter,
                HealthPanelFilter::All | HealthPanelFilter::Contradictions
            );

        div()
            .id("health-modal-backdrop")
            .absolute()
            .inset_0()
            .bg(theme.glass_scrim)
            .flex()
            .items_center()
            .justify_center()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    this.show_health_modal = false;
                    window.focus(&this.focus_handle, cx);
                    cx.notify();
                }),
            )
            .child(
                div()
                    .id("health-dialog")
                    .role(Role::Dialog)
                    .aria_label("Store health")
                    .w(px(520.))
                    .max_w(gpui::relative(0.92))
                    .p(px(24.))
                    .rounded(px(16.))
                    .bg(theme.glass_panel)
                    .border_1()
                    .border_color(theme.glass_border)
                    .shadow_lg()
                    .flex()
                    .flex_col()
                    .gap(px(16.))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.))
                                    .child(status_dot(dot_color))
                                    .child(
                                        div()
                                            .text_size(px(19.))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(theme.text_primary)
                                            .child("Store health"),
                                    ),
                            )
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(10.))
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .text_color(theme.text_muted)
                                            .child(status.label()),
                                    )
                                    .child(
                                        div()
                                            .id("close-health-modal")
                                            .focusable()
                                            .role(Role::Button)
                                            .aria_label("Close store health")
                                            .w(px(28.))
                                            .h(px(28.))
                                            .rounded(px(6.))
                                            .cursor_pointer()
                                            .hover(move |s| s.bg(theme.bg_elevated))
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.show_health_modal = false;
                                                window.focus(&this.focus_handle, cx);
                                                cx.notify();
                                            }))
                                            .child(render_ui_icon(
                                                UiIcon::Close,
                                                14.0,
                                                theme.text_secondary,
                                            )),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .p(px(14.))
                            .rounded(px(8.))
                            .bg(theme.bg_sunken)
                            .border_1()
                            .border_color(theme.border_subtle)
                            .flex()
                            .flex_col()
                            .gap(px(8.))
                            .child(
                                div()
                                    .flex()
                                    .items_end()
                                    .justify_between()
                                    .child(
                                        div()
                                            .flex()
                                            .items_baseline()
                                            .gap(px(6.))
                                            .child(
                                                div()
                                                    .text_size(px(26.))
                                                    .line_height(px(30.))
                                                    .font_weight(FontWeight::SEMIBOLD)
                                                    .text_color(theme.text_primary)
                                                    .font_features(tabular_nums())
                                                    .child(format!("{score}")),
                                            )
                                            .child(
                                                div()
                                                    .text_size(px(13.))
                                                    .text_color(theme.text_muted)
                                                    .font_features(tabular_nums())
                                                    .child("/ 100"),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .text_color(theme.text_muted)
                                            .child("Health score"),
                                    ),
                            )
                            .child(
                                div()
                                    .w_full()
                                    .h(px(6.))
                                    .rounded(px(3.))
                                    .bg(theme.bg_elevated)
                                    .overflow_hidden()
                                    .child(
                                        div()
                                            .h_full()
                                            .w(gpui::relative(
                                                (score as f32 / 100.0).clamp(0.0, 1.0),
                                            ))
                                            .rounded(px(3.))
                                            .bg(score_color),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .children(filter_pills),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(6.))
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.text_muted)
                                    .child("What to fix"),
                            )
                            .when(fix_rows.is_empty(), |col| {
                                col.child(
                                    div()
                                        .p(px(10.))
                                        .rounded(px(8.))
                                        .bg(theme.bg_app)
                                        .border_1()
                                        .border_color(theme.border_subtle)
                                        .text_size(px(13.))
                                        .text_color(theme.text_secondary)
                                        .child("No actionable issues in this view."),
                                )
                            })
                            .children(fix_rows.into_iter().map(|row| {
                                let kind = row.kind;
                                let row_aria: SharedString =
                                    format!("Filter {}: {}", row.title, row.subtitle).into();
                                div()
                                    .id(row.id)
                                    .focusable()
                                    .cursor_pointer()
                                    .role(Role::Button)
                                    .aria_label(row_aria)
                                    .min_h(px(56.))
                                    .px(px(14.))
                                    .py(px(10.))
                                    .rounded(px(8.))
                                    .bg(theme.bg_app)
                                    .border_1()
                                    .border_color(theme.border_subtle)
                                    .hover(move |s| s.bg(theme.bg_elevated))
                                    .focus_visible(move |s| s.border_1().border_color(theme.accent))
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .gap(px(12.))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        let next_filter = match kind {
                                            HealthFixKind::Contradictions => QueryFilter {
                                                has_contradiction: true,
                                                ..Default::default()
                                            },
                                            HealthFixKind::StaleOrDrifted => QueryFilter {
                                                stale_before_ms: Some(stale_cutoff_ms),
                                                ..Default::default()
                                            },
                                            HealthFixKind::Duplicates => QueryFilter {
                                                duplicates_only: true,
                                                ..Default::default()
                                            },
                                            HealthFixKind::LowTrust => QueryFilter {
                                                max_trust: Some(0.5),
                                                ..Default::default()
                                            },
                                        };
                                        this.apply_health_fix_filter(next_filter, cx);
                                    }))
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .gap(px(8.))
                                            .flex_1()
                                            .min_w(px(0.))
                                            .child(status_dot(row.badge_color))
                                            .child(
                                                div()
                                                    .flex()
                                                    .flex_col()
                                                    .gap(px(2.))
                                                    .min_w(px(0.))
                                                    .child(
                                                        div()
                                                            .text_size(px(13.))
                                                            .font_weight(FontWeight::MEDIUM)
                                                            .text_color(theme.text_primary)
                                                            .child(SharedString::from(row.title)),
                                                    )
                                                    .child(
                                                        div()
                                                            .text_size(px(12.))
                                                            .text_color(theme.text_muted)
                                                            .child(SharedString::from(
                                                                row.subtitle,
                                                            )),
                                                    ),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .h(px(26.))
                                            .px(px(10.))
                                            .rounded(px(6.))
                                            .bg(theme.bg_panel)
                                            .border_1()
                                            .border_color(theme.border_subtle)
                                            .flex()
                                            .items_center()
                                            .gap(px(5.))
                                            .text_size(px(12.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text_primary)
                                            .flex_shrink_0()
                                            .child("Filter")
                                            .child(render_ui_icon(
                                                UiIcon::ArrowRight,
                                                12.0,
                                                theme.text_secondary,
                                            )),
                                    )
                            })),
                    )
                    .child(
                        div()
                            .p(px(12.))
                            .rounded(px(8.))
                            .bg(theme.bg_app)
                            .border_1()
                            .border_color(theme.border_subtle)
                            .flex()
                            .flex_col()
                            .gap(px(6.))
                            .children(summary_rows.into_iter().map(|(k, v)| {
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .gap(px(12.))
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .text_color(theme.text_muted)
                                            .child(SharedString::from(k)),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text_primary)
                                            .font_features(tabular_nums())
                                            .child(SharedString::from(v)),
                                    )
                            })),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_end()
                            .gap(px(8.))
                            .when(show_contradiction_jump, |row| {
                                row.child(
                                    div()
                                        .id("health-view-contradictions")
                                        .focusable()
                                        .cursor_pointer()
                                        .h(px(32.))
                                        .px(px(12.))
                                        .rounded(px(6.))
                                        .bg(theme.accent)
                                        .hover(move |s| s.opacity(0.9))
                                        .flex()
                                        .items_center()
                                        .text_size(px(13.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(theme.primary_btn_fg)
                                        .child("Review contradictions")
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.apply_health_fix_filter(
                                                QueryFilter {
                                                    has_contradiction: true,
                                                    ..Default::default()
                                                },
                                                cx,
                                            );
                                        })),
                                )
                            })
                            .child(
                                div()
                                    .id("health-modal-close")
                                    .focusable()
                                    .cursor_pointer()
                                    .h(px(32.))
                                    .px(px(12.))
                                    .rounded(px(6.))
                                    .bg(theme.bg_elevated)
                                    .border_1()
                                    .border_color(theme.border_subtle)
                                    .hover(move |s| s.bg(theme.bg_selected))
                                    .flex()
                                    .items_center()
                                    .text_size(px(13.))
                                    .text_color(theme.text_primary)
                                    .child("Close")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.show_health_modal = false;
                                        cx.notify();
                                    })),
                            ),
                    ),
            )
            .into_any_element()
    }

    fn render_overflow_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let theme_label = if theme.is_dark {
            "Light theme"
        } else {
            "Dark theme"
        };

        gpui::deferred(
            div()
                .id("overflow-menu-popover")
                .w(px(210.))
                .rounded(px(14.))
                .bg(theme.glass_floating)
                .border_1()
                .border_color(theme.glass_border)
                .shadow_lg()
                .p(px(6.))
                .flex()
                .flex_col()
                .gap(px(2.))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(
                    div()
                        .id("menu-toggle-theme")
                        .focusable()
                        .cursor_pointer()
                        .role(Role::Button)
                        .aria_label(theme_label)
                        .h(px(32.))
                        .px(px(10.))
                        .rounded(px(6.))
                        .hover(move |s| s.bg(theme.bg_elevated))
                        .flex()
                        .items_center()
                        .justify_between()
                        .text_size(px(13.))
                        .text_color(theme.text_primary)
                        .child(theme_label)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.show_overflow_menu = false;
                            this.toggle_theme(window, cx);
                        })),
                )
                .child(
                    div()
                        .id("menu-commands")
                        .focusable()
                        .cursor_pointer()
                        .role(Role::Button)
                        .aria_label("Commands")
                        .h(px(32.))
                        .px(px(10.))
                        .rounded(px(6.))
                        .hover(move |s| s.bg(theme.bg_elevated))
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .text_size(px(13.))
                                .text_color(theme.text_primary)
                                .child("Commands"),
                        )
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(theme.text_muted)
                                .child("Ctrl+K"),
                        )
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.show_overflow_menu = false;
                            this.open_palette(window, cx);
                        })),
                )
                .child(
                    div()
                        .id("menu-tools")
                        .focusable()
                        .cursor_pointer()
                        .role(Role::Button)
                        .aria_label("Tools")
                        .h(px(32.))
                        .px(px(10.))
                        .rounded(px(6.))
                        .hover(move |s| s.bg(theme.bg_elevated))
                        .flex()
                        .items_center()
                        .text_size(px(13.))
                        .text_color(theme.text_primary)
                        .child("Tools")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.open_harnesses_modal(window, cx);
                        })),
                )
                .child(
                    div()
                        .id("menu-health")
                        .focusable()
                        .cursor_pointer()
                        .role(Role::Button)
                        .aria_label("Store health")
                        .h(px(32.))
                        .px(px(10.))
                        .rounded(px(6.))
                        .hover(move |s| s.bg(theme.bg_elevated))
                        .flex()
                        .items_center()
                        .text_size(px(13.))
                        .text_color(theme.text_primary)
                        .child("Store health")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.open_health_modal(HealthPanelFilter::All, window, cx);
                        })),
                )
                .child(
                    div()
                        .id("menu-settings")
                        .focusable()
                        .cursor_pointer()
                        .role(Role::Button)
                        .aria_label("Settings")
                        .h(px(32.))
                        .px(px(10.))
                        .rounded(px(6.))
                        .hover(move |s| s.bg(theme.bg_elevated))
                        .flex()
                        .items_center()
                        .text_size(px(13.))
                        .text_color(theme.text_primary)
                        .child("Settings")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.open_settings_modal(window, cx);
                        })),
                )
                .child(
                    div()
                        .id("menu-dream-diff")
                        .focusable()
                        .role(Role::Button)
                        .aria_label("Dream diff")
                        .h(px(32.))
                        .px(px(10.))
                        .rounded(px(6.))
                        .cursor_pointer()
                        .hover(move |s| s.bg(theme.bg_hover))
                        .focus_visible(move |s| s.border_1().border_color(theme.accent))
                        .flex()
                        .items_center()
                        .justify_between()
                        .text_size(px(13.))
                        .text_color(theme.text_primary)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.show_overflow_menu = false;
                            this.open_dream_diff_modal(window, cx);
                        }))
                        .child("Dream diff"),
                )
                .child(div().my(px(4.)).h(px(1.)).bg(theme.border_subtle))
                .child(
                    div()
                        .id("menu-shortcuts")
                        .focusable()
                        .cursor_pointer()
                        .role(Role::Button)
                        .aria_label("Keyboard shortcuts")
                        .h(px(32.))
                        .px(px(10.))
                        .rounded(px(6.))
                        .hover(move |s| s.bg(theme.bg_hover))
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .text_size(px(13.))
                                .text_color(theme.text_primary)
                                .child("Keyboard shortcuts"),
                        )
                        .child(keycap("?", &theme))
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.open_shortcuts_modal(window, cx);
                        })),
                )
                .child(
                    div()
                        .id("menu-copy-diagnostics")
                        .focusable()
                        .cursor_pointer()
                        .role(Role::Button)
                        .aria_label("Copy diagnostics")
                        .h(px(32.))
                        .px(px(10.))
                        .rounded(px(6.))
                        .hover(move |s| s.bg(theme.bg_elevated))
                        .flex()
                        .items_center()
                        .text_size(px(13.))
                        .text_color(theme.text_secondary)
                        .child("Copy diagnostics")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.show_overflow_menu = false;
                            this.copy_diagnostics(cx);
                        })),
                ),
        )
        .with_priority(15)
        .into_any_element()
    }

    fn render_dream_diff_modal(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let filter = self.dream_diff_filter;
        let filtered = filter_dream_diff_entries(&self.dream_diff_entries, filter);
        let filter_options: [Option<DreamDiffKind>; 6] = [
            None,
            Some(DreamDiffKind::Promoted),
            Some(DreamDiffKind::Merged),
            Some(DreamDiffKind::Decayed),
            Some(DreamDiffKind::Contradiction),
            Some(DreamDiffKind::Updated),
        ];

        let pills = filter_options.into_iter().enumerate().map(|(ix, kind)| {
            let active = filter == kind;
            let count = filter_dream_diff_entries(&self.dream_diff_entries, kind).len();
            let label = match kind {
                None => format!("All ({count})"),
                Some(k) => format!("{} ({count})", k.label()),
            };
            div()
                .id(("dream-diff-filter", ix))
                .focusable()
                .role(Role::Button)
                .cursor_pointer()
                .h(px(28.))
                .px(px(10.))
                .rounded(px(6.))
                .bg(if active {
                    theme.bg_selected
                } else {
                    theme.bg_elevated
                })
                .border_1()
                .border_color(if active {
                    theme.border_strong
                } else {
                    theme.border_subtle
                })
                .hover(move |s| s.bg(theme.bg_hover))
                .focus_visible(move |s| s.border_1().border_color(theme.accent))
                .flex()
                .items_center()
                .text_size(px(12.))
                .font_weight(if active {
                    FontWeight::MEDIUM
                } else {
                    FontWeight::NORMAL
                })
                .text_color(if active {
                    theme.text_primary
                } else {
                    theme.text_secondary
                })
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.dream_diff_filter = kind;
                    cx.notify();
                }))
                .child(label)
        });

        let feed_content: AnyElement =
            if self.dream_diff_loading && self.dream_diff_entries.is_empty() {
                div()
                    .py(px(28.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(13.))
                    .text_color(theme.text_muted)
                    .child("Loading memory timeline...")
                    .into_any_element()
            } else if filtered.is_empty() {
                div()
                    .py(px(28.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(13.))
                    .text_color(theme.text_muted)
                    .child("No lifecycle or consolidation events recorded for this filter.")
                    .into_any_element()
            } else {
                div()
                    .id("dream-diff-list")
                    .flex_1()
                    .min_h(px(0.))
                    .max_h(px(420.))
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .children(filtered.into_iter().enumerate().map(|(ix, entry)| {
                        let dot = match entry.kind {
                            DreamDiffKind::Promoted | DreamDiffKind::Merged => theme.success,
                            DreamDiffKind::Decayed => theme.warning,
                            DreamDiffKind::Contradiction => theme.danger,
                            DreamDiffKind::Updated => theme.text_muted,
                        };
                        let node_id = entry.node_id.clone();
                        let ts_str = format_timestamp_ms(entry.timestamp);
                        div()
                            .id(("dream-diff-row", ix))
                            .focusable()
                            .role(Role::Button)
                            .aria_label(format!(
                                "{}: {} ({})",
                                entry.kind.label(),
                                entry.summary,
                                entry.short_id
                            ))
                            .w_full()
                            .p(px(10.))
                            .rounded(px(8.))
                            .cursor_pointer()
                            .bg(theme.bg_sunken)
                            .border_1()
                            .border_color(theme.border_subtle)
                            .hover(move |s| s.bg(theme.bg_hover))
                            .focus_visible(move |s| s.border_1().border_color(theme.accent))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.show_dream_diff_modal = false;
                                this.select_memory(node_id.clone(), true, cx);
                            }))
                            .flex()
                            .flex_col()
                            .gap(px(4.))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .gap(px(8.))
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .gap(px(8.))
                                            .child(status_dot(dot))
                                            .child(
                                                div()
                                                    .text_size(px(12.))
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(theme.text_primary)
                                                    .child(entry.kind.label()),
                                            )
                                            .child(
                                                div()
                                                    .px(px(6.))
                                                    .py(px(1.))
                                                    .rounded(px(4.))
                                                    .bg(theme.bg_elevated)
                                                    .font_family("Consolas")
                                                    .text_size(px(11.))
                                                    .text_color(theme.text_secondary)
                                                    .child(format!("[mem:{}]", entry.short_id)),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .text_color(theme.text_muted)
                                            .child(ts_str),
                                    ),
                            )
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .text_color(theme.text_primary)
                                    .truncate()
                                    .child(entry.summary.clone()),
                            )
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(theme.text_muted)
                                    .truncate()
                                    .child(entry.detail.clone()),
                            )
                    }))
                    .into_any_element()
            };

        div()
            .id("dream-diff-modal-backdrop")
            .absolute()
            .inset_0()
            .bg(theme.glass_scrim)
            .flex()
            .items_center()
            .justify_center()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    this.show_dream_diff_modal = false;
                    cx.notify();
                }),
            )
            .child(
                div()
                    .id("dream-diff-dialog")
                    .role(Role::Dialog)
                    .aria_label("Dream Diff timeline")
                    .w(px(640.))
                    .max_w(gpui::relative(0.92))
                    .max_h(gpui::relative(0.86))
                    .p(px(24.))
                    .rounded(px(16.))
                    .bg(theme.glass_panel)
                    .border_1()
                    .border_color(theme.glass_border)
                    .shadow_lg()
                    .flex()
                    .flex_col()
                    .gap(px(14.))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .flex()
                            .items_start()
                            .justify_between()
                            .gap(px(12.))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(4.))
                                    .child(
                                        div()
                                            .text_size(px(19.))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(theme.text_primary)
                                            .child("Dream Diff"),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .text_color(theme.text_muted)
                                            .child("Read-only timeline of promotions, merges, decay, and contradictions."),
                                    ),
                            )
                            .child(
                                div()
                                    .id("close-dream-diff-modal")
                                    .focusable()
                                    .role(Role::Button)
                                    .aria_label("Close Dream Diff")
                                    .w(px(28.))
                                    .h(px(28.))
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .hover(move |s| s.bg(theme.bg_hover))
                                    .focus_visible(move |s| s.border_1().border_color(theme.accent))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.show_dream_diff_modal = false;
                                        window.focus(&this.focus_handle, cx);
                                        cx.notify();
                                    }))
                                    .child(render_ui_icon(
                                        UiIcon::Close,
                                        14.0,
                                        theme.text_secondary,
                                    )),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap(px(6.))
                            .children(pills),
                    )
                    .child(feed_content),
            )
            .into_any_element()
    }

    fn render_shortcuts_modal(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        #[cfg(target_os = "macos")]
        let mod_prefix = "Cmd";
        #[cfg(not(target_os = "macos"))]
        let mod_prefix = "Ctrl";

        let nav_rows = [
            ("Next memory", vec!["J", "Down"]),
            ("Previous memory", vec!["K", "Up"]),
            ("First / Last memory", vec!["Home", "End"]),
            ("Open detail pane", vec!["Enter"]),
            ("Close pane / modal / menu", vec!["Esc"]),
        ];
        let global_rows = [
            ("Command palette", vec![mod_prefix, "K"]),
            ("Focus search", vec![mod_prefix, "F", "/"]),
            ("List view", vec![mod_prefix, "1"]),
            ("Graph view", vec![mod_prefix, "2"]),
            ("Keyboard shortcuts", vec!["?"]),
        ];

        let section = |title: &'static str, rows: Vec<(&'static str, Vec<&'static str>)>| {
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    div()
                        .text_size(px(12.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text_muted)
                        .child(title),
                )
                .child(
                    div()
                        .rounded(px(8.))
                        .bg(theme.bg_sunken)
                        .border_1()
                        .border_color(theme.border_subtle)
                        .p(px(10.))
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .children(rows.into_iter().map(|(label, keys)| {
                            div()
                                .flex()
                                .items_center()
                                .justify_between()
                                .gap(px(12.))
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .text_color(theme.text_primary)
                                        .child(label),
                                )
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(4.))
                                        .children(keys.into_iter().map(|k| keycap(k, &theme))),
                                )
                        })),
                )
        };

        div()
            .id("shortcuts-modal-backdrop")
            .absolute()
            .inset_0()
            .bg(rgba(0x00000099))
            .flex()
            .items_center()
            .justify_center()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    this.show_shortcuts_modal = false;
                    cx.notify();
                }),
            )
            .child(
                div()
                    .id("shortcuts-dialog")
                    .role(Role::Dialog)
                    .aria_label("Keyboard shortcuts")
                    .w(px(480.))
                    .max_w(gpui::relative(0.92))
                    .p(px(24.))
                    .rounded(px(10.))
                    .bg(theme.bg_floating)
                    .border_1()
                    .border_color(theme.border_strong)
                    .flex()
                    .flex_col()
                    .gap(px(16.))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(
                                div()
                                    .text_size(px(19.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme.text_primary)
                                    .child("Keyboard shortcuts"),
                            )
                            .child(
                                div()
                                    .id("close-shortcuts-modal")
                                    .focusable()
                                    .cursor_pointer()
                                    .role(Role::Button)
                                    .aria_label("Close keyboard shortcuts")
                                    .w(px(28.))
                                    .h(px(28.))
                                    .rounded(px(6.))
                                    .hover(move |s| s.bg(theme.bg_hover))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.show_shortcuts_modal = false;
                                        window.focus(&this.focus_handle, cx);
                                        cx.notify();
                                    }))
                                    .child(render_ui_icon(
                                        UiIcon::Close,
                                        14.0,
                                        theme.text_secondary,
                                    )),
                            ),
                    )
                    .child(section("Navigation", nav_rows.to_vec()))
                    .child(section("Global & Views", global_rows.to_vec())),
            )
            .into_any_element()
    }

    fn render_context_modal(&self, viewport_h: f32, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let payload_max_h = (viewport_h * 0.86 - 176.0).clamp(150.0, 420.0);
        let subtitle_text = if self.context_loading {
            "Formatting prompt context...".to_string()
        } else if let Some(preview) = &self.context_preview {
            if preview.total_count > preview.shown_count {
                format!(
                    "{} · showing {} of {}",
                    preview.subtitle, preview.shown_count, preview.total_count
                )
            } else {
                preview.subtitle.clone()
            }
        } else {
            "No matching memories in this view.".to_string()
        };

        let meta_text = if let Some(preview) = &self.context_preview {
            format!(
                "≈ {} tokens · {} chars (estimated, chars/4)",
                preview.estimated_tokens, preview.char_count
            )
        } else if self.context_loading {
            "Estimating size...".to_string()
        } else {
            "0 tokens · 0 chars (estimated, chars/4)".to_string()
        };

        let copy_payload = self
            .context_preview
            .as_ref()
            .map(|p| p.payload.clone())
            .filter(|s| !s.is_empty());

        let body_el = if self.context_loading {
            div()
                .w_full()
                .rounded(px(8.))
                .bg(theme.bg_sunken)
                .border_1()
                .border_color(theme.border_subtle)
                .py(px(32.))
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(13.))
                .text_color(theme.text_muted)
                .child("Formatting context...")
                .into_any_element()
        } else if let Some(preview) = &self.context_preview {
            if preview.shown_count == 0 {
                div()
                    .w_full()
                    .rounded(px(8.))
                    .bg(theme.bg_sunken)
                    .border_1()
                    .border_color(theme.border_subtle)
                    .py(px(28.))
                    .px(px(16.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(13.))
                    .text_color(theme.text_muted)
                    .child("No memories match the active filters.")
                    .into_any_element()
            } else {
                div()
                    .relative()
                    .w_full()
                    .max_h(px(payload_max_h))
                    .rounded(px(8.))
                    .bg(theme.bg_sunken)
                    .border_1()
                    .border_color(theme.border_subtle)
                    .overflow_hidden()
                    .child(
                        div()
                            .id("context-preview-scroll")
                            .w_full()
                            .max_h(px(payload_max_h))
                            .overflow_y_scroll()
                            .track_scroll(&self.context_scroll)
                            .p(px(12.))
                            .pr(px(16.))
                            .font_family("Consolas")
                            .text_size(px(12.))
                            .line_height(gpui::relative(1.45))
                            .text_color(theme.text_primary)
                            .child(preview.payload.clone()),
                    )
                    .child(render_vertical_scroll_overlay(
                        self.context_scroll.clone(),
                        theme.bg_sunken,
                        theme,
                    ))
                    .into_any_element()
            }
        } else {
            div().into_any_element()
        };

        div()
            .id("context-modal-backdrop")
            .absolute()
            .inset_0()
            .bg(theme.glass_scrim)
            .px(px(24.))
            .flex()
            .items_center()
            .justify_center()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    this.show_context_modal = false;
                    cx.notify();
                }),
            )
            .on_scroll(|_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .id("context-dialog")
                    .role(Role::Dialog)
                    .aria_label("What the AI sees")
                    .w(px(640.))
                    .max_w(gpui::relative(0.92))
                    .max_h(gpui::relative(0.88))
                    .p(px(20.))
                    .rounded(px(16.))
                    .bg(theme.glass_panel)
                    .border_1()
                    .border_color(theme.glass_border)
                    .shadow_lg()
                    .relative()
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .absolute()
                            .top(px(0.))
                            .left(px(16.))
                            .right(px(16.))
                            .h(px(1.))
                            .bg(theme.glass_highlight),
                    )
                    .child(
                        div()
                            .flex()
                            .items_start()
                            .justify_between()
                            .gap(px(12.))
                            .child(
                                div()
                                    .min_w(px(0.))
                                    .flex()
                                    .flex_col()
                                    .gap(px(3.))
                                    .child(
                                        div()
                                            .text_size(px(19.))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(theme.text_primary)
                                            .child("What the AI sees"),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .text_color(theme.text_muted)
                                            .truncate()
                                            .child(subtitle_text),
                                    ),
                            )
                            .child(
                                div()
                                    .id("close-context-modal")
                                    .focusable()
                                    .role(Role::Button)
                                    .aria_label("Close context preview")
                                    .w(px(28.))
                                    .h(px(28.))
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .hover(move |s| s.bg(theme.bg_hover))
                                    .focus_visible(move |s| s.border_1().border_color(theme.accent))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.show_context_modal = false;
                                        window.focus(&this.focus_handle, cx);
                                        cx.notify();
                                    }))
                                    .child(render_ui_icon(
                                        UiIcon::Close,
                                        14.0,
                                        theme.text_secondary,
                                    )),
                            ),
                    )
                    .child(body_el)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(12.))
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(theme.text_muted)
                                    .child(meta_text),
                            )
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.))
                                    .child(
                                        div()
                                            .id("btn-context-close")
                                            .focusable()
                                            .role(Role::Button)
                                            .aria_label("Close")
                                            .h(px(32.))
                                            .px(px(12.))
                                            .rounded(px(6.))
                                            .cursor_pointer()
                                            .bg(theme.bg_elevated)
                                            .border_1()
                                            .border_color(theme.border_subtle)
                                            .hover(move |s| s.bg(theme.bg_selected))
                                            .focus_visible(move |s| {
                                                s.border_1().border_color(theme.accent)
                                            })
                                            .flex()
                                            .items_center()
                                            .text_size(px(13.))
                                            .text_color(theme.text_primary)
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.show_context_modal = false;
                                                cx.notify();
                                            }))
                                            .child("Close"),
                                    )
                                    .when_some(copy_payload, |el, payload| {
                                        el.child(
                                            div()
                                                .id("btn-context-copy")
                                                .focusable()
                                                .role(Role::Button)
                                                .aria_label("Copy context")
                                                .h(px(32.))
                                                .px(px(14.))
                                                .rounded(px(6.))
                                                .cursor_pointer()
                                                .bg(theme.accent)
                                                .hover(move |s| s.opacity(0.9))
                                                .focus_visible(move |s| {
                                                    s.border_2().border_color(theme.text_primary)
                                                })
                                                .flex()
                                                .items_center()
                                                .text_size(px(13.))
                                                .font_weight(FontWeight::MEDIUM)
                                                .text_color(theme.primary_btn_fg)
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    cx.write_to_clipboard(
                                                        ClipboardItem::new_string(payload.clone()),
                                                    );
                                                    this.set_notice(
                                                        "Copied AI context to clipboard",
                                                        cx,
                                                    );
                                                }))
                                                .child("Copy context"),
                                        )
                                    }),
                            ),
                    ),
            )
            .into_any_element()
    }

    fn render_save_view_modal(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let summary = crate::core::model::describe_filter_target(&self.filter);

        div()
            .id("save-view-modal-backdrop")
            .absolute()
            .inset_0()
            .bg(rgba(0x00000099))
            .px(px(24.))
            .flex()
            .items_center()
            .justify_center()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    this.show_save_view_modal = false;
                    cx.notify();
                }),
            )
            .on_scroll(|_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .id("save-view-dialog")
                    .role(Role::Dialog)
                    .aria_label("Save current view")
                    .w(px(400.))
                    .max_w(gpui::relative(0.92))
                    .p(px(20.))
                    .rounded(px(10.))
                    .bg(theme.bg_panel)
                    .border_1()
                    .border_color(theme.border_strong)
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(12.))
                            .child(
                                div()
                                    .text_size(px(17.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme.text_primary)
                                    .child("Save current view"),
                            )
                            .child(
                                div()
                                    .id("close-save-view-modal")
                                    .focusable()
                                    .role(Role::Button)
                                    .aria_label("Close save view dialog")
                                    .w(px(28.))
                                    .h(px(28.))
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .hover(move |s| s.bg(theme.bg_hover))
                                    .focus_visible(move |s| s.border_1().border_color(theme.accent))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.show_save_view_modal = false;
                                        window.focus(&this.focus_handle, cx);
                                        cx.notify();
                                    }))
                                    .child(render_ui_icon(
                                        UiIcon::Close,
                                        14.0,
                                        theme.text_secondary,
                                    )),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(theme.text_muted)
                            .truncate()
                            .child(summary),
                    )
                    .child(div().w_full().child(self.save_view_input.clone()))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_end()
                            .gap(px(8.))
                            .child(
                                div()
                                    .id("btn-save-view-cancel")
                                    .focusable()
                                    .role(Role::Button)
                                    .aria_label("Cancel")
                                    .h(px(32.))
                                    .px(px(12.))
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .bg(theme.bg_elevated)
                                    .border_1()
                                    .border_color(theme.border_subtle)
                                    .hover(move |s| s.bg(theme.bg_selected))
                                    .flex()
                                    .items_center()
                                    .text_size(px(13.))
                                    .text_color(theme.text_primary)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.show_save_view_modal = false;
                                        cx.notify();
                                    }))
                                    .child("Cancel"),
                            )
                            .child(
                                div()
                                    .id("btn-save-view-confirm")
                                    .focusable()
                                    .role(Role::Button)
                                    .aria_label("Save view")
                                    .h(px(32.))
                                    .px(px(14.))
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .bg(theme.accent)
                                    .hover(move |s| s.opacity(0.9))
                                    .flex()
                                    .items_center()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.primary_btn_fg)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.confirm_save_view(window, cx);
                                    }))
                                    .child("Save"),
                            ),
                    ),
            )
            .into_any_element()
    }
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

impl Render for MemOSApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Read once per frame; the DB watcher backs off when this is false,
        // and the graph stops its drift loop while backgrounded.
        let active = window.is_window_active();
        if active != self.window_active {
            self.window_active = active;
            self.graph_view
                .update(cx, |graph, cx| graph.set_window_active(active, cx));
        }
        let first_render_start = if !self.first_frame_logged {
            Some(Instant::now())
        } else {
            None
        };

        if self.settings.theme == crate::core::settings::ThemeMode::System {
            let sys_theme = ThemePalette::resolve(
                crate::core::settings::ThemeMode::System,
                window.appearance(),
            );
            if sys_theme.is_dark != self.theme.is_dark {
                self.apply_theme_palette(sys_theme, window, cx);
            }
        }

        let theme = self.theme;
        if self.last_synced_titlebar_dark != Some(theme.is_dark) {
            sync_win32_titlebar(window, theme);
            self.last_synced_titlebar_dark = Some(theme.is_dark);
        }
        let viewport = window.viewport_size();
        let viewport_w = viewport.width;
        let viewport_h = viewport.height.as_f32();
        let is_compact = viewport_w < px(1040.);
        let detail_overlay = viewport_w < px(1600.);
        let overlay_w =
            (viewport_w - if is_compact { px(64.) } else { px(212.) }).clamp(px(280.), px(380.));
        if self.compact_layout != is_compact {
            self.compact_layout = is_compact;
            self.sidebar
                .update(cx, |s, cx| s.set_compact(is_compact, cx));
        }
        let empty_store = self.overview.as_ref().is_some_and(|ov| ov.node_count == 0);
        let show_detail = self.detail_open && self.selected_id.is_some() && !empty_store;
        let list_right_inset = if show_detail && detail_overlay {
            overlay_w
        } else {
            px(0.)
        };
        if self.list_view.read(cx).overlay_right_inset() != list_right_inset {
            self.list_view
                .update(cx, |l, cx| l.set_overlay_right_inset(list_right_inset, cx));
        }
        self.brief_view
            .update(cx, |b, cx| b.set_overlay_right_inset(list_right_inset, cx));
        self.review_view
            .update(cx, |r, cx| r.set_overlay_right_inset(list_right_inset, cx));

        let root: AnyElement = if let Some(onboarding) = &self.onboarding {
            div()
                .id("memos-onboarding-host")
                .w_full()
                .h_full()
                .min_w(px(0.))
                .overflow_hidden()
                .bg(theme.bg_app)
                .text_color(theme.text_primary)
                .child(onboarding.clone())
                .into_any_element()
        } else {
            let mode_label = if self.settings.write_mode {
                if self.write_in_flight {
                    "saving…"
                } else {
                    "editing on"
                }
            } else {
                "view only"
            };
            let footer_left: SharedString = if let Some(ov) = &self.overview {
                format!("{} · {mode_label}", format_memory_count(ov.node_count)).into()
            } else {
                format!("no database · {mode_label}").into()
            };

            div()
                .id("memos-desktop-root")
                .track_focus(&self.focus_handle)
                .on_key_down(cx.listener(Self::on_root_key_down))
                .on_mouse_move(cx.listener(|this, _, _, _| {
                    this.record_window_activity();
                }))
                .on_action(cx.listener(Self::on_open_palette))
                .on_action(cx.listener(Self::on_focus_search))
                .on_action(cx.listener(Self::on_switch_list))
                .on_action(cx.listener(Self::on_switch_graph))
                .on_action(cx.listener(Self::on_toggle_theme))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|this, event: &MouseDownEvent, _, cx| {
                        this.record_window_activity();
                        // Dismiss popovers on the same mouse-down instead of a full-window
                        // backdrop. The backdrop occluded the click, so the first click only
                        // closed the popover and the target control never saw it.
                        //
                        // Keep the header band out of this: its trigger buttons own their
                        // open/close state, and dismissing first made a second click on the
                        // trigger look like it stayed open.
                        if event.position.y >= px(96.) && this.has_any_popover_open(cx) {
                            this.dismiss_popovers(PopoverOwner::None, cx);
                        }
                    }),
                )
                .relative()
                .w_full()
                .h_full()
                .min_w(px(0.))
                .overflow_hidden()
                .bg(theme.bg_app)
                .text_color(theme.text_primary)
                .flex()
                .flex_col()
                .child({
                    let scope_chips = scopes_from_filter(&self.filter);
                    div()
                        .min_h(px(56.))
                        .w_full()
                        .min_w(px(0.))
                        .overflow_hidden()
                        .px(px(16.))
                        .pt(px(12.))
                        .pb(px(if scope_chips.is_empty() { 10. } else { 8. }))
                        .bg(theme.bg_panel)
                        .border_b_1()
                        .border_color(theme.border_subtle)
                        .flex()
                        .items_start()
                        .justify_between()
                        .gap(px(12.))
                        .child({
                            let brand_color = if self.is_celebrating_100() {
                                Hsla::from(rgb(0xC97B4A))
                            } else {
                                theme.text_primary
                            };
                            div()
                                .id("top-bar-brand")
                                .h(px(32.))
                                .flex_shrink_0()
                                .flex()
                                .items_center()
                                .text_size(px(15.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(brand_color)
                                .child("MemOS")
                        })
                        .child(
                            div()
                                .flex_1()
                                .max_w(px(520.))
                                .min_w(px(120.))
                                .overflow_hidden()
                                .flex()
                                .flex_col()
                                .gap(px(6.))
                                .child(
                                    div()
                                        .w_full()
                                        .min_w(px(0.))
                                        .flex()
                                        .items_center()
                                        .gap(px(6.))
                                        .child(
                                            div()
                                                .flex_1()
                                                .min_w(px(0.))
                                                .child(self.search_input.clone()),
                                        )
                                        .when(!self.filter.query.trim().is_empty(), |el| {
                                            el.child(
                                                div()
                                                    .id("clear-search-btn")
                                                    .focusable()
                                                    .h(px(28.))
                                                    .px(px(8.))
                                                    .rounded(px(6.))
                                                    .cursor_pointer()
                                                    .bg(theme.bg_elevated)
                                                    .border_1()
                                                    .border_color(theme.border_subtle)
                                                    .hover(move |s| s.bg(theme.bg_selected))
                                                    .flex()
                                                    .items_center()
                                                    .text_size(px(12.))
                                                    .text_color(theme.text_secondary)
                                                    .on_click(cx.listener(|this, _, _, cx| {
                                                        this.search_input
                                                            .update(cx, |i, cx| i.clear(cx));
                                                    }))
                                                    .child("Clear"),
                                            )
                                        })
                                        .when(self.filter.query.trim().is_empty(), |el| {
                                            el.child(div().flex_shrink_0().pr(px(2.)).child(
                                                keycap(
                                                    if cfg!(target_os = "macos") {
                                                        "⌘ K"
                                                    } else {
                                                        "Ctrl K"
                                                    },
                                                    &theme,
                                                ),
                                            ))
                                        }),
                                )
                                .when(!scope_chips.is_empty(), |col| {
                                    col.child(
                                        div()
                                            .id("search-scope-chips")
                                            .w_full()
                                            .flex()
                                            .flex_wrap()
                                            .items_center()
                                            .gap(px(6.))
                                            .children(scope_chips.into_iter().enumerate().map(
                                                |(ix, chip)| {
                                                    let kind = chip.kind;
                                                    div()
                                                        .id(("search-scope-chip", ix))
                                                        .focusable()
                                                        .role(Role::Button)
                                                        .aria_label(format!(
                                                            "Remove {}",
                                                            chip.label
                                                        ))
                                                        .h(px(22.))
                                                        .px(px(8.))
                                                        .rounded(px(11.))
                                                        .cursor_pointer()
                                                        .bg(theme.bg_elevated)
                                                        .border_1()
                                                        .border_color(theme.border_subtle)
                                                        .hover(move |s| {
                                                            s.border_color(theme.accent)
                                                        })
                                                        .flex()
                                                        .items_center()
                                                        .gap(px(5.))
                                                        .text_size(px(11.))
                                                        .text_color(theme.text_secondary)
                                                        .child(SharedString::from(chip.label))
                                                        .child(
                                                            div()
                                                                .text_size(px(11.))
                                                                .text_color(theme.text_muted)
                                                                .child("×"),
                                                        )
                                                        .on_click(cx.listener(
                                                            move |this, _, _, cx| {
                                                                this.remove_search_scope_chip(
                                                                    kind, cx,
                                                                );
                                                            },
                                                        ))
                                                },
                                            )),
                                    )
                                }),
                        )
                        .child(
                            div()
                                .flex_shrink_0()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .when(
                                    is_ingest_button_visible(self.settings.write_mode),
                                    |cluster| {
                                        cluster
                                            .child(
                                                div()
                                                    .id("header-ingest-btn")
                                                    .focusable()
                                                    .role(Role::Button)
                                                    .aria_label("Ingest")
                                                    .h(px(32.))
                                                    .px(px(11.))
                                                    .rounded(px(6.))
                                                    .cursor_pointer()
                                                    .bg(theme.bg_elevated)
                                                    .border_1()
                                                    .border_color(theme.border_subtle)
                                                    .hover(move |s| s.bg(theme.bg_selected))
                                                    .focus_visible(move |s| {
                                                        s.border_1().border_color(theme.accent)
                                                    })
                                                    .flex()
                                                    .items_center()
                                                    .gap(px(5.))
                                                    .text_size(px(13.))
                                                    .text_color(theme.text_primary)
                                                    .on_click(cx.listener(|this, _, window, cx| {
                                                        this.open_ingest_modal(window, cx);
                                                    }))
                                                    .child(render_ui_icon(
                                                        UiIcon::Import,
                                                        13.0,
                                                        theme.text_secondary,
                                                    ))
                                                    .child("Ingest"),
                                            )
                                            .child(
                                                div()
                                                    .id("header-new-memory-btn")
                                                    .focusable()
                                                    .role(Role::Button)
                                                    .aria_label("New memory")
                                                    .h(px(32.))
                                                    .px(px(12.))
                                                    .rounded(px(6.))
                                                    .cursor_pointer()
                                                    .bg(theme.accent)
                                                    .hover(move |s| s.opacity(0.92))
                                                    .focus_visible(move |s| {
                                                        s.border_2()
                                                            .border_color(theme.text_primary)
                                                    })
                                                    .flex()
                                                    .items_center()
                                                    .gap(px(6.))
                                                    .text_size(px(13.))
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(theme.primary_btn_fg)
                                                    .on_click(cx.listener(|this, _, window, cx| {
                                                        this.open_new_memory_composer(window, cx);
                                                    }))
                                                    .child(render_ui_icon(
                                                        UiIcon::Plus,
                                                        14.0,
                                                        theme.primary_btn_fg,
                                                    ))
                                                    .child("New memory"),
                                            )
                                    },
                                )
                                .child(
                                    div()
                                        .id("view-switch-tablist")
                                        .role(Role::TabList)
                                        .p(px(2.))
                                        .rounded(px(6.))
                                        .bg(theme.bg_app)
                                        .border_1()
                                        .border_color(theme.border_subtle)
                                        .flex()
                                        .items_center()
                                        .gap(px(2.))
                                        .child({
                                            let is_list_active = self.active_surface
                                                == WorkspaceSurface::Memories
                                                && self.view_mode == ViewMode::List;
                                            div()
                                                .id("view-switch-list")
                                                .focusable()
                                                .role(Role::Tab)
                                                .aria_label("List view")
                                                .aria_selected(is_list_active)
                                                .h(px(28.))
                                                .px(px(12.))
                                                .rounded(px(5.))
                                                .cursor_pointer()
                                                .flex()
                                                .items_center()
                                                .text_size(px(13.))
                                                .when(is_list_active, |el| {
                                                    el.bg(theme.bg_elevated)
                                                        .text_color(theme.text_primary)
                                                        .font_weight(FontWeight::MEDIUM)
                                                })
                                                .when(!is_list_active, |el| {
                                                    el.text_color(theme.text_muted).hover(|s| {
                                                        s.bg(theme.bg_selected)
                                                            .text_color(theme.text_primary)
                                                    })
                                                })
                                                .focus_visible(move |s| {
                                                    s.border_1().border_color(theme.accent)
                                                })
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.switch_view(ViewMode::List, cx);
                                                }))
                                                .child("List")
                                        })
                                        .child({
                                            let is_graph_active = self.active_surface
                                                == WorkspaceSurface::Memories
                                                && self.view_mode == ViewMode::Graph;
                                            div()
                                                .id("view-switch-graph")
                                                .focusable()
                                                .role(Role::Tab)
                                                .aria_label("Graph view")
                                                .aria_selected(is_graph_active)
                                                .h(px(28.))
                                                .px(px(12.))
                                                .rounded(px(5.))
                                                .cursor_pointer()
                                                .flex()
                                                .items_center()
                                                .text_size(px(13.))
                                                .when(is_graph_active, |el| {
                                                    el.bg(theme.bg_elevated)
                                                        .text_color(theme.text_primary)
                                                        .font_weight(FontWeight::MEDIUM)
                                                })
                                                .when(!is_graph_active, |el| {
                                                    el.text_color(theme.text_muted).hover(|s| {
                                                        s.bg(theme.bg_selected)
                                                            .text_color(theme.text_primary)
                                                    })
                                                })
                                                .focus_visible(move |s| {
                                                    s.border_1().border_color(theme.accent)
                                                })
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.switch_view(ViewMode::Graph, cx);
                                                }))
                                                .child("Graph")
                                        }),
                                )
                                .child(
                                    div()
                                        .relative()
                                        .child({
                                            let overflow_expand = cx.entity().clone();
                                            let overflow_collapse = overflow_expand.clone();
                                            div()
                                                .id("top-overflow-btn")
                                                .focusable()
                                                .role(Role::Button)
                                                .aria_label("More actions")
                                                .aria_expanded(self.show_overflow_menu)
                                                .when(!self.show_overflow_menu, |el| {
                                                    el.tooltip(tooltip_view("More actions", theme))
                                                })
                                                .w(px(32.))
                                                .h(px(32.))
                                                .rounded(px(6.))
                                                .cursor_pointer()
                                                .bg(if self.show_overflow_menu {
                                                    theme.bg_elevated
                                                } else {
                                                    gpui::transparent_black()
                                                })
                                                .border_1()
                                                .border_color(theme.border_subtle)
                                                .hover(move |s| s.bg(theme.bg_elevated))
                                                .focus_visible(move |s| {
                                                    s.border_1().border_color(theme.accent)
                                                })
                                                .flex()
                                                .items_center()
                                                .justify_center()
                                                .text_size(px(14.))
                                                .text_color(theme.text_primary)
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    let next = !this.show_overflow_menu;
                                                    if next {
                                                        this.dismiss_popovers(
                                                            PopoverOwner::Overflow,
                                                            cx,
                                                        );
                                                    }
                                                    this.show_overflow_menu = next;
                                                    cx.notify();
                                                }))
                                                .on_a11y_action(
                                                    AccessibleAction::Expand,
                                                    move |_, _, cx| {
                                                        overflow_expand.update(cx, |this, cx| {
                                                            this.dismiss_popovers(
                                                                PopoverOwner::Overflow,
                                                                cx,
                                                            );
                                                            this.show_overflow_menu = true;
                                                            cx.notify();
                                                        });
                                                    },
                                                )
                                                .on_a11y_action(
                                                    AccessibleAction::Collapse,
                                                    move |_, _, cx| {
                                                        overflow_collapse.update(cx, |this, cx| {
                                                            this.show_overflow_menu = false;
                                                            cx.notify();
                                                        });
                                                    },
                                                )
                                                .child(render_ui_icon(
                                                    UiIcon::Overflow,
                                                    16.0,
                                                    theme.text_primary,
                                                ))
                                        })
                                        .when(self.show_overflow_menu, |wrap| {
                                            wrap.child(
                                                div()
                                                    .absolute()
                                                    .top(px(38.))
                                                    .right(px(0.))
                                                    .child(self.render_overflow_menu(cx)),
                                            )
                                        }),
                                ),
                        )
                })
                .when_some(self.write_bridge_error.clone(), |col, banner| {
                    col.child(self.render_write_error_banner(banner, cx))
                })
                .child(
                    div()
                        .relative()
                        .flex_1()
                        .min_h_0()
                        .min_w(px(0.))
                        .w_full()
                        .overflow_hidden()
                        .flex()
                        .child(self.sidebar.clone())
                        .child(match self.active_surface {
                            WorkspaceSurface::Today => self.brief_view.clone().into_any_element(),
                            WorkspaceSurface::Review => self.review_view.clone().into_any_element(),
                            WorkspaceSurface::Memories => match self.view_mode {
                                ViewMode::List => self.list_view.clone().into_any_element(),
                                ViewMode::Graph => self.graph_view.clone().into_any_element(),
                            },
                        })
                        .when(show_detail && !detail_overlay, |row| {
                            row.child(
                                div()
                                    .w(px(360.))
                                    .h_full()
                                    .flex_shrink_0()
                                    .overflow_hidden()
                                    .child(self.detail_view.clone()),
                            )
                        })
                        .when(show_detail && detail_overlay, |row| {
                            row.child(
                                div()
                                    .id("detail-overlay-pane")
                                    .absolute()
                                    .top(px(0.))
                                    .right(px(0.))
                                    .bottom(px(0.))
                                    .w(overlay_w)
                                    .max_w_full()
                                    .bg(theme.bg_panel)
                                    .border_l_1()
                                    .border_color(theme.border_subtle)
                                    .shadow_lg()
                                    .overflow_hidden()
                                    .occlude()
                                    .on_mouse_down(MouseButton::Left, |_, _, cx| {
                                        cx.stop_propagation();
                                    })
                                    // Do not stop wheel events here: the detail view owns a
                                    // tracked scroll body, and stopping at the overlay prevented
                                    // that body from scrolling while the list also stayed put.
                                    .child(self.detail_view.clone()),
                            )
                        }),
                )
                .child(
                    div()
                        .h(px(28.))
                        .w_full()
                        .min_w(px(0.))
                        .overflow_hidden()
                        .pl(if self.no_fun { px(16.) } else { px(4.) })
                        .pr(px(16.))
                        .bg(theme.bg_panel)
                        .border_t_1()
                        .border_color(theme.border_subtle)
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(12.))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(4.))
                                .min_w(px(0.))
                                .when(!self.no_fun, |row| {
                                    let app_entity = cx.entity().clone();
                                    row.child(
                                        div()
                                            .id("footer-momo-wrap")
                                            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                                                if this.momo_hovered != *hovered {
                                                    this.momo_hovered = *hovered;
                                                    cx.notify();
                                                }
                                            }))
                                            .child(render_momo_button(
                                                "footer-momo",
                                                18.0,
                                                self.health_status,
                                                self.momo_peek_sample.slide_px,
                                                self.momo_peek_sample.eye_open,
                                                theme,
                                                move |_, window, cx| {
                                                    app_entity.update(cx, |this, cx| {
                                                        this.open_health_modal_from_momo(
                                                            window, cx,
                                                        );
                                                    });
                                                },
                                            )),
                                    )
                                })
                                .child(
                                    div()
                                        .id("footer-mode-status")
                                        .role(Role::Status)
                                        .aria_label(footer_left.clone())
                                        .text_size(px(12.))
                                        .text_color(theme.text_muted)
                                        .font_features(tabular_nums())
                                        .truncate()
                                        .child(footer_left),
                                ),
                        )
                        .child(div().flex().items_center().gap(px(12.)).when_some(
                            self.status_notice.clone(),
                            |el, msg| {
                                el.child(
                                    div()
                                        .text_size(px(12.))
                                        .text_color(theme.success)
                                        .child(SharedString::from(msg)),
                                )
                            },
                        )),
                )
                .when(self.momo_hovered && !self.has_overlay_open(cx), |el| {
                    el.child(
                        gpui::deferred(
                            div()
                                .id("momo-footer-tooltip")
                                .absolute()
                                .bottom(px(36.))
                                .left(px(12.))
                                .px(px(10.))
                                .py(px(5.))
                                .rounded(px(6.))
                                .bg(theme.bg_elevated)
                                .border_1()
                                .border_color(theme.border_subtle)
                                .shadow_md()
                                .text_size(px(12.))
                                .text_color(theme.text_primary)
                                .child("Momo — memory mote"),
                        )
                        .with_priority(10),
                    )
                })
                .child(self.palette.clone())
                .when(self.show_harnesses_modal, |el| {
                    el.child(self.render_harnesses_modal(cx))
                })
                .when(self.show_settings_modal, |el| {
                    el.child(self.render_settings_modal(window, cx))
                })
                .when(self.show_health_modal, |el| {
                    el.child(self.render_health_modal(cx))
                })
                .when(self.show_dream_diff_modal, |el| {
                    el.child(self.render_dream_diff_modal(cx))
                })
                .when(self.show_shortcuts_modal, |el| {
                    el.child(self.render_shortcuts_modal(cx))
                })
                .when(self.show_context_modal, |el| {
                    el.child(self.render_context_modal(viewport_h, cx))
                })
                .when(self.show_save_view_modal, |el| {
                    el.child(self.render_save_view_modal(cx))
                })
                .when(self.show_composer_modal, |el| {
                    el.child(self.render_composer_modal(cx))
                })
                .when(self.show_ingest_modal, |el| {
                    el.child(self.render_ingest_modal(cx))
                })
                .when_some(self.forget_confirm_target.clone(), |el, target| {
                    el.child(self.render_forget_confirm_modal(target, cx))
                })
                .when(self.show_consent_modal, |el| {
                    el.child(self.render_consent_modal(cx))
                })
                .into_any_element()
        };

        if let Some(render_start) = first_render_start {
            self.first_frame_logged = true;
            let render_end = Instant::now();
            self.timeline
                .record_span("first_render", render_start, render_end);
            let tl = self.timeline.clone();
            let this_entity = cx.entity().clone();
            let smoke = self.smoke_exit_after_first_frame;
            window.on_next_frame(move |window, cx| {
                let frame_at = Instant::now();
                tl.record_span("first_frame", render_end, frame_at);
                let ms = tl.elapsed_ms(frame_at);
                if smoke {
                    println!("FIRST_FRAME_MS={ms:.2}");
                }
                let _ = tl.write_report_if_configured();
                this_entity.update(cx, |app, cx| {
                    app.first_frame_done = true;
                    sync_win32_titlebar(window, app.theme);
                    app.last_synced_titlebar_dark = Some(app.theme.is_dark);
                    if app.onboarding.is_none()
                        && app.harnesses.is_empty()
                        && !app.smoke_exit_after_first_frame
                    {
                        app.spawn_harness_detection(cx);
                    }
                    app.maybe_finish_startup_exit(cx);
                    cx.notify();
                });
            });
        }

        root
    }
}

/// Dedicated crash report recovery window launched by the panic hook.
fn sanitize_db_error(err: &DbError, path: &std::path::Path) -> String {
    // Keep the message actionable without putting the full home path (and
    // therefore the OS username) into logs and crash reports.
    let label = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("the database file");
    match err {
        DbError::NotFound => format!("Database not found at {label}"),
        DbError::MissingNodesTable => "Database has no `nodes` table (run `memos init`)".into(),
        DbError::OpenFailed { code } => format!("Failed to open read-only SQLite store ({code})"),
        DbError::QueryFailed { code } => format!("Read-only SQLite query failed ({code})"),
    }
}

fn toggle_opt_string(slot: &mut Option<String>, val: String) {
    if slot.as_deref() == Some(val.as_str()) {
        *slot = None;
    } else {
        *slot = Some(val);
    }
}

fn db_file_stamp(db_path: &std::path::Path) -> Option<(u64, Option<SystemTime>)> {
    crate::core::store_cache::file_stamp(db_path)
}

fn format_memory_count(n: usize) -> String {
    if n == 1 {
        "1 memory".to_string()
    } else {
        format!("{n} memories")
    }
}

#[cfg(target_os = "windows")]
fn sync_win32_titlebar(window: &Window, theme: ThemePalette) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    const GA_ROOT: u32 = 2;
    const DWMWA_USE_IMMERSIVE_DARK_MODE_BEFORE_20H1: u32 = 19;
    const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;
    const DWMWA_BORDER_COLOR: u32 = 34;
    const DWMWA_CAPTION_COLOR: u32 = 35;
    const DWMWA_TEXT_COLOR: u32 = 36;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_FRAMECHANGED: u32 = 0x0020;
    const RDW_INVALIDATE: u32 = 0x0001;
    const RDW_UPDATENOW: u32 = 0x0100;
    const RDW_FRAME: u32 = 0x0400;

    const fn win32_colorref(r: u8, g: u8, b: u8) -> u32 {
        (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
    }

    #[link(name = "dwmapi")]
    unsafe extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: isize,
            dwAttribute: u32,
            pvAttribute: *const std::ffi::c_void,
            cbAttribute: u32,
        ) -> i32;
        fn DwmGetWindowAttribute(
            hwnd: isize,
            dwAttribute: u32,
            pvAttribute: *mut std::ffi::c_void,
            cbAttribute: u32,
        ) -> i32;
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetAncestor(hwnd: isize, gaFlags: u32) -> isize;
        fn SetWindowPos(
            hwnd: isize,
            hwndInsertAfter: isize,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            uFlags: u32,
        ) -> i32;
        fn RedrawWindow(
            hwnd: isize,
            lprcUpdate: *const std::ffi::c_void,
            hrgnUpdate: isize,
            flags: u32,
        ) -> i32;
        fn EnumWindows(
            callback: unsafe extern "system" fn(isize, isize) -> i32,
            lparam: isize,
        ) -> i32;
        fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
        fn GetClassNameW(hwnd: isize, buffer: *mut u16, max: i32) -> i32;
        fn IsWindowVisible(hwnd: isize) -> i32;
    }

    struct VisibleWindowSearch {
        pid: u32,
        found: isize,
    }

    // GPUI's `HasWindowHandle` returns its hidden `Zed::PlatformWindow`, which owns
    // the DWM state, but Windows paints the caption of the visible `Zed::Window`.
    // Walk the process' top-level windows and pick the visible one.
    unsafe extern "system" fn find_visible_window(hwnd: isize, lparam: isize) -> i32 {
        let search = unsafe { &mut *(lparam as *mut VisibleWindowSearch) };
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        if pid != search.pid || unsafe { IsWindowVisible(hwnd) } == 0 {
            return 1;
        }
        let mut buffer = [0u16; 64];
        let len = unsafe { GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
        if len > 0 && String::from_utf16_lossy(&buffer[..len as usize]) == "Zed::Window" {
            search.found = hwnd;
            return 0;
        }
        1
    }

    let Ok(wh) = HasWindowHandle::window_handle(window) else {
        return;
    };
    let RawWindowHandle::Win32(handle) = wh.as_raw() else {
        return;
    };
    let raw_hwnd = handle.hwnd.get();
    // SAFETY: `raw_hwnd` comes from GPUI's live Win32 window handle; resolve the
    // visible top-level HWND that actually paints the caption.
    let target_hwnd = unsafe {
        let root = GetAncestor(raw_hwnd, GA_ROOT);
        let candidate = if root != 0 { root } else { raw_hwnd };
        if IsWindowVisible(candidate) != 0 {
            candidate
        } else {
            let mut search = VisibleWindowSearch {
                pid: std::process::id(),
                found: 0,
            };
            EnumWindows(find_visible_window, &mut search as *mut _ as isize);
            if search.found != 0 {
                search.found
            } else {
                candidate
            }
        }
    };

    let dark_mode: i32 = if theme.is_dark { 1 } else { 0 };
    let caption_color: u32 = if theme.is_dark {
        win32_colorref(0x15, 0x18, 0x1D)
    } else {
        win32_colorref(0xFF, 0xFF, 0xFF)
    };
    let text_color: u32 = if theme.is_dark {
        win32_colorref(0xE7, 0xE9, 0xEC)
    } else {
        win32_colorref(0x1B, 0x1D, 0x21)
    };
    let border_color: u32 = if theme.is_dark {
        win32_colorref(0x25, 0x2B, 0x35)
    } else {
        win32_colorref(0xE2, 0xDD, 0xD5)
    };

    // SAFETY: Each attribute points to a 4-byte scalar with matching `cbAttribute == 4`.
    unsafe {
        let _ = DwmSetWindowAttribute(
            target_hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            (&dark_mode as *const i32).cast(),
            std::mem::size_of::<i32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            target_hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE_BEFORE_20H1,
            (&dark_mode as *const i32).cast(),
            std::mem::size_of::<i32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            target_hwnd,
            DWMWA_CAPTION_COLOR,
            (&caption_color as *const u32).cast(),
            std::mem::size_of::<u32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            target_hwnd,
            DWMWA_TEXT_COLOR,
            (&text_color as *const u32).cast(),
            std::mem::size_of::<u32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            target_hwnd,
            DWMWA_BORDER_COLOR,
            (&border_color as *const u32).cast(),
            std::mem::size_of::<u32>() as u32,
        );

        let mut verified_dark: i32 = -1;
        let hr = DwmGetWindowAttribute(
            target_hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            (&mut verified_dark as *mut i32).cast(),
            std::mem::size_of::<i32>() as u32,
        );
        if hr != 0 || verified_dark != dark_mode {
            tracing::debug!(
                target_hwnd,
                expected = dark_mode,
                observed = verified_dark,
                hr,
                "DWM titlebar dark-mode attribute readback mismatch"
            );
            if target_hwnd != raw_hwnd {
                let _ = DwmSetWindowAttribute(
                    raw_hwnd,
                    DWMWA_USE_IMMERSIVE_DARK_MODE,
                    (&dark_mode as *const i32).cast(),
                    std::mem::size_of::<i32>() as u32,
                );
                let _ = DwmSetWindowAttribute(
                    raw_hwnd,
                    DWMWA_CAPTION_COLOR,
                    (&caption_color as *const u32).cast(),
                    std::mem::size_of::<u32>() as u32,
                );
            }
        }

        let _ = SetWindowPos(
            target_hwnd,
            0,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
        let _ = RedrawWindow(
            target_hwnd,
            std::ptr::null(),
            0,
            RDW_FRAME | RDW_INVALIDATE | RDW_UPDATENOW,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn sync_win32_titlebar(_window: &Window, _theme: ThemePalette) {}

fn count_new_memory_ids(
    old_items: &[MemoryListItem],
    new_items: &[MemoryListItem],
    old_total: usize,
    new_total: usize,
) -> usize {
    let old_ids: std::collections::HashSet<&str> =
        old_items.iter().map(|item| item.id.as_str()).collect();
    let new_in_page = new_items
        .iter()
        .filter(|item| !old_ids.contains(item.id.as_str()))
        .count();
    new_in_page.max(new_total.saturating_sub(old_total))
}

fn find_newest_added_id(
    old_items: &[MemoryListItem],
    new_items: &[MemoryListItem],
) -> Option<String> {
    let old_ids: std::collections::HashSet<&str> =
        old_items.iter().map(|item| item.id.as_str()).collect();
    new_items
        .iter()
        .filter(|item| !old_ids.contains(item.id.as_str()))
        .max_by_key(|item| (item.updated_at, item.created_at))
        .or_else(|| new_items.first())
        .map(|item| item.id.clone())
}

fn filter_dream_diff_entries(
    entries: &[DreamDiffEntry],
    filter: Option<DreamDiffKind>,
) -> Vec<&DreamDiffEntry> {
    entries
        .iter()
        .filter(|entry| filter.is_none_or(|kind| entry.kind == kind))
        .collect()
}

fn preferred_window_background() -> WindowBackgroundAppearance {
    #[cfg(target_os = "windows")]
    {
        // GPUI handles the Windows 11 build guard and silently stays opaque on
        // older builds. Mica is sampled once by DWM, so it does not add frames.
        WindowBackgroundAppearance::MicaBackdrop
    }
    #[cfg(not(target_os = "windows"))]
    {
        WindowBackgroundAppearance::Opaque
    }
}

fn window_bounds_to_setting(wb: WindowBounds) -> WindowBoundsSetting {
    let (rect, maximized) = match wb {
        WindowBounds::Windowed(r) => (r, false),
        WindowBounds::Maximized(r) | WindowBounds::Fullscreen(r) => (r, true),
    };
    WindowBoundsSetting {
        x: rect.origin.x.as_f32(),
        y: rect.origin.y.as_f32(),
        width: rect.size.width.as_f32(),
        height: rect.size.height.as_f32(),
        maximized,
    }
}

fn reveal_path_in_file_manager(path: &std::path::Path) {
    #[cfg(target_os = "windows")]
    {
        if std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .is_ok()
        {
            return;
        }
    }
    #[cfg(target_os = "macos")]
    {
        if std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .is_ok()
        {
            return;
        }
    }
    if let Some(parent) = path.parent() {
        let _ = open::that(parent);
    }
}

pub fn is_ingest_button_visible(write_mode: bool) -> bool {
    write_mode
}

pub fn parse_ingest_chunk_chars(raw: &str) -> Result<Option<usize>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let val: usize = trimmed
        .parse()
        .map_err(|_| "Chunk size must be a positive integer.".to_string())?;
    if !(100..=20_000).contains(&val) {
        return Err("Chunk size must be between 100 and 20000 characters.".to_string());
    }
    Ok(Some(val))
}

#[cfg(test)]
mod tests {
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
