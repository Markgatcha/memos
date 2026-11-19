use std::path::{Path, PathBuf};
use std::time::Duration;

use gpui::{
    AnyElement, Bounds, ClipboardItem, Context, EventEmitter, FocusHandle, Focusable, FontWeight,
    Hsla, InteractiveElement, IntoElement, KeyDownEvent, ParentElement, PathBuilder,
    PathPromptOptions, Pixels, Render, SharedString, StatefulInteractiveElement, Styled, Task,
    Window, canvas, div, point, prelude::FluentBuilder, px, quad, size, transparent_black,
};

use crate::core::db::{self, DbProbeSummary};
use crate::core::settings::{AppSettings, ThemeMode};
use crate::ui::views::{ThemePalette, status_dot};

pub const CLI_INIT_COMMAND: &str = "memos init --yes";
pub const CLI_STORE_COMMAND: &str = "memos store \"First project memory\" --type fact";
#[allow(dead_code)]
pub const MCP_STORE_COMMAND: &str = "memos mcp   # call MCP tool: memos_store";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnboardingStep {
    Database = 1,
    Ready = 2,
}

impl OnboardingStep {
    pub const ALL: [OnboardingStep; 2] = [OnboardingStep::Database, OnboardingStep::Ready];

    pub fn number(self) -> usize {
        self as usize
    }

    pub fn title(self) -> &'static str {
        match self {
            OnboardingStep::Database => "Database",
            OnboardingStep::Ready => "Ready",
        }
    }
}

/// Validation result for the currently probed SQLite database path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DbValidationState {
    Checking(PathBuf),
    Valid(DbProbeSummary),
    NotFound(PathBuf),
    Invalid { path: PathBuf, reason: String },
}

/// Pure testable state machine for the two-step onboarding flow.
#[derive(Clone, Debug)]
pub struct OnboardingState {
    pub step: OnboardingStep,
    pub candidate_db: PathBuf,
    pub accepted_db_path: Option<PathBuf>,
    pub db_status: DbValidationState,
    pub probe_generation: u64,
    pub theme: ThemeMode,
    pub crash_reporting_enabled: bool,
}

impl OnboardingState {
    pub fn new(initial_db_candidate: PathBuf, settings: &AppSettings) -> Self {
        Self {
            step: OnboardingStep::Database,
            candidate_db: initial_db_candidate.clone(),
            accepted_db_path: None,
            db_status: DbValidationState::Checking(initial_db_candidate),
            probe_generation: 1,
            theme: settings.theme,
            crash_reporting_enabled: false,
        }
    }

    pub fn begin_probe(&mut self, path: PathBuf) -> u64 {
        self.probe_generation = self.probe_generation.wrapping_add(1);
        self.candidate_db = path.clone();
        self.db_status = DbValidationState::Checking(path);
        self.accepted_db_path = None;
        self.probe_generation
    }

    pub fn apply_probe_result(
        &mut self,
        generation: u64,
        probed_path: PathBuf,
        result: Result<DbProbeSummary, String>,
    ) -> bool {
        if generation != self.probe_generation {
            return false;
        }
        match result {
            Ok(summary) => {
                self.accepted_db_path = Some(summary.path.clone());
                self.db_status = DbValidationState::Valid(summary);
            }
            Err(reason) => {
                self.accepted_db_path = None;
                let lower = reason.to_ascii_lowercase();
                if lower.contains("does not exist") || lower.contains("not found") {
                    self.db_status = DbValidationState::NotFound(probed_path);
                } else {
                    self.db_status = DbValidationState::Invalid {
                        path: probed_path,
                        reason,
                    };
                }
            }
        }
        true
    }

    pub fn can_advance(&self) -> bool {
        match self.step {
            OnboardingStep::Database => {
                self.accepted_db_path.is_some()
                    && matches!(self.db_status, DbValidationState::Valid(_))
            }
            OnboardingStep::Ready => self.accepted_db_path.is_some(),
        }
    }

    pub fn can_skip(&self) -> bool {
        self.accepted_db_path.is_some() && matches!(self.db_status, DbValidationState::Valid(_))
    }

    pub fn go_next(&mut self) -> bool {
        if !self.can_advance() {
            return false;
        }
        match self.step {
            OnboardingStep::Database => {
                self.step = OnboardingStep::Ready;
                true
            }
            OnboardingStep::Ready => false,
        }
    }

    pub fn go_back(&mut self) -> bool {
        match self.step {
            OnboardingStep::Database => false,
            OnboardingStep::Ready => {
                self.step = OnboardingStep::Database;
                true
            }
        }
    }

    pub fn build_finished_settings(&self, base: &AppSettings) -> AppSettings {
        let mut next = base.clone();
        next.onboarding_completed = true;
        next.theme = self.theme;
        next.crash_reporting_consent = Some(self.crash_reporting_enabled);
        next.preferred_db_path = self.accepted_db_path.clone();
        next
    }

    pub fn build_skipped_settings(&self, base: &AppSettings) -> AppSettings {
        let mut next = base.clone();
        next.onboarding_completed = true;
        next.crash_reporting_consent = Some(next.crash_reporting_consent.unwrap_or(false));
        if let Some(path) = &self.accepted_db_path {
            next.preferred_db_path = Some(path.clone());
        }
        next
    }
}

#[derive(Clone, Debug)]
pub enum OnboardingEvent {
    Complete {
        settings: AppSettings,
        selected_db: PathBuf,
    },
    ThemeChanged(ThemeMode),
}

pub struct OnboardingView {
    pub state: OnboardingState,
    base_settings: AppSettings,
    theme: ThemePalette,
    notice: Option<String>,
    spinner_frame: usize,
    root_focus: FocusHandle,
    primary_focus: FocusHandle,
    back_focus: FocusHandle,
    skip_focus: FocusHandle,
    copy_init_focus: FocusHandle,
    browse_focus: FocusHandle,
    retry_focus: FocusHandle,
    theme_sys_focus: FocusHandle,
    theme_light_focus: FocusHandle,
    theme_dark_focus: FocusHandle,
    privacy_toggle_focus: FocusHandle,
    needs_focus_sync: bool,
    _probe_task: Option<Task<()>>,
    _browse_task: Option<Task<()>>,
    _spinner_task: Option<Task<()>>,
}

impl EventEmitter<OnboardingEvent> for OnboardingView {}

impl OnboardingView {
    pub fn new(
        initial_db_candidate: PathBuf,
        settings: AppSettings,
        theme: ThemePalette,
        cx: &mut Context<Self>,
    ) -> Self {
        let state = OnboardingState::new(initial_db_candidate.clone(), &settings);
        let gen_id = state.probe_generation;
        let root_focus = cx.focus_handle();
        let primary_focus = cx.focus_handle();
        let back_focus = cx.focus_handle();
        let skip_focus = cx.focus_handle();
        let copy_init_focus = cx.focus_handle();
        let browse_focus = cx.focus_handle();
        let retry_focus = cx.focus_handle();
        let theme_sys_focus = cx.focus_handle();
        let theme_light_focus = cx.focus_handle();
        let theme_dark_focus = cx.focus_handle();
        let privacy_toggle_focus = cx.focus_handle();

        let mut view = Self {
            state,
            base_settings: settings,
            theme,
            notice: None,
            spinner_frame: 0,
            root_focus,
            primary_focus,
            back_focus,
            skip_focus,
            copy_init_focus,
            browse_focus,
            retry_focus,
            theme_sys_focus,
            theme_light_focus,
            theme_dark_focus,
            privacy_toggle_focus,
            needs_focus_sync: false,
            _probe_task: None,
            _browse_task: None,
            _spinner_task: None,
        };
        view.spawn_probe(view.state.candidate_db.clone(), gen_id, cx);
        view.spawn_spinner_tick(cx);
        view
    }

    pub fn set_theme(&mut self, theme: ThemePalette, cx: &mut Context<Self>) {
        self.theme = theme;
        cx.notify();
    }

    fn spawn_spinner_tick(&mut self, cx: &mut Context<Self>) {
        self._spinner_task = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(120))
                    .await;
                let keep_going = this
                    .update(cx, |view, cx| {
                        if matches!(view.state.db_status, DbValidationState::Checking { .. }) {
                            view.spinner_frame = (view.spinner_frame + 1) % 4;
                            cx.notify();
                            true
                        } else {
                            false
                        }
                    })
                    .unwrap_or(false);
                if !keep_going {
                    break;
                }
            }
        }));
    }

    fn start_probe(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        let gen_id = self.state.begin_probe(path.clone());
        self.notice = None;
        self.spawn_probe(path, gen_id, cx);
        self.spawn_spinner_tick(cx);
        cx.notify();
    }

    fn spawn_probe(&mut self, path: PathBuf, gen_id: u64, cx: &mut Context<Self>) {
        self._probe_task = Some(cx.spawn(async move |this, cx| {
            let path_for_probe = path.clone();
            let res = cx
                .background_executor()
                .spawn(async move { db::probe_database(&path_for_probe) })
                .await;
            let _ = this.update(cx, |view, cx| {
                if view.state.apply_probe_result(gen_id, path, res) {
                    if view.state.step == OnboardingStep::Database {
                        view.needs_focus_sync = true;
                    }
                    cx.notify();
                }
            });
        }));
    }

    fn open_browse_dialog(&mut self, cx: &mut Context<Self>) {
        let receiver = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Select MemOS SQLite database".into()),
        });
        self._browse_task = Some(cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = receiver.await
                && let Some(selected) = paths.into_iter().next()
            {
                let _ = this.update(cx, |view, cx| {
                    view.start_probe(selected, cx);
                });
            }
        }));
    }

    fn advance_or_finish(&mut self, cx: &mut Context<Self>) {
        match self.state.step {
            OnboardingStep::Database => {
                if self.state.go_next() {
                    self.needs_focus_sync = true;
                    cx.notify();
                }
            }
            OnboardingStep::Ready => {
                self.finish_with_settings(
                    self.state.build_finished_settings(&self.base_settings),
                    cx,
                );
            }
        }
    }

    fn skip_now(&mut self, cx: &mut Context<Self>) {
        if !self.state.can_skip() {
            return;
        }
        let next_settings = self.state.build_skipped_settings(&self.base_settings);
        self.finish_with_settings(next_settings, cx);
    }

    fn finish_with_settings(&mut self, next_settings: AppSettings, cx: &mut Context<Self>) {
        let Some(selected_db) = self.state.accepted_db_path.clone() else {
            return;
        };
        next_settings.save_async();
        cx.emit(OnboardingEvent::Complete {
            settings: next_settings,
            selected_db,
        });
    }

    fn select_theme_mode(&mut self, mode: ThemeMode, cx: &mut Context<Self>) {
        self.state.theme = mode;
        cx.emit(OnboardingEvent::ThemeChanged(mode));
        cx.notify();
    }

    fn has_interactive_focus(&self, window: &Window) -> bool {
        self.primary_focus.is_focused(window)
            || self.back_focus.is_focused(window)
            || self.skip_focus.is_focused(window)
            || self.copy_init_focus.is_focused(window)
            || self.browse_focus.is_focused(window)
            || self.retry_focus.is_focused(window)
            || self.theme_sys_focus.is_focused(window)
            || self.theme_light_focus.is_focused(window)
            || self.theme_dark_focus.is_focused(window)
            || self.privacy_toggle_focus.is_focused(window)
    }

    fn sync_focus_for_current_step(&self, window: &mut Window, cx: &mut Context<Self>) {
        if self.state.can_advance() {
            window.focus(&self.primary_focus, cx);
        } else if matches!(
            self.state.db_status,
            DbValidationState::NotFound(_) | DbValidationState::Invalid { .. }
        ) {
            window.focus(&self.browse_focus, cx);
        } else {
            window.focus(&self.root_focus, cx);
        }
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        if key.eq_ignore_ascii_case("escape") {
            if self.state.go_back() {
                self.needs_focus_sync = true;
                cx.notify();
            }
            cx.stop_propagation();
            return;
        }
        if key.eq_ignore_ascii_case("tab") {
            if event.keystroke.modifiers.shift {
                window.focus_prev(cx);
            } else {
                window.focus_next(cx);
            }
            cx.stop_propagation();
            return;
        }
        if key.eq_ignore_ascii_case("enter")
            && !event.is_held
            && !self.has_interactive_focus(window)
        {
            self.advance_or_finish(cx);
            cx.stop_propagation();
        }
    }

    fn copy_text(&mut self, text: &str, msg: &str, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(text.to_string()));
        self.notice = Some(msg.to_string());
        cx.notify();
    }

    fn render_constellation_motif(&self) -> AnyElement {
        let theme = self.theme;
        div()
            .w_full()
            .h(px(140.))
            .rounded(px(8.))
            .bg(theme.bg_app)
            .border_1()
            .border_color(theme.border_subtle)
            .overflow_hidden()
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds: Bounds<Pixels>, _, window, _| {
                        let w = bounds.size.width.as_f32();
                        let h = bounds.size.height.as_f32();
                        let ox = bounds.origin.x.as_f32();
                        let oy = bounds.origin.y.as_f32();
                        let pt = |nx: f32, ny: f32| point(px(ox + nx * w), px(oy + ny * h));

                        // Asymmetric calm geometric constellation of local memory nodes.
                        let nodes = [
                            (0.16_f32, 0.68_f32, 4.0_f32, false),
                            (0.30, 0.34, 5.0, false),
                            (0.48, 0.56, 6.5, true),
                            (0.64, 0.28, 4.5, false),
                            (0.76, 0.66, 5.5, false),
                            (0.86, 0.42, 3.8, false),
                            (0.36, 0.78, 3.8, false),
                            (0.18, 0.24, 3.2, false),
                        ];
                        let edges = [
                            (0, 1),
                            (1, 2),
                            (2, 3),
                            (2, 4),
                            (3, 5),
                            (4, 5),
                            (0, 6),
                            (6, 2),
                            (7, 1),
                        ];

                        let mut pb = PathBuilder::stroke(px(1.2));
                        for (a, b) in edges {
                            pb.move_to(pt(nodes[a].0, nodes[a].1));
                            pb.line_to(pt(nodes[b].0, nodes[b].1));
                        }
                        if let Ok(path) = pb.build() {
                            window.paint_path(path, theme.border);
                        }

                        for (nx, ny, radius, featured) in nodes {
                            let c = pt(nx, ny);
                            let r = px(radius);
                            let fill_c = if featured {
                                theme.success
                            } else {
                                Hsla {
                                    a: if theme.is_dark { 0.55 } else { 0.75 },
                                    ..theme.text_muted
                                }
                            };
                            window.paint_quad(quad(
                                Bounds::new(point(c.x - r, c.y - r), size(r * 2.0, r * 2.0)),
                                r,
                                fill_c,
                                px(1.5),
                                theme.bg_app,
                                Default::default(),
                            ));
                            if featured {
                                let ring_r = px(radius + 5.0);
                                window.paint_quad(quad(
                                    Bounds::new(
                                        point(c.x - ring_r, c.y - ring_r),
                                        size(ring_r * 2.0, ring_r * 2.0),
                                    ),
                                    ring_r,
                                    transparent_black(),
                                    px(1.0),
                                    theme.border,
                                    Default::default(),
                                ));
                            }
                        }
                    },
                )
                .size_full(),
            )
            .into_any_element()
    }

    fn render_brand_mark(&self) -> AnyElement {
        let theme = self.theme;
        div()
            .relative()
            .w(px(36.))
            .h(px(36.))
            .child(
                div()
                    .absolute()
                    .top(px(16.))
                    .left(px(7.))
                    .w(px(21.))
                    .h(px(1.5))
                    .bg(theme.border),
            )
            .child(
                div()
                    .absolute()
                    .top(px(7.))
                    .left(px(16.))
                    .w(px(1.5))
                    .h(px(21.))
                    .bg(theme.border),
            )
            .child(
                div()
                    .absolute()
                    .top(px(3.))
                    .left(px(13.))
                    .w(px(8.))
                    .h(px(8.))
                    .rounded_full()
                    .bg(theme.text_primary),
            )
            .child(
                div()
                    .absolute()
                    .top(px(13.))
                    .left(px(3.))
                    .w(px(8.))
                    .h(px(8.))
                    .rounded_full()
                    .bg(theme.text_muted),
            )
            .child(
                div()
                    .absolute()
                    .top(px(13.))
                    .left(px(25.))
                    .w(px(8.))
                    .h(px(8.))
                    .rounded_full()
                    .bg(theme.success),
            )
            .child(
                div()
                    .absolute()
                    .top(px(25.))
                    .left(px(13.))
                    .w(px(8.))
                    .h(px(8.))
                    .rounded_full()
                    .bg(theme.text_secondary),
            )
            .into_any_element()
    }

    fn render_database_step(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let spinner = ["|", "/", "-", "\\"][self.spinner_frame % 4];
        let retry_target = self.state.candidate_db.clone();
        let can_advance = self.state.can_advance();

        let status_panel: AnyElement = match &self.state.db_status {
            DbValidationState::Checking(path) => div()
                .p(px(16.))
                .rounded(px(10.))
                .bg(theme.bg_panel)
                .border_1()
                .border_color(theme.border_subtle)
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(
                    div().flex().items_center().gap(px(8.)).child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text_primary)
                            .child(format!("{spinner} Checking database…")),
                    ),
                )
                .child(
                    div()
                        .text_size(px(13.))
                        .line_height(px(18.))
                        .text_color(theme.text_muted)
                        .child(format_path(path)),
                )
                .into_any_element(),

            DbValidationState::Valid(summary) => {
                let count_text = if summary.node_count == 1 {
                    "1 memory".to_string()
                } else {
                    format!("{} memories", summary.node_count)
                };
                div()
                    .p(px(16.))
                    .rounded(px(10.))
                    .bg(theme.bg_panel)
                    .border_1()
                    .border_color(theme.border_subtle)
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
                                    .flex()
                                    .items_center()
                                    .gap(px(8.))
                                    .child(status_dot(theme.success))
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text_primary)
                                            .child("Database found"),
                                    ),
                            )
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(theme.text_muted)
                                    .child(count_text),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(13.))
                            .line_height(px(18.))
                            .text_color(theme.text_muted)
                            .child(format_path(&summary.path)),
                    )
                    .child(
                        div().pt(px(4.)).flex().items_center().gap(px(8.)).child(
                            div()
                                .id("onboarding-browse-secondary")
                                .track_focus(&self.browse_focus)
                                .tab_stop(true)
                                .tab_index(12)
                                .focusable()
                                .cursor_pointer()
                                .h(px(30.))
                                .px(px(12.))
                                .rounded(px(6.))
                                .bg(theme.bg_elevated)
                                .border_1()
                                .border_color(theme.border_subtle)
                                .hover(move |s| s.bg(theme.bg_selected))
                                .focus_visible(move |s| s.border_1().border_color(theme.accent))
                                .flex()
                                .items_center()
                                .text_size(px(13.))
                                .text_color(theme.text_primary)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.open_browse_dialog(cx);
                                }))
                                .child("Browse…"),
                        ),
                    )
                    .into_any_element()
            }

            DbValidationState::NotFound(path) => div()
                .p(px(16.))
                .rounded(px(10.))
                .bg(theme.bg_panel)
                .border_1()
                .border_color(theme.border_subtle)
                .flex()
                .flex_col()
                .gap(px(10.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(status_dot(theme.warning))
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.text_primary)
                                .child("No database found"),
                        ),
                )
                .child(
                    div()
                        .text_size(px(13.))
                        .line_height(px(18.))
                        .text_color(theme.text_muted)
                        .child(format_path(path)),
                )
                .child(
                    div()
                        .p(px(10.))
                        .rounded(px(6.))
                        .bg(theme.bg_app)
                        .border_1()
                        .border_color(theme.border_subtle)
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(8.))
                        .child(
                            div()
                                .text_size(px(13.))
                                .text_color(theme.text_primary)
                                .truncate()
                                .child(CLI_INIT_COMMAND),
                        )
                        .child(
                            div()
                                .id("onboarding-copy-init")
                                .track_focus(&self.copy_init_focus)
                                .tab_stop(true)
                                .tab_index(12)
                                .focusable()
                                .cursor_pointer()
                                .h(px(26.))
                                .px(px(8.))
                                .rounded(px(6.))
                                .bg(theme.bg_elevated)
                                .border_1()
                                .border_color(theme.border_subtle)
                                .hover(move |s| s.bg(theme.bg_selected))
                                .focus_visible(move |s| s.border_1().border_color(theme.accent))
                                .flex()
                                .items_center()
                                .text_size(px(12.))
                                .text_color(theme.text_primary)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.copy_text(CLI_INIT_COMMAND, "Init command copied", cx);
                                }))
                                .child("Copy"),
                        ),
                )
                .into_any_element(),

            DbValidationState::Invalid { path, reason } => div()
                .p(px(16.))
                .rounded(px(10.))
                .bg(theme.bg_panel)
                .border_1()
                .border_color(theme.danger)
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(status_dot(theme.danger))
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.danger)
                                .child("Invalid database"),
                        ),
                )
                .child(
                    div()
                        .text_size(px(13.))
                        .line_height(px(18.))
                        .text_color(theme.text_primary)
                        .child(reason.clone()),
                )
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(theme.text_muted)
                        .child(format_path(path)),
                )
                .into_any_element(),
        };

        let footer_actions: AnyElement = if can_advance {
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(12.))
                .child(
                    div()
                        .id("onboarding-skip-btn")
                        .track_focus(&self.skip_focus)
                        .tab_stop(true)
                        .tab_index(20)
                        .focusable()
                        .cursor_pointer()
                        .h(px(34.))
                        .px(px(10.))
                        .rounded(px(6.))
                        .hover(move |s| s.bg(theme.bg_elevated))
                        .focus_visible(move |s| s.border_1().border_color(theme.accent))
                        .flex()
                        .items_center()
                        .text_size(px(13.))
                        .text_color(theme.text_muted)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.skip_now(cx);
                        }))
                        .child("Skip"),
                )
                .child(
                    div()
                        .id("onboarding-primary-btn")
                        .track_focus(&self.primary_focus)
                        .tab_stop(true)
                        .tab_index(10)
                        .focusable()
                        .cursor_pointer()
                        .h(px(36.))
                        .px(px(18.))
                        .rounded(px(6.))
                        .bg(theme.accent)
                        .focus_visible(move |s| s.border_2().border_color(theme.text_primary))
                        .flex()
                        .items_center()
                        .text_size(px(13.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.primary_btn_fg)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.advance_or_finish(cx);
                        }))
                        .child("Continue"),
                )
                .into_any_element()
        } else {
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(12.))
                .child(
                    div()
                        .id("onboarding-retry-btn")
                        .track_focus(&self.retry_focus)
                        .tab_stop(true)
                        .tab_index(20)
                        .focusable()
                        .cursor_pointer()
                        .h(px(34.))
                        .px(px(12.))
                        .rounded(px(6.))
                        .bg(theme.bg_elevated)
                        .border_1()
                        .border_color(theme.border_subtle)
                        .hover(move |s| s.bg(theme.bg_selected))
                        .focus_visible(move |s| s.border_1().border_color(theme.accent))
                        .flex()
                        .items_center()
                        .text_size(px(13.))
                        .text_color(theme.text_primary)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.start_probe(retry_target.clone(), cx);
                        }))
                        .child("Retry"),
                )
                .child(
                    div()
                        .id("onboarding-browse-primary")
                        .track_focus(&self.browse_focus)
                        .tab_stop(true)
                        .tab_index(10)
                        .focusable()
                        .cursor_pointer()
                        .h(px(36.))
                        .px(px(18.))
                        .rounded(px(6.))
                        .bg(theme.accent)
                        .focus_visible(move |s| s.border_2().border_color(theme.text_primary))
                        .flex()
                        .items_center()
                        .text_size(px(13.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.primary_btn_fg)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.open_browse_dialog(cx);
                        }))
                        .child("Browse…"),
                )
                .into_any_element()
        };

        div()
            .flex()
            .flex_col()
            .gap(px(20.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(
                        div()
                            .text_size(px(19.))
                            .line_height(px(26.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.text_primary)
                            .child("Connect your database"),
                    )
                    .child(
                        div()
                            .text_size(px(15.))
                            .line_height(px(21.))
                            .text_color(theme.text_muted)
                            .child(
                                "Select a MemOS SQLite file to inspect locally in read-only mode.",
                            ),
                    ),
            )
            .child(status_panel)
            .when_some(self.notice.clone(), |col, msg| {
                col.child(
                    div()
                        .text_size(px(12.))
                        .text_color(theme.success)
                        .child(SharedString::from(msg)),
                )
            })
            .child(footer_actions)
            .into_any_element()
    }

    fn render_ready_step(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let crash_on = self.state.crash_reporting_enabled;

        let theme_options = [
            (
                "onboarding-theme-sys",
                ThemeMode::System,
                "System",
                &self.theme_sys_focus,
            ),
            (
                "onboarding-theme-light",
                ThemeMode::Light,
                "Light",
                &self.theme_light_focus,
            ),
            (
                "onboarding-theme-dark",
                ThemeMode::Dark,
                "Dark",
                &self.theme_dark_focus,
            ),
        ];

        div()
            .flex()
            .flex_col()
            .gap(px(20.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(
                        div()
                            .text_size(px(19.))
                            .line_height(px(26.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.text_primary)
                            .child("Choose your preferences"),
                    )
                    .child(
                        div()
                            .text_size(px(15.))
                            .line_height(px(21.))
                            .text_color(theme.text_muted)
                            .child("You can adjust theme and diagnostics anytime from the menu."),
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
                            .child("Appearance"),
                    )
                    .child(
                        div()
                            .p(px(4.))
                            .rounded(px(8.))
                            .bg(theme.bg_panel)
                            .border_1()
                            .border_color(theme.border_subtle)
                            .flex()
                            .items_center()
                            .gap(px(4.))
                            .children(theme_options.into_iter().enumerate().map(
                                |(idx, (id, mode, label, focus))| {
                                    let active = self.state.theme == mode;
                                    div()
                                        .id(id)
                                        .track_focus(focus)
                                        .tab_stop(true)
                                        .tab_index(12 + idx as isize)
                                        .focusable()
                                        .cursor_pointer()
                                        .flex_1()
                                        .h(px(32.))
                                        .rounded(px(6.))
                                        .bg(if active {
                                            theme.bg_elevated
                                        } else {
                                            gpui::transparent_black()
                                        })
                                        .when(active, |el| {
                                            el.border_1().border_color(theme.border)
                                        })
                                        .hover(move |s| s.bg(theme.bg_elevated))
                                        .focus_visible(move |s| {
                                            s.border_1().border_color(theme.accent)
                                        })
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .text_size(px(13.))
                                        .font_weight(if active {
                                            FontWeight::MEDIUM
                                        } else {
                                            FontWeight::NORMAL
                                        })
                                        .text_color(if active {
                                            theme.text_primary
                                        } else {
                                            theme.text_muted
                                        })
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.select_theme_mode(mode, cx);
                                        }))
                                        .child(label)
                                },
                            )),
                    ),
            )
            .child(
                div()
                    .id("onboarding-privacy-toggle")
                    .track_focus(&self.privacy_toggle_focus)
                    .tab_stop(true)
                    .tab_index(15)
                    .focusable()
                    .cursor_pointer()
                    .w_full()
                    .p(px(16.))
                    .rounded(px(10.))
                    .bg(theme.bg_panel)
                    .border_1()
                    .border_color(theme.border_subtle)
                    .hover(move |s| s.bg(theme.bg_elevated))
                    .focus_visible(move |s| s.border_1().border_color(theme.accent))
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(16.))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.state.crash_reporting_enabled = !this.state.crash_reporting_enabled;
                        cx.notify();
                    }))
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .flex()
                            .flex_col()
                            .gap(px(4.))
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
                                    .line_height(px(17.))
                                    .text_color(theme.text_muted)
                                    .child(
                                        "Off by default. Sends panic diagnostics only; memory content is never sent.",
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .w(px(38.))
                            .h(px(22.))
                            .p(px(2.))
                            .flex_shrink_0()
                            .rounded_full()
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
                            .when(!crash_on, |track| track.justify_start())
                            .child(
                                div()
                                    .w(px(16.))
                                    .h(px(16.))
                                    .flex_shrink_0()
                                    .rounded_full()
                                    .bg(theme.text_primary),
                            ),
                    ),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .child(
                        div()
                            .id("onboarding-back-btn")
                            .track_focus(&self.back_focus)
                            .tab_stop(true)
                            .tab_index(20)
                            .focusable()
                            .cursor_pointer()
                            .h(px(34.))
                            .px(px(14.))
                            .rounded(px(6.))
                            .bg(theme.bg_elevated)
                            .border_1()
                            .border_color(theme.border_subtle)
                            .hover(move |s| s.bg(theme.bg_selected))
                            .focus_visible(move |s| s.border_1().border_color(theme.accent))
                            .flex()
                            .items_center()
                            .text_size(px(13.))
                            .text_color(theme.text_primary)
                            .on_click(cx.listener(|this, _, _, cx| {
                                if this.state.go_back() {
                                    this.needs_focus_sync = true;
                                    cx.notify();
                                }
                            }))
                            .child("Back"),
                    )
                    .child(
                        div()
                            .id("onboarding-primary-btn")
                            .track_focus(&self.primary_focus)
                            .tab_stop(true)
                            .tab_index(10)
                            .focusable()
                            .cursor_pointer()
                            .h(px(36.))
                            .px(px(18.))
                            .rounded(px(6.))
                            .bg(theme.accent)
                            .focus_visible(move |s| s.border_2().border_color(theme.text_primary))
                            .flex()
                            .items_center()
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.primary_btn_fg)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.advance_or_finish(cx);
                            }))
                            .child("Finish"),
                    ),
            )
            .into_any_element()
    }
}

impl Focusable for OnboardingView {
    fn focus_handle(&self, _: &gpui::App) -> FocusHandle {
        self.root_focus.clone()
    }
}

impl Render for OnboardingView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.needs_focus_sync {
            self.needs_focus_sync = false;
            self.sync_focus_for_current_step(window, cx);
        }

        let theme = self.theme;
        let current_num = self.state.step.number();
        let step_body = match self.state.step {
            OnboardingStep::Database => self.render_database_step(cx),
            OnboardingStep::Ready => self.render_ready_step(cx),
        };

        div()
            .id("onboarding-root")
            .track_focus(&self.root_focus)
            .size_full()
            .min_w(px(0.))
            .overflow_hidden()
            .bg(theme.bg_app)
            .flex()
            .on_key_down(cx.listener(Self::on_key_down))
            .child(
                div()
                    .w(px(300.))
                    .h_full()
                    .flex_shrink_0()
                    .bg(theme.bg_panel)
                    .border_r_1()
                    .border_color(theme.border_subtle)
                    .px(px(28.))
                    .py(px(36.))
                    .flex()
                    .flex_col()
                    .justify_between()
                    .gap(px(20.))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(20.))
                            .child(self.render_brand_mark())
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(10.))
                                    .child(
                                        div()
                                            .text_size(px(30.))
                                            .line_height(px(35.))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(theme.text_primary)
                                            .child("Your memories, on your machine"),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(14.))
                                            .line_height(px(20.))
                                            .text_color(theme.text_muted)
                                            .child(
                                                "Inspect local MemOS facts, entities, and connections with no cloud dependency.",
                                            ),
                                    ),
                            ),
                    )
                    .child(self.render_constellation_motif()),
            )
            .child(
                div()
                    .id("onboarding-content-pane")
                    .flex_1()
                    .min_w(px(0.))
                    .h_full()
                    .overflow_y_scroll()
                    .px(px(32.))
                    .py(px(28.))
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .w_full()
                            .max_w(px(440.))
                            .flex()
                            .flex_col()
                            .gap(px(24.))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(8.))
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .gap(px(8.))
                                            .children(OnboardingStep::ALL.into_iter().map(|s| {
                                                let active_or_done = s.number() <= current_num;
                                                div()
                                                    .flex_1()
                                                    .h(px(3.))
                                                    .rounded(px(2.))
                                                    .bg(if active_or_done {
                                                        theme.text_primary
                                                    } else {
                                                        theme.border_subtle
                                                    })
                                            })),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .text_color(theme.text_muted)
                                            .child(format!(
                                                "Step {} of 2 · {}",
                                                current_num,
                                                self.state.step.title()
                                            )),
                                    ),
                            )
                            .child(step_body),
                    ),
            )
    }
}

fn format_path(path: &Path) -> String {
    let raw = path.display().to_string();
    const MAX_LEN: usize = 48;
    if raw.chars().count() <= MAX_LEN {
        return raw;
    }

    let sep = if raw.contains('\\') { '\\' } else { '/' };
    let segments: Vec<&str> = raw.split(['\\', '/']).filter(|s| !s.is_empty()).collect();
    let Some(&file_name) = segments.last() else {
        return raw;
    };
    let parent_name = (segments.len() >= 3).then(|| segments[segments.len() - 2]);

    // Build a concise leading anchor (drive + up to first 2 folder segments, <= 18 chars).
    let mut left = if raw.starts_with('/') {
        segments
            .first()
            .map(|s| format!("/{s}"))
            .unwrap_or_else(|| "/".to_string())
    } else if segments.len() >= 3 && segments[0].ends_with(':') {
        let candidate = format!("{}{sep}{}{sep}{}", segments[0], segments[1], segments[2]);
        if candidate.chars().count() <= 18 {
            candidate
        } else {
            segments[0].to_string()
        }
    } else {
        segments.first().copied().unwrap_or("").to_string()
    };
    if left.is_empty() {
        left = raw.chars().take(12).collect();
    }

    if let Some(parent) = parent_name {
        let with_parent = format!("{left}{sep}…{sep}{parent}{sep}{file_name}");
        if with_parent.chars().count() <= MAX_LEN {
            return with_parent;
        }
    }
    let compact = format!("{left}{sep}…{sep}{file_name}");
    if compact.chars().count() <= MAX_LEN {
        return compact;
    }
    format!("…{sep}{file_name}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::model::ViewMode;
    use rusqlite::Connection;
    use uuid::Uuid;

    #[test]
    fn onboarding_state_machine_requires_valid_db_before_advancing_and_esc_goes_back() {
        let mut st =
            OnboardingState::new(PathBuf::from("/nonexistent.db"), &AppSettings::default());
        assert_eq!(st.step, OnboardingStep::Database);
        // Checking DB prevents advancing or skipping.
        assert!(!st.can_advance());
        assert!(!st.can_skip());
        assert!(!st.go_next());
        assert!(!st.go_back());

        // Stale generation is ignored cleanly.
        assert!(!st.apply_probe_result(
            999,
            PathBuf::from("/nonexistent.db"),
            Err("not found".into()),
        ));

        // Current generation failure keeps user on Database and disallows advance.
        assert!(st.apply_probe_result(
            st.probe_generation,
            PathBuf::from("/nonexistent.db"),
            Err("Database file does not exist".into()),
        ));
        assert!(!st.can_advance());
        assert!(!st.can_skip());

        // Valid DB enables advancing and Skip.
        let valid_path = PathBuf::from("/tmp/memos.db");
        let gen2 = st.begin_probe(valid_path.clone());
        assert!(st.apply_probe_result(
            gen2,
            valid_path.clone(),
            Ok(DbProbeSummary {
                path: valid_path,
                node_count: 12,
                edge_count: 4,
            }),
        ));
        assert!(st.can_advance());
        assert!(st.can_skip());

        // Database -> Ready -> Esc back -> Database (does not exit).
        assert!(st.go_next());
        assert_eq!(st.step, OnboardingStep::Ready);
        assert!(!st.crash_reporting_enabled);
        assert!(!st.go_next());
        assert!(st.go_back());
        assert_eq!(st.step, OnboardingStep::Database);
        assert!(!st.go_back());
    }

    #[test]
    fn onboarding_skip_and_finish_apply_expected_defaults() {
        let base = AppSettings::default();
        let mut st = OnboardingState::new(PathBuf::from("/tmp/a.db"), &base);
        let gen1 = st.begin_probe(PathBuf::from("/tmp/a.db"));
        st.apply_probe_result(
            gen1,
            PathBuf::from("/tmp/a.db"),
            Ok(DbProbeSummary {
                path: PathBuf::from("/tmp/a.db"),
                node_count: 0,
                edge_count: 0,
            }),
        );
        st.theme = ThemeMode::Dark;
        st.crash_reporting_enabled = true;

        let skipped = st.build_skipped_settings(&base);
        assert!(skipped.onboarding_completed);
        assert_eq!(skipped.theme, ThemeMode::System);
        assert_eq!(skipped.default_view, ViewMode::List);
        assert_eq!(skipped.crash_reporting_consent, Some(false));

        let finished = st.build_finished_settings(&base);
        assert!(finished.onboarding_completed);
        assert_eq!(finished.theme, ThemeMode::Dark);
        assert_eq!(finished.default_view, ViewMode::List);
        assert_eq!(finished.crash_reporting_consent, Some(true));
        assert_eq!(finished.preferred_db_path, Some(PathBuf::from("/tmp/a.db")));
    }

    #[test]
    fn db_probe_validates_sqlite_and_nodes_table() {
        let not_sqlite = std::env::temp_dir().join(format!("memos-bad-{}.db", Uuid::new_v4()));
        std::fs::write(&not_sqlite, b"this is not sqlite").unwrap();
        let err1 = db::probe_database(&not_sqlite).unwrap_err();
        assert!(err1.to_lowercase().contains("sqlite"), "got: {err1}");
        let _ = std::fs::remove_file(&not_sqlite);

        let no_nodes = std::env::temp_dir().join(format!("memos-empty-tbl-{}.db", Uuid::new_v4()));
        {
            let conn = Connection::open(&no_nodes).unwrap();
            conn.execute_batch("CREATE TABLE unrelated (x INT);")
                .unwrap();
        }
        let err2 = db::probe_database(&no_nodes).unwrap_err();
        assert!(err2.contains("nodes"), "got: {err2}");
        let _ = std::fs::remove_file(&no_nodes);
    }

    #[test]
    fn format_path_preserves_full_filename_without_mid_word_breaks() {
        let p =
            Path::new(r"C:\Users\marki\AppData\Local\Temp\memos_final_cap_gcb1v1t5\rich_final.db");
        let formatted = format_path(p);
        assert!(
            formatted.ends_with("rich_final.db"),
            "expected intact filename, got {formatted}"
        );
        assert!(
            formatted.chars().count() <= 48,
            "expected compact path <= 48 chars, got {formatted}"
        );

        let short = Path::new(r"C:\Users\marki\.memos\memos.db");
        assert_eq!(format_path(short), r"C:\Users\marki\.memos\memos.db");
    }
}
