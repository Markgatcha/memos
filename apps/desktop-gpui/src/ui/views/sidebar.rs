use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use gpui::{
    Context, EventEmitter, FontWeight, InteractiveElement, IntoElement, ParentElement, PathBuilder,
    Render, Role, SharedString, StatefulInteractiveElement, Styled, Task, Window, canvas, div,
    point, prelude::FluentBuilder, px,
};

use crate::core::easter_eggs::{LOGO_CHARGE_HOLD, LogoPhase, LogoPhysics};
use crate::core::health::{StoreHealthReport, StoreHealthStatus};
use crate::core::model::{DbOverview, QueryFilter};
use crate::core::settings::SavedView;
use crate::ui::views::{
    ThemePalette, UiIcon, render_ui_icon, status_dot, tabular_nums, tooltip_view,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SidebarSurface {
    #[default]
    Memories,
    Today,
    Review,
}

#[derive(Clone, Debug)]
pub enum SidebarEvent {
    SelectSavedView {
        id: String,
        built_in: bool,
        filter: Box<QueryFilter>,
    },
    SelectToday,
    SelectReview,
    ToggleTag(String),
    ClearFilters,
    OpenHarnesses,
    OpenHealth,
    /// Rename, refilter or delete a custom saved view.
    ManageView(String),
}

/// Tags shown before "Show all" so the sidebar stays scannable.
pub const SIDEBAR_TAG_PREVIEW: usize = 8;

/// Pure UI/filter state for the redesigned sidebar, covered by unit tests.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SidebarState {
    pub compact: bool,
    pub rail_expanded: bool,
    pub tags_collapsed: bool,
    pub tags_expanded: bool,
}

impl SidebarState {
    pub fn set_compact(&mut self, compact: bool) {
        self.compact = compact;
        if !compact {
            self.rail_expanded = false;
        }
    }

    pub fn toggle_tags(&mut self) {
        self.tags_collapsed = !self.tags_collapsed;
    }

    pub fn toggle_rail(&mut self) {
        self.rail_expanded = !self.rail_expanded;
    }

    pub fn is_collapsed_rail(&self) -> bool {
        self.compact && !self.rail_expanded
    }

    pub fn show_views_section(overview: Option<&DbOverview>) -> bool {
        // A store being open is what matters: an empty store still needs its
        // five destinations so the first-run user can orient themselves.
        overview.is_some()
    }

    pub fn show_tags_section(overview: Option<&DbOverview>) -> bool {
        overview.is_some_and(|o| !o.tags.is_empty())
    }

    pub fn is_view_active(view: &SavedView, filter: &QueryFilter) -> bool {
        match view.id.as_str() {
            "all" => filter.is_empty(),
            "recent" => {
                filter.created_after_ms.is_some()
                    && filter.query.trim().is_empty()
                    && filter.namespace.is_none()
                    && filter.tag.is_none()
                    && filter.node_type.is_none()
                    && filter.provenance.is_none()
                    && !filter.has_contradiction
                    && filter.min_importance.is_none()
                    && !filter.quarantined_only
                    && filter.stale_before_ms.is_none()
                    && filter.updated_before_ms.is_none()
                    && filter.max_trust.is_none()
                    && !filter.duplicates_only
                    && filter.updated_not_new_after_ms.is_none()
                    && filter.expiring_window_ms.is_none()
                    && !filter.needs_review_only
            }
            "important" => {
                filter.min_importance == Some(0.7)
                    && filter.query.trim().is_empty()
                    && filter.namespace.is_none()
                    && filter.tag.is_none()
                    && filter.node_type.is_none()
                    && filter.provenance.is_none()
                    && !filter.has_contradiction
                    && filter.created_after_ms.is_none()
                    && !filter.quarantined_only
                    && filter.stale_before_ms.is_none()
                    && filter.updated_before_ms.is_none()
                    && filter.max_trust.is_none()
                    && !filter.duplicates_only
                    && filter.updated_not_new_after_ms.is_none()
                    && filter.expiring_window_ms.is_none()
                    && !filter.needs_review_only
            }
            "contradictions" => {
                filter.has_contradiction
                    && filter.query.trim().is_empty()
                    && filter.namespace.is_none()
                    && filter.tag.is_none()
                    && filter.node_type.is_none()
                    && filter.provenance.is_none()
                    && filter.min_importance.is_none()
                    && filter.created_after_ms.is_none()
                    && !filter.quarantined_only
                    && filter.stale_before_ms.is_none()
                    && filter.updated_before_ms.is_none()
                    && filter.max_trust.is_none()
                    && !filter.duplicates_only
                    && filter.updated_not_new_after_ms.is_none()
                    && filter.expiring_window_ms.is_none()
                    && !filter.needs_review_only
            }
            _ => view.filter == *filter,
        }
    }

    pub fn view_count(view_id: &str, overview: Option<&DbOverview>) -> Option<usize> {
        let ov = overview?;
        match view_id {
            "all" => Some(ov.node_count),
            "contradictions" if ov.contradiction_count > 0 => Some(ov.contradiction_count),
            _ => None,
        }
    }
}

pub struct SidebarView {
    overview: Option<DbOverview>,
    filter: QueryFilter,
    saved_views: Vec<SavedView>,
    active_saved_view_id: Option<String>,
    active_surface: SidebarSurface,
    today_count: usize,
    pending_review_count: usize,
    state: SidebarState,
    installed_tools: usize,
    total_tools: usize,
    theme: ThemePalette,
    logo_physics: LogoPhysics,
    momo_status: StoreHealthStatus,
    health_score: Option<u8>,
    health_review_count: usize,
    no_fun: bool,
    _logo_anim_task: Option<Task<()>>,
    _logo_hold_task: Option<Task<()>>,
}

impl EventEmitter<SidebarEvent> for SidebarView {}

impl SidebarView {
    pub fn new(saved_views: Vec<SavedView>, theme: ThemePalette) -> Self {
        Self {
            overview: None,
            filter: QueryFilter::default(),
            saved_views,
            active_saved_view_id: None,
            active_surface: SidebarSurface::Memories,
            today_count: 0,
            pending_review_count: 0,
            state: SidebarState::default(),
            installed_tools: 0,
            total_tools: 0,
            theme,
            logo_physics: LogoPhysics::new(),
            momo_status: StoreHealthStatus::Empty,
            health_score: None,
            health_review_count: 0,
            no_fun: false,
            _logo_anim_task: None,
            _logo_hold_task: None,
        }
    }

    pub fn set_no_fun(&mut self, no_fun: bool, cx: &mut Context<Self>) {
        self.no_fun = no_fun;
        if no_fun {
            self.logo_physics = LogoPhysics::new();
            self._logo_anim_task = None;
            self._logo_hold_task = None;
        }
        cx.notify();
    }

    pub fn set_health_status(&mut self, status: StoreHealthStatus, cx: &mut Context<Self>) {
        if self.momo_status != status {
            self.momo_status = status;
            cx.notify();
        }
    }

    pub fn set_health_report(
        &mut self,
        report: Option<&StoreHealthReport>,
        cx: &mut Context<Self>,
    ) {
        let next_score = report.map(|r| r.score);
        let next_review = report.map_or(0, |r| {
            r.contradiction_count
                + r.quarantined_count
                + r.expired_count
                + r.drifted_source_count
                + r.stale_count
                + r.duplicate_count
                + r.low_trust_count
        });
        if self.health_score != next_score || self.health_review_count != next_review {
            self.health_score = next_score;
            self.health_review_count = next_review;
            cx.notify();
        }
    }

    pub fn logo_phase(&self) -> LogoPhase {
        self.logo_physics.phase
    }

    pub fn trigger_logo_fall_for_test(&mut self, reduce_motion: bool, cx: &mut Context<Self>) {
        if self.no_fun {
            return;
        }
        let now = Instant::now();
        self.logo_physics.start_press(now);
        self.logo_physics.release(now, reduce_motion);
        if self.logo_physics.is_animating() {
            self.ensure_logo_animation(cx);
        }
        cx.notify();
    }

    pub fn trigger_logo_hold_peek_for_test(&mut self, reduce_motion: bool, cx: &mut Context<Self>) {
        if self.no_fun {
            return;
        }
        let t0 = Instant::now() - LOGO_CHARGE_HOLD;
        self.logo_physics.start_press(t0);
        let _ = self.logo_physics.poll_charge(Instant::now());
        self.logo_physics.release(Instant::now(), reduce_motion);
        if self.logo_physics.is_animating() {
            self.ensure_logo_animation(cx);
        }
        cx.notify();
    }

    // Kept for the breakable-mark state machine and its unit tests; the
    // sidebar no longer renders a second app mark.
    #[allow(dead_code)]
    fn on_logo_press(
        &mut self,
        _: &gpui::MouseDownEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.no_fun {
            return;
        }
        let now = Instant::now();
        self.logo_physics.start_press(now);
        self._logo_hold_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(LOGO_CHARGE_HOLD).await;
            let _ = this.update(cx, |view, cx| {
                if view.logo_physics.poll_charge(Instant::now()) {
                    view.ensure_logo_animation(cx);
                    cx.notify();
                }
            });
        }));
        cx.notify();
    }

    #[allow(dead_code)]
    fn on_logo_release(
        &mut self,
        _: &gpui::MouseUpEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.no_fun || self.logo_physics.press_started_at.is_none() {
            return;
        }
        self._logo_hold_task = None;
        let reduce = cx.reduce_motion();
        self.logo_physics.release(Instant::now(), reduce);
        if self.logo_physics.is_animating() {
            self.ensure_logo_animation(cx);
        }
        cx.notify();
    }

    fn ensure_logo_animation(&mut self, cx: &mut Context<Self>) {
        if self._logo_anim_task.is_some() || !self.logo_physics.is_animating() {
            return;
        }
        self._logo_anim_task = Some(cx.spawn(async move |this, cx| {
            let mut last = Instant::now();
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(16))
                    .await;
                let now = Instant::now();
                let dt = now.saturating_duration_since(last).as_secs_f32();
                last = now;
                let mut keep_going = false;
                let updated = this.update(cx, |view, cx| {
                    if let LogoPhase::Pressed | LogoPhase::Charging { .. } = view.logo_physics.phase
                    {
                        let _ = view.logo_physics.poll_charge(now);
                    }
                    keep_going = view.logo_physics.step(dt);
                    if !keep_going {
                        view._logo_anim_task = None;
                    }
                    cx.notify();
                });
                if updated.is_err() || !keep_going {
                    break;
                }
            }
        }));
    }

    pub fn set_theme(&mut self, theme: ThemePalette, cx: &mut Context<Self>) {
        self.theme = theme;
        cx.notify();
    }

    pub fn set_overview(&mut self, overview: Option<DbOverview>, cx: &mut Context<Self>) {
        self.overview = overview;
        cx.notify();
    }

    pub fn set_filter(&mut self, filter: QueryFilter, cx: &mut Context<Self>) {
        self.filter = filter;
        cx.notify();
    }

    pub fn set_saved_views(&mut self, views: Vec<SavedView>, cx: &mut Context<Self>) {
        self.saved_views = views;
        cx.notify();
    }

    pub fn set_active_saved_view_id(&mut self, id: Option<String>, cx: &mut Context<Self>) {
        if self.active_saved_view_id != id {
            self.active_saved_view_id = id;
            cx.notify();
        }
    }

    pub fn set_active_surface(&mut self, surface: SidebarSurface, cx: &mut Context<Self>) {
        if self.active_surface != surface {
            self.active_surface = surface;
            cx.notify();
        }
    }

    pub fn set_special_counts(
        &mut self,
        today_count: usize,
        pending_review_count: usize,
        cx: &mut Context<Self>,
    ) {
        if self.today_count != today_count || self.pending_review_count != pending_review_count {
            self.today_count = today_count;
            self.pending_review_count = pending_review_count;
            cx.notify();
        }
    }

    pub fn set_pending_review_count(&mut self, count: usize, cx: &mut Context<Self>) {
        if self.pending_review_count != count {
            self.pending_review_count = count;
            cx.notify();
        }
    }

    fn is_saved_view_row_active(&self, view: &SavedView) -> bool {
        self.active_surface == SidebarSurface::Memories
            && saved_view_row_is_active(
                view,
                &self.filter,
                self.active_saved_view_id.as_deref(),
                &self.saved_views,
            )
    }

    pub fn set_harness_summary(&mut self, installed: usize, total: usize, cx: &mut Context<Self>) {
        self.installed_tools = installed;
        self.total_tools = total;
        cx.notify();
    }

    pub fn set_compact(&mut self, compact: bool, cx: &mut Context<Self>) {
        if self.state.compact != compact {
            self.state.set_compact(compact);
            cx.notify();
        }
    }

    fn render_nav_row(
        &self,
        row_id: (&'static str, usize),
        label: SharedString,
        count: Option<usize>,
        active: bool,
        on_click: impl Fn(&mut Self, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        self.render_nav_row_with_manage(row_id, label, count, active, None, on_click, cx)
    }

    #[allow(clippy::too_many_arguments)]
    fn render_nav_row_with_manage(
        &self,
        row_id: (&'static str, usize),
        label: SharedString,
        count: Option<usize>,
        active: bool,
        manage_id: Option<String>,
        on_click: impl Fn(&mut Self, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = self.theme;
        let bg = if active {
            theme.bg_selected
        } else {
            gpui::transparent_black()
        };
        let bar_color = if active {
            theme.accent
        } else {
            gpui::transparent_black()
        };

        div()
            .id(row_id)
            .focusable()
            .cursor_pointer()
            .role(Role::Button)
            .aria_label(label.clone())
            .aria_selected(active)
            .h(px(32.))
            .mx(px(8.))
            .px(px(8.))
            .rounded(px(6.))
            .bg(bg)
            .hover(move |s| {
                s.bg(if active {
                    theme.bg_selected
                } else {
                    theme.bg_hover
                })
            })
            .focus_visible(move |s| s.border_1().border_color(theme.accent))
            .flex()
            .items_center()
            .justify_between()
            .gap(px(8.))
            // Switch views on press. The first click after a popover/scope dismiss
            // used to be consumed before the release, so the nav row highlighted
            // but stayed on the old view until a second click.
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(move |this, _, _, cx| on_click(this, cx)),
            )
            .when_some(manage_id.clone(), |row, id| {
                // Right-click opens the manager, like a native context action.
                row.on_mouse_down(
                    gpui::MouseButton::Right,
                    cx.listener(move |_, _, _, cx| cx.emit(SidebarEvent::ManageView(id.clone()))),
                )
            })
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .min_w(px(0.))
                    .flex_1()
                    .child(
                        div()
                            .w(px(3.))
                            .h(px(16.))
                            .rounded(px(1.5))
                            .flex_shrink_0()
                            .bg(bar_color),
                    )
                    .child(
                        div()
                            .text_size(px(13.))
                            .line_height(px(18.))
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
                            .truncate()
                            .child(label),
                    ),
            )
            .when_some(count, |el, n| {
                el.child(
                    div()
                        .text_size(px(12.))
                        .font_features(tabular_nums())
                        .text_color(theme.text_muted)
                        .flex_shrink_0()
                        .child(format!("{n}")),
                )
            })
            .when(active && manage_id.is_some(), |el| {
                let id = manage_id.clone().unwrap_or_default();
                el.child(
                    div()
                        .id((row_id.0, row_id.1 + 10_000))
                        .focusable()
                        .role(Role::Button)
                        .aria_label("Edit saved view")
                        .tooltip(tooltip_view("Rename, update or delete", theme))
                        .flex_shrink_0()
                        .px(px(4.))
                        .rounded(px(4.))
                        .text_size(px(12.))
                        .text_color(theme.text_muted)
                        .hover(move |s| s.text_color(theme.text_primary).bg(theme.bg_hover))
                        .focus_visible(move |s| s.border_1().border_color(theme.accent))
                        .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_click(cx.listener(move |_, _, _, cx| {
                            cx.emit(SidebarEvent::ManageView(id.clone()));
                        }))
                        .child("Edit"),
                )
            })
            .into_any_element()
    }

    fn render_special_rail_btn(
        &self,
        id: &'static str,
        name: &'static str,
        count: Option<usize>,
        active: bool,
        icon_kind: RailIconKind,
        on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
    ) -> gpui::AnyElement {
        let theme = self.theme;
        let tooltip_label: SharedString = match count {
            Some(n) => format!("{name} ({n})").into(),
            None => name.into(),
        };
        let bg = if active {
            theme.bg_selected
        } else {
            gpui::transparent_black()
        };
        let bar_color = if active {
            theme.accent
        } else {
            gpui::transparent_black()
        };
        let icon_color = if active {
            theme.text_primary
        } else {
            theme.text_secondary
        };
        div()
            .id(id)
            .focusable()
            .cursor_pointer()
            .role(Role::Button)
            .aria_label(name)
            .aria_selected(active)
            .tooltip(tooltip_view(tooltip_label, theme))
            .w(px(40.))
            .h(px(36.))
            .rounded(px(6.))
            .bg(bg)
            .hover(move |s| {
                s.bg(if active {
                    theme.bg_selected
                } else {
                    theme.bg_hover
                })
            })
            .focus_visible(move |s| s.border_1().border_color(theme.accent))
            .flex()
            .items_center()
            .gap(px(4.))
            .px(px(5.))
            .on_click(on_click)
            .child(div().w(px(2.)).h(px(16.)).rounded(px(1.)).bg(bar_color))
            .child(
                div()
                    .flex_1()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(render_rail_icon(icon_kind, icon_color)),
            )
            .into_any_element()
    }

    fn render_collapsed_rail(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = self.theme;
        let show_views = SidebarState::show_views_section(self.overview.as_ref());
        let dot_color = if self.installed_tools > 0 {
            theme.success
        } else {
            theme.text_muted
        };
        let tools_tooltip: SharedString = if self.total_tools > 0 {
            format!("Tools ({} installed)", self.installed_tools).into()
        } else {
            "Tools".into()
        };

        let rail = div()
            .w(px(56.))
            .h_full()
            .flex_shrink_0()
            .bg(theme.bg_panel)
            .border_r_1()
            .border_color(theme.border_subtle)
            .py(px(10.))
            .flex()
            .flex_col()
            .items_center()
            .justify_between()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .id("sidebar-rail-expand")
                            .focusable()
                            .cursor_pointer()
                            .role(Role::Button)
                            .aria_label("Expand sidebar")
                            .tooltip(tooltip_view("Expand sidebar", theme))
                            .w(px(40.))
                            .h(px(36.))
                            .rounded(px(6.))
                            .hover(move |s| s.bg(theme.bg_hover))
                            .focus_visible(move |s| s.border_1().border_color(theme.accent))
                            .flex()
                            .items_center()
                            .justify_center()
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.state.toggle_rail();
                                cx.notify();
                            }))
                            .child(render_rail_icon(
                                RailIconKind::ExpandSidebar,
                                theme.text_secondary,
                            )),
                    )
                    .when(show_views, |col| {
                        let today_active = self.active_surface == SidebarSurface::Today;
                        let review_active = self.active_surface == SidebarSurface::Review;
                        col.child(div().w(px(28.)).h(px(1.)).bg(theme.border_subtle))
                            .child(self.render_special_rail_btn(
                                "sidebar-rail-today",
                                "Today",
                                Some(self.today_count),
                                today_active,
                                RailIconKind::Today,
                                cx.listener(|_, _, _, cx| cx.emit(SidebarEvent::SelectToday)),
                            ))
                            .child(self.render_special_rail_btn(
                                "sidebar-rail-review",
                                "Review",
                                Some(self.pending_review_count),
                                review_active,
                                RailIconKind::Review,
                                cx.listener(|_, _, _, cx| cx.emit(SidebarEvent::SelectReview)),
                            ))
                            .children(self.saved_views.iter().enumerate().map(|(ix, view)| {
                                let active = self.is_saved_view_row_active(view);
                                let view_clone = view.clone();
                                let count =
                                    SidebarState::view_count(&view.id, self.overview.as_ref());
                                let tooltip_label: SharedString = match count {
                                    Some(n) => format!("{} ({n})", view.name).into(),
                                    None => view.name.clone().into(),
                                };
                                let icon_kind = RailIconKind::from_view_id(&view.id);
                                let bg = if active {
                                    theme.bg_selected
                                } else {
                                    gpui::transparent_black()
                                };
                                let bar_color = if active {
                                    theme.accent
                                } else {
                                    gpui::transparent_black()
                                };
                                let icon_color = if active {
                                    theme.text_primary
                                } else {
                                    theme.text_secondary
                                };
                                div()
                                    .id(("sidebar-rail-view", ix))
                                    .focusable()
                                    .cursor_pointer()
                                    .role(Role::Button)
                                    .aria_label(view.name.clone())
                                    .aria_selected(active)
                                    .tooltip(tooltip_view(tooltip_label, theme))
                                    .w(px(40.))
                                    .h(px(36.))
                                    .rounded(px(6.))
                                    .bg(bg)
                                    .hover(move |s| {
                                        s.bg(if active {
                                            theme.bg_selected
                                        } else {
                                            theme.bg_hover
                                        })
                                    })
                                    .focus_visible(move |s| s.border_1().border_color(theme.accent))
                                    .flex()
                                    .items_center()
                                    .gap(px(4.))
                                    .px(px(5.))
                                    .on_click(cx.listener(move |_, _, _, cx| {
                                        let filter = view_clone.resolved_filter(now_unix_ms());
                                        cx.emit(SidebarEvent::SelectSavedView {
                                            id: view_clone.id.clone(),
                                            built_in: view_clone.built_in,
                                            filter: Box::new(filter),
                                        });
                                    }))
                                    .child(div().w(px(2.)).h(px(16.)).rounded(px(1.)).bg(bar_color))
                                    .child(
                                        div()
                                            .flex_1()
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .child(render_rail_icon(icon_kind, icon_color)),
                                    )
                            }))
                    }),
            )
            .child(
                div()
                    .id("sidebar-tools-rail-btn")
                    .focusable()
                    .cursor_pointer()
                    .role(Role::Button)
                    .aria_label(tools_tooltip.clone())
                    .tooltip(tooltip_view(tools_tooltip, theme))
                    .relative()
                    .w(px(40.))
                    .h(px(36.))
                    .rounded(px(6.))
                    .hover(move |s| s.bg(theme.bg_hover))
                    .focus_visible(move |s| s.border_1().border_color(theme.accent))
                    .flex()
                    .items_center()
                    .justify_center()
                    .on_click(cx.listener(|_, _, _, cx| {
                        cx.emit(SidebarEvent::OpenHarnesses);
                    }))
                    .child(render_rail_icon(RailIconKind::Tools, theme.text_secondary))
                    .child(
                        div()
                            .absolute()
                            .top(px(7.))
                            .right(px(7.))
                            .child(status_dot(dot_color)),
                    ),
            );

        rail.into_any_element()
    }
}

impl Render for SidebarView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.state.is_collapsed_rail() {
            return self.render_collapsed_rail(cx);
        }

        let theme = self.theme;
        let show_views = SidebarState::show_views_section(self.overview.as_ref());
        let show_tags = SidebarState::show_tags_section(self.overview.as_ref());
        let has_secondary_filter = !self.filter.is_empty();

        let view_rows: Vec<gpui::AnyElement> = if show_views {
            let mut rows = Vec::with_capacity(self.saved_views.len() + 2);
            rows.push(self.render_nav_row(
                ("sidebar-today", 0),
                "Today".into(),
                Some(self.today_count),
                self.active_surface == SidebarSurface::Today,
                |_, cx| {
                    cx.emit(SidebarEvent::SelectToday);
                },
                cx,
            ));
            rows.push(self.render_nav_row(
                ("sidebar-review", 0),
                "Review".into(),
                Some(self.pending_review_count),
                self.active_surface == SidebarSurface::Review,
                |_, cx| {
                    cx.emit(SidebarEvent::SelectReview);
                },
                cx,
            ));
            for (ix, view) in self.saved_views.iter().enumerate() {
                let active = self.is_saved_view_row_active(view);
                let count = SidebarState::view_count(&view.id, self.overview.as_ref());
                let view_clone = view.clone();
                let manage_id = (!view.built_in).then(|| view.id.clone());
                rows.push(self.render_nav_row_with_manage(
                    ("sidebar-view", ix),
                    view.name.clone().into(),
                    count,
                    active,
                    manage_id,
                    move |_, cx| {
                        let filter = view_clone.resolved_filter(now_unix_ms());
                        cx.emit(SidebarEvent::SelectSavedView {
                            id: view_clone.id.clone(),
                            built_in: view_clone.built_in,
                            filter: Box::new(filter),
                        });
                    },
                    cx,
                ));
            }
            rows
        } else {
            Vec::new()
        };

        let tag_rows: Vec<gpui::AnyElement> = if show_tags && !self.state.tags_collapsed {
            self.overview
                .as_ref()
                .map(|ov| {
                    let limit = if self.state.tags_expanded {
                        40
                    } else {
                        SIDEBAR_TAG_PREVIEW
                    };
                    ov.tags
                        .iter()
                        .take(limit)
                        .enumerate()
                        .map(|(ix, facet)| {
                            let tag_name = facet.name.clone();
                            let active = self.filter.tag.as_deref() == Some(tag_name.as_str());
                            let label: SharedString = format!("#{}", facet.name).into();
                            self.render_nav_row(
                                ("sidebar-tag", ix),
                                label,
                                Some(facet.count),
                                active,
                                move |_, cx| {
                                    cx.emit(SidebarEvent::ToggleTag(tag_name.clone()));
                                },
                                cx,
                            )
                        })
                        .collect()
                })
                .unwrap_or_default()
        } else {
            Vec::new()
        };

        let dot_color = if self.installed_tools > 0 {
            theme.success
        } else {
            theme.text_muted
        };

        div()
            .w(px(216.))
            .h_full()
            .flex_shrink_0()
            .bg(theme.bg_panel)
            .border_r_1()
            .border_color(theme.border_subtle)
            .flex()
            .flex_col()
            .justify_between()
            .when(self.state.compact && self.state.rail_expanded, |panel| {
                panel.child(
                    div()
                        .h(px(36.))
                        .px(px(16.))
                        .border_b_1()
                        .border_color(theme.border_subtle)
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .text_size(px(12.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.text_muted)
                                .child("Navigation"),
                        )
                        .child(
                            div()
                                .id("sidebar-rail-collapse")
                                .focusable()
                                .cursor_pointer()
                                .px(px(6.))
                                .py(px(2.))
                                .rounded(px(4.))
                                .hover(move |s| s.bg(theme.bg_elevated))
                                .focus_visible(move |s| s.border_1().border_color(theme.accent))
                                .text_size(px(12.))
                                .text_color(theme.text_secondary)
                                .child("Collapse")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.state.toggle_rail();
                                    cx.notify();
                                })),
                        ),
                )
            })
            .child(
                div()
                    .flex_shrink_0()
                    .pt(px(12.))
                    .flex()
                    .flex_col()
                    .when_some(self.overview.as_ref(), |col, ov| {
                        let count_label = if ov.node_count == 1 {
                            "memory"
                        } else {
                            "memories"
                        };
                        let review_count = self.health_review_count;
                        let status_text = if review_count > 0 {
                            format!("{review_count} to check")
                        } else {
                            "All caught up".to_string()
                        };
                        let status_color = if review_count > 0 {
                            theme.accent
                        } else {
                            theme.text_muted
                        };
                        col.child(
                            div()
                                .id("sidebar-store-card")
                                .focusable()
                                .cursor_pointer()
                                .role(Role::Button)
                                .aria_label("Open health")
                                .mx(px(8.))
                                .mb(px(8.))
                                .px(px(10.))
                                .py(px(8.))
                                .rounded(px(8.))
                                .border_1()
                                .border_color(gpui::transparent_black())
                                .hover(move |s| s.bg(theme.bg_hover))
                                .focus_visible(move |s| s.border_color(theme.accent))
                                .on_click(cx.listener(|_, _, _, cx| {
                                    cx.emit(SidebarEvent::OpenHealth);
                                }))
                                .flex()
                                .flex_col()
                                .gap(px(6.))
                                .child(
                                    div()
                                        .flex()
                                        .items_baseline()
                                        .gap(px(6.))
                                        .child(
                                            div()
                                                .text_size(px(20.))
                                                .line_height(px(24.))
                                                .font_weight(FontWeight::SEMIBOLD)
                                                .font_features(tabular_nums())
                                                .text_color(theme.text_primary)
                                                .child(SharedString::from(
                                                    ov.node_count.to_string(),
                                                )),
                                        )
                                        .child(
                                            div()
                                                .text_size(px(12.))
                                                .text_color(theme.text_muted)
                                                .child(count_label),
                                        ),
                                )
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(6.))
                                        .child(
                                            div()
                                                .text_size(px(12.))
                                                .font_weight(FontWeight::MEDIUM)
                                                .text_color(status_color)
                                                .truncate()
                                                .child(SharedString::from(status_text)),
                                        )
                                        .child(render_ui_icon(
                                            UiIcon::ArrowRight,
                                            11.0,
                                            theme.text_muted,
                                        )),
                                ),
                        )
                    }),
            )
            .child(
                div()
                    .id("sidebar-scroll")
                    .flex_1()
                    .min_h(px(0.))
                    .overflow_y_scroll()
                    .py(px(4.))
                    .pb(px(12.))
                    .flex()
                    .flex_col()
                    .when(show_views, |col| {
                        col.child(
                            div()
                                .px(px(16.))
                                .pb(px(4.))
                                .flex()
                                .items_center()
                                .justify_between()
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(theme.text_muted)
                                        .child("Views"),
                                )
                                .when(has_secondary_filter, |hdr| {
                                    hdr.child(
                                        div()
                                            .id("sidebar-reset-filters")
                                            .focusable()
                                            .cursor_pointer()
                                            .px(px(4.))
                                            .rounded(px(4.))
                                            .hover(move |s| s.bg(theme.bg_elevated))
                                            .focus_visible(move |s| {
                                                s.border_1().border_color(theme.accent)
                                            })
                                            .text_size(px(12.))
                                            .text_color(theme.text_secondary)
                                            .child("Reset")
                                            .on_click(cx.listener(|_, _, _, cx| {
                                                cx.emit(SidebarEvent::ClearFilters);
                                            })),
                                    )
                                }),
                        )
                        .child(div().flex().flex_col().gap(px(2.)).children(view_rows))
                    })
                    .when(show_tags, |col| {
                        col.child(
                            div()
                                .id("sidebar-tags-toggle")
                                .focusable()
                                .cursor_pointer()
                                .mt(px(16.))
                                .px(px(16.))
                                .py(px(4.))
                                .flex()
                                .items_center()
                                .justify_between()
                                .hover(move |s| s.bg(theme.bg_elevated))
                                .focus_visible(move |s| s.border_1().border_color(theme.accent))
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.state.toggle_tags();
                                    cx.notify();
                                }))
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(theme.text_muted)
                                        .child("Tags"),
                                )
                                .child(render_ui_icon(
                                    if self.state.tags_collapsed {
                                        UiIcon::ChevronRight
                                    } else {
                                        UiIcon::ChevronDown
                                    },
                                    12.0,
                                    theme.text_muted,
                                )),
                        )
                        .when(!self.state.tags_collapsed, |tags_col| {
                            let total_tags = self.overview.as_ref().map_or(0, |o| o.tags.len());
                            let expanded = self.state.tags_expanded;
                            tags_col
                                .child(div().flex().flex_col().gap(px(2.)).children(tag_rows))
                                .when(total_tags > SIDEBAR_TAG_PREVIEW, |col| {
                                    col.child(
                                        div()
                                            .id("sidebar-tags-more")
                                            .focusable()
                                            .role(Role::Button)
                                            .cursor_pointer()
                                            .mx(px(8.))
                                            .mt(px(2.))
                                            .h(px(28.))
                                            .px(px(19.))
                                            .rounded(px(6.))
                                            .flex()
                                            .items_center()
                                            .text_size(px(12.))
                                            .text_color(theme.text_muted)
                                            .hover(move |s| {
                                                s.bg(theme.bg_hover).text_color(theme.text_primary)
                                            })
                                            .focus_visible(move |s| {
                                                s.border_1().border_color(theme.accent)
                                            })
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.state.tags_expanded =
                                                    !this.state.tags_expanded;
                                                cx.notify();
                                            }))
                                            .child(if expanded {
                                                "Show fewer".to_string()
                                            } else {
                                                format!("Show all {}", total_tags.min(40))
                                            }),
                                    )
                                })
                        })
                    }),
            )
            .child(
                div()
                    .px(px(8.))
                    .py(px(8.))
                    .border_t_1()
                    .border_color(theme.border_subtle)
                    .child(
                        div()
                            .id("sidebar-tools-btn")
                            .focusable()
                            .cursor_pointer()
                            .role(Role::Button)
                            .aria_label("Tools")
                            .h(px(34.))
                            .px(px(10.))
                            .rounded(px(6.))
                            .hover(move |s| s.bg(theme.bg_hover))
                            .focus_visible(move |s| s.border_1().border_color(theme.accent))
                            .flex()
                            .items_center()
                            .justify_between()
                            .on_click(cx.listener(|_, _, _, cx| {
                                cx.emit(SidebarEvent::OpenHarnesses);
                            }))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.))
                                    .child(status_dot(dot_color))
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text_primary)
                                            .child("Tools"),
                                    ),
                            )
                            .when(self.total_tools > 0, |row| {
                                row.child(
                                    div()
                                        .text_size(px(12.))
                                        .font_features(tabular_nums())
                                        .text_color(theme.text_muted)
                                        .child(format!("{}", self.installed_tools)),
                                )
                            }),
                    ),
            )
            .into_any_element()
    }
}

#[derive(Clone, Copy)]
enum RailIconKind {
    ExpandSidebar,
    AllMemories,
    Today,
    Review,
    Recent,
    Important,
    Contradictions,
    Tools,
    CustomView,
}

impl RailIconKind {
    fn from_view_id(id: &str) -> Self {
        match id {
            "all" => Self::AllMemories,
            "recent" => Self::Recent,
            "important" => Self::Important,
            "contradictions" => Self::Contradictions,
            _ => Self::CustomView,
        }
    }
}

fn render_rail_icon(kind: RailIconKind, color: gpui::Hsla) -> impl IntoElement {
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let ox = f32::from(bounds.origin.x);
            let oy = f32::from(bounds.origin.y);
            let s = (f32::from(bounds.size.width).min(f32::from(bounds.size.height))) / 16.0;
            let pt = |x: f32, y: f32| point(px(ox + x * s), px(oy + y * s));

            let mut pb = PathBuilder::stroke(px((1.4 * s).clamp(1.2, 2.0)));
            match kind {
                RailIconKind::ExpandSidebar => {
                    pb.move_to(pt(2.5, 3.0));
                    pb.line_to(pt(13.5, 3.0));
                    pb.line_to(pt(13.5, 13.0));
                    pb.line_to(pt(2.5, 13.0));
                    pb.close();
                    pb.move_to(pt(6.2, 3.0));
                    pb.line_to(pt(6.2, 13.0));
                    pb.move_to(pt(8.8, 6.2));
                    pb.line_to(pt(10.8, 8.0));
                    pb.line_to(pt(8.8, 9.8));
                }
                RailIconKind::AllMemories => {
                    for (x, y) in [(2.5, 2.5), (9.2, 2.5), (2.5, 9.2), (9.2, 9.2)] {
                        pb.move_to(pt(x, y));
                        pb.line_to(pt(x + 4.3, y));
                        pb.line_to(pt(x + 4.3, y + 4.3));
                        pb.line_to(pt(x, y + 4.3));
                        pb.close();
                    }
                }
                RailIconKind::Today => {
                    pb.move_to(pt(2.5, 4.0));
                    pb.line_to(pt(13.5, 4.0));
                    pb.line_to(pt(13.5, 13.5));
                    pb.line_to(pt(2.5, 13.5));
                    pb.close();
                    pb.move_to(pt(5.5, 2.2));
                    pb.line_to(pt(5.5, 4.8));
                    pb.move_to(pt(10.5, 2.2));
                    pb.line_to(pt(10.5, 4.8));
                    pb.move_to(pt(2.5, 7.2));
                    pb.line_to(pt(13.5, 7.2));
                }
                RailIconKind::Review => {
                    pb.move_to(pt(2.5, 3.0));
                    pb.line_to(pt(13.5, 3.0));
                    pb.line_to(pt(13.5, 13.0));
                    pb.line_to(pt(2.5, 13.0));
                    pb.close();
                    pb.move_to(pt(5.0, 8.2));
                    pb.line_to(pt(7.2, 10.4));
                    pb.line_to(pt(11.2, 5.8));
                }
                RailIconKind::Recent => {
                    let steps = 14usize;
                    let r = 5.4;
                    for i in 0..=steps {
                        let a = (i as f32 / steps as f32) * std::f32::consts::TAU;
                        let p = pt(8.0 + r * a.cos(), 8.0 + r * a.sin());
                        if i == 0 {
                            pb.move_to(p);
                        } else {
                            pb.line_to(p);
                        }
                    }
                    pb.move_to(pt(8.0, 5.0));
                    pb.line_to(pt(8.0, 8.0));
                    pb.line_to(pt(10.5, 9.4));
                }
                RailIconKind::Important => {
                    let pts = [
                        (8.0, 2.0),
                        (9.8, 6.2),
                        (14.0, 8.0),
                        (9.8, 9.8),
                        (8.0, 14.0),
                        (6.2, 9.8),
                        (2.0, 8.0),
                        (6.2, 6.2),
                    ];
                    pb.move_to(pt(pts[0].0, pts[0].1));
                    for &(x, y) in &pts[1..] {
                        pb.line_to(pt(x, y));
                    }
                    pb.close();
                }
                RailIconKind::Contradictions => {
                    pb.move_to(pt(8.0, 2.2));
                    pb.line_to(pt(13.8, 12.8));
                    pb.line_to(pt(2.2, 12.8));
                    pb.close();
                    pb.move_to(pt(8.0, 5.8));
                    pb.line_to(pt(8.0, 9.3));
                    pb.move_to(pt(8.0, 10.9));
                    pb.line_to(pt(8.0, 11.4));
                }
                RailIconKind::Tools => {
                    pb.move_to(pt(2.5, 5.0));
                    pb.line_to(pt(13.5, 5.0));
                    pb.move_to(pt(6.0, 3.2));
                    pb.line_to(pt(6.0, 6.8));
                    pb.move_to(pt(2.5, 11.0));
                    pb.line_to(pt(13.5, 11.0));
                    pb.move_to(pt(10.0, 9.2));
                    pb.line_to(pt(10.0, 12.8));
                }
                RailIconKind::CustomView => {
                    pb.move_to(pt(4.5, 2.5));
                    pb.line_to(pt(11.5, 2.5));
                    pb.line_to(pt(11.5, 13.5));
                    pb.line_to(pt(8.0, 10.6));
                    pb.line_to(pt(4.5, 13.5));
                    pb.close();
                }
            }
            if let Ok(path) = pb.build() {
                window.paint_path(path, color);
            }
        },
    )
    .w(px(16.))
    .h(px(16.))
    .flex_shrink_0()
}

fn saved_view_row_is_active(
    view: &SavedView,
    filter: &QueryFilter,
    active_saved_view_id: Option<&str>,
    saved_views: &[SavedView],
) -> bool {
    if view.built_in {
        let custom_selected = active_saved_view_id.is_some_and(|id| {
            saved_views
                .iter()
                .any(|custom| !custom.built_in && custom.id == id && &custom.filter == filter)
        });
        SidebarState::is_view_active(view, filter) && !custom_selected
    } else {
        active_saved_view_id == Some(view.id.as_str()) && &view.filter == filter
    }
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::model::FacetCount;
    use std::collections::HashSet;
    use std::path::PathBuf;

    fn sample_overview(node_count: usize, tags: Vec<(&str, usize)>) -> DbOverview {
        DbOverview {
            db_path: PathBuf::from("memos.db"),
            node_count,
            edge_count: 0,
            contradiction_count: 2,
            lesson_count: 0,
            trace_count: 0,
            tamper_count: 0,
            embedding_count: 0,
            newest_updated_at: None,
            writer_preflight: crate::core::model::WriterSchemaPreflight {
                compatible: true,
                missing: Vec::new(),
            },
            namespaces: Vec::new(),
            tags: tags
                .into_iter()
                .map(|(name, count)| FacetCount {
                    name: name.to_string(),
                    count,
                })
                .collect(),
            types: Vec::new(),
            provenances: Vec::new(),
            tables: Vec::new(),
            missing_tables: Vec::new(),
            contradiction_node_ids: HashSet::new(),
        }
    }

    #[test]
    fn hides_empty_sidebar_sections() {
        let empty = sample_overview(0, Vec::new());
        // Views stay visible for an open store even when it has no rows yet.
        assert!(SidebarState::show_views_section(Some(&empty)));
        assert!(!SidebarState::show_tags_section(Some(&empty)));
        assert!(!SidebarState::show_views_section(None));

        let no_tags = sample_overview(12, Vec::new());
        assert!(SidebarState::show_views_section(Some(&no_tags)));
        assert!(!SidebarState::show_tags_section(Some(&no_tags)));

        let with_tags = sample_overview(12, vec![("rust", 4)]);
        assert!(SidebarState::show_views_section(Some(&with_tags)));
        assert!(SidebarState::show_tags_section(Some(&with_tags)));
    }

    #[test]
    fn saved_view_active_matching_distinguishes_all_and_recent() {
        let views = SavedView::defaults();
        let all_view = &views[0];
        let recent_view = &views[1];
        let important_view = &views[2];
        let contradictions_view = &views[3];

        let default_filter = QueryFilter::default();
        assert!(SidebarState::is_view_active(all_view, &default_filter));
        assert!(!SidebarState::is_view_active(recent_view, &default_filter));

        let recent_filter = recent_view.resolved_filter(1_700_000_000_000);
        assert!(SidebarState::is_view_active(recent_view, &recent_filter));
        assert!(!SidebarState::is_view_active(all_view, &recent_filter));

        assert!(SidebarState::is_view_active(
            important_view,
            &important_view.filter
        ));
        assert!(SidebarState::is_view_active(
            contradictions_view,
            &contradictions_view.filter
        ));
    }

    #[test]
    fn sidebar_state_handles_compact_rail_and_tag_collapse() {
        let mut state = SidebarState::default();
        assert!(!state.is_collapsed_rail());

        state.set_compact(true);
        assert!(state.is_collapsed_rail());

        state.toggle_rail();
        assert!(!state.is_collapsed_rail());

        state.set_compact(false);
        assert!(!state.rail_expanded);
        assert!(!state.is_collapsed_rail());

        assert!(!state.tags_collapsed);
        state.toggle_tags();
        assert!(state.tags_collapsed);
    }

    #[test]
    fn duplicate_custom_views_highlight_only_selected_id() {
        let mut views = SavedView::defaults();
        let filter = QueryFilter {
            node_type: Some("decision".to_string()),
            ..Default::default()
        };
        let v1 = SavedView {
            id: "custom-1".to_string(),
            name: "decision".to_string(),
            filter: filter.clone(),
            built_in: false,
        };
        let v2 = SavedView {
            id: "custom-2".to_string(),
            name: "decision 2".to_string(),
            filter: filter.clone(),
            built_in: false,
        };
        views.push(v1.clone());
        views.push(v2.clone());

        assert!(!saved_view_row_is_active(
            &v1,
            &filter,
            Some("custom-2"),
            &views
        ));
        assert!(saved_view_row_is_active(
            &v2,
            &filter,
            Some("custom-2"),
            &views
        ));
        assert!(!saved_view_row_is_active(
            &views[0],
            &filter,
            Some("custom-2"),
            &views
        ));
    }
}
