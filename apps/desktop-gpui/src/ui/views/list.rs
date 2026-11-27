use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gpui::{
    AccessibleAction, Animation, AnimationExt, AnyElement, Context, EventEmitter, FontWeight,
    InteractiveElement, IntoElement, ParentElement, Render, Role, ScrollHandle, SharedString,
    StatefulInteractiveElement, Styled, UniformListScrollHandle, Window, deferred, div, point,
    prelude::FluentBuilder, px, uniform_list,
};

use crate::core::health::StoreHealthStatus;
use crate::core::model::{
    DbOverview, MemoryListItem, QueryFilter, RowDensity, SortOrder, format_relative_age,
};
use crate::ui::motion::{DURATION_FAST_MS, DURATION_NORMAL_MS, ease_out_cubic, lerp_hsla};
use crate::ui::views::momo::render_momo_button;
use crate::ui::views::{
    ThemePalette, UiIcon, render_ui_icon, render_vertical_scroll_overlay, status_dot, tabular_nums,
};

pub const ROW_HEIGHT_PX: f32 = 64.0;

#[derive(Clone, Debug)]
pub enum ListEvent {
    Select(String),
    Highlight(String),
    Hover(Option<String>),
    PopoverOpened,
    ApplyLiveUpdates { jump_to_newest: bool },
    ToggleNamespace(String),
    ToggleType(String),
    ToggleProvenance(String),
    ToggleContradictions,
    SetSort(SortOrder),
    ClearFilters,
    RetryLoad,
    LoadNextPage,
    CreateStore(PathBuf),
    CopyInitCommand,
    CopyStoreCommand,
    OpenTools,
    OpenHealth,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HeaderPopover {
    None,
    Filter,
    Sort,
}

pub struct MemoryListView {
    items: Vec<MemoryListItem>,
    /// Ids of every loaded item, kept in sync so appending a page never
    /// rebuilds a set over the whole list.
    item_ids: HashSet<String>,
    total_matching: usize,
    total_store_nodes: usize,
    filtered: bool,
    has_more: bool,
    loading_more: bool,
    filter: QueryFilter,
    active_view_name: Option<String>,
    row_density: RowDensity,
    overview: Option<DbOverview>,
    selected_id: Option<String>,
    missing_db_path: Option<String>,
    error_banner: Option<String>,
    is_loading: bool,
    open_popover: HeaderPopover,
    pending_new_count: Option<usize>,
    overlay_right_inset: gpui::Pixels,
    scroll_handle: UniformListScrollHandle,
    filter_scroll_handle: ScrollHandle,
    hovered_row: Option<usize>,
    external_hovered_id: Option<String>,
    suppress_hover_until_move: bool,
    theme: ThemePalette,
    momo_status: StoreHealthStatus,
    no_fun: bool,
    pinned_ids: Arc<HashSet<String>>,
}

/// The single most important state to call out on a row, in priority order.
/// Rows show one marker so a busy store does not turn into a wall of badges.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowMarker {
    Quarantined,
    Conflict,
    LowTrust,
    Pinned,
}

impl RowMarker {
    pub fn label(self) -> &'static str {
        match self {
            RowMarker::Quarantined => "Quarantined",
            RowMarker::Conflict => "Conflict",
            RowMarker::LowTrust => "Low trust",
            RowMarker::Pinned => "Pinned",
        }
    }
}

/// Trust below this reads as "low trust" in rows, matching Store health.
pub const LOW_TRUST_THRESHOLD: f32 = 0.5;

pub fn row_marker(item: &MemoryListItem, pinned: bool) -> Option<RowMarker> {
    if item.quarantined {
        Some(RowMarker::Quarantined)
    } else if item.has_contradiction {
        Some(RowMarker::Conflict)
    } else if item.trust_score < LOW_TRUST_THRESHOLD {
        Some(RowMarker::LowTrust)
    } else if pinned {
        Some(RowMarker::Pinned)
    } else {
        None
    }
}

/// Secondary line for a row: type, namespace (when not `default`) and up to
/// two tags. Kept short so it never fights the title for width.
pub fn row_meta_line(item: &MemoryListItem) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(4);
    let ns = item.namespace.trim();
    if !ns.is_empty() && ns != "default" {
        parts.push(ns.to_string());
    }
    for tag in item.tags.iter().take(2) {
        parts.push(format!("#{tag}"));
    }
    if item.tags.len() > 2 {
        parts.push(format!("+{}", item.tags.len() - 2));
    }
    parts.join(" · ")
}

pub(crate) fn is_row_hovered(
    hovered_row: Option<usize>,
    suppress_hover_until_move: bool,
    row_ix: usize,
    external_hovered_id: Option<&str>,
    item_id: &str,
) -> bool {
    (!suppress_hover_until_move && hovered_row == Some(row_ix))
        || external_hovered_id == Some(item_id)
}

impl EventEmitter<ListEvent> for MemoryListView {}

impl MemoryListView {
    pub fn new(theme: ThemePalette) -> Self {
        Self {
            items: Vec::new(),
            item_ids: HashSet::new(),
            total_matching: 0,
            total_store_nodes: 0,
            filtered: false,
            has_more: false,
            loading_more: false,
            filter: QueryFilter::default(),
            active_view_name: None,
            row_density: RowDensity::Comfortable,
            overview: None,
            selected_id: None,
            missing_db_path: None,
            error_banner: None,
            is_loading: false,
            open_popover: HeaderPopover::None,
            pending_new_count: None,
            overlay_right_inset: px(0.),
            scroll_handle: UniformListScrollHandle::new(),
            filter_scroll_handle: ScrollHandle::new(),
            hovered_row: None,
            external_hovered_id: None,
            suppress_hover_until_move: false,
            theme,
            momo_status: StoreHealthStatus::Empty,
            no_fun: false,
            pinned_ids: Arc::new(HashSet::new()),
        }
    }

    pub fn set_pinned_ids(&mut self, ids: Arc<HashSet<String>>, cx: &mut Context<Self>) {
        self.pinned_ids = ids;
        cx.notify();
    }

    pub fn set_external_hovered_id(&mut self, hovered_id: Option<String>, cx: &mut Context<Self>) {
        if self.external_hovered_id != hovered_id {
            self.external_hovered_id = hovered_id;
            cx.notify();
        }
    }

    fn clear_hover_state(&mut self) -> bool {
        let had_hover = self.hovered_row.take().is_some();
        let was_unsuppressed = !self.suppress_hover_until_move;
        self.suppress_hover_until_move = true;
        had_hover || was_unsuppressed
    }

    /// Clear cached row hover state on window resize so rows never retain stale hover fills
    /// until the pointer moves again.
    pub fn clear_hover_on_resize(&mut self, cx: &mut Context<Self>) {
        let had_local_hover = self.hovered_row.is_some();
        if self.clear_hover_state() {
            if had_local_hover {
                cx.emit(ListEvent::Hover(None));
            }
            cx.notify();
        }
    }

    pub fn set_no_fun(&mut self, no_fun: bool, cx: &mut Context<Self>) {
        self.no_fun = no_fun;
        cx.notify();
    }

    pub fn set_health_status(&mut self, status: StoreHealthStatus, cx: &mut Context<Self>) {
        if self.momo_status != status {
            self.momo_status = status;
            cx.notify();
        }
    }

    pub fn items(&self) -> &[MemoryListItem] {
        &self.items
    }

    pub fn overlay_right_inset(&self) -> gpui::Pixels {
        self.overlay_right_inset
    }

    pub fn set_overlay_right_inset(&mut self, inset: gpui::Pixels, cx: &mut Context<Self>) {
        if self.overlay_right_inset != inset {
            self.overlay_right_inset = inset;
            cx.notify();
        }
    }

    pub fn set_loading(&mut self, loading: bool, cx: &mut Context<Self>) {
        self.is_loading = loading;
        cx.notify();
    }

    pub fn set_pending_new_count(&mut self, count: Option<usize>, cx: &mut Context<Self>) {
        if self.pending_new_count != count {
            self.pending_new_count = count;
            cx.notify();
        }
    }

    pub fn is_browsing_or_scrolled(&self) -> bool {
        self.selected_id.is_some()
            || -self.scroll_handle.0.borrow().base_handle.offset().y > px(12.)
    }

    pub fn scroll_to_top(&mut self, cx: &mut Context<Self>) {
        if !self.items.is_empty() {
            self.scroll_handle
                .scroll_to_item(0, gpui::ScrollStrategy::Top);
            cx.notify();
        }
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
        self.hovered_row = None;
        cx.notify();
    }

    pub fn set_active_view_name(&mut self, name: Option<String>, cx: &mut Context<Self>) {
        if self.active_view_name != name {
            self.active_view_name = name;
            cx.notify();
        }
    }

    pub fn set_row_density(&mut self, density: RowDensity, cx: &mut Context<Self>) {
        if self.row_density != density {
            self.row_density = density;
            cx.notify();
        }
    }

    pub fn set_items(
        &mut self,
        items: Vec<MemoryListItem>,
        filtered: bool,
        total_matching: usize,
        total_store_nodes: usize,
        has_more: bool,
        cx: &mut Context<Self>,
    ) {
        self.items = items;
        self.item_ids = self.items.iter().map(|i| i.id.clone()).collect();
        self.filtered = filtered;
        self.total_store_nodes = total_store_nodes;
        self.total_matching = total_matching.max(self.items.len());
        self.has_more = has_more;
        self.loading_more = false;
        self.missing_db_path = None;
        self.error_banner = None;
        self.is_loading = false;
        self.hovered_row = None;
        cx.notify();
    }

    pub fn append_page(
        &mut self,
        next_items: Vec<MemoryListItem>,
        has_more: bool,
        total_matching: usize,
        cx: &mut Context<Self>,
    ) {
        let _added = append_deduped_items(&mut self.items, &mut self.item_ids, next_items);
        self.has_more = has_more;
        self.loading_more = false;
        self.total_matching = total_matching.max(self.items.len());
        cx.notify();
    }

    pub fn cancel_loading_more(&mut self, cx: &mut Context<Self>) {
        if self.loading_more {
            self.loading_more = false;
            cx.notify();
        }
    }

    fn maybe_request_next_page(&mut self, visible_end: usize, cx: &mut Context<Self>) {
        if self.has_more
            && !self.loading_more
            && !self.items.is_empty()
            && visible_end.saturating_add(10) >= self.items.len()
        {
            self.loading_more = true;
            cx.spawn(async move |this, cx| {
                let _ = this.update(cx, |this, cx| {
                    if this.has_more && this.loading_more {
                        cx.emit(ListEvent::LoadNextPage);
                    }
                });
            })
            .detach();
        }
    }

    pub fn set_selected(&mut self, id: Option<String>, scroll_to: bool, cx: &mut Context<Self>) {
        self.selected_id = id.clone();
        if scroll_to
            && let Some(target) = id
            && let Some(ix) = self.items.iter().position(|item| item.id == target)
        {
            self.scroll_handle
                .scroll_to_item(ix, gpui::ScrollStrategy::Center);
        }
        cx.notify();
    }

    pub fn set_missing_db(&mut self, path: Option<String>, cx: &mut Context<Self>) {
        self.missing_db_path = path;
        self.items.clear();
        self.is_loading = false;
        cx.notify();
    }

    pub fn set_error(&mut self, err: Option<String>, cx: &mut Context<Self>) {
        self.error_banner = err;
        self.is_loading = false;
        cx.notify();
    }

    pub fn close_popovers(&mut self, cx: &mut Context<Self>) {
        if self.open_popover != HeaderPopover::None {
            self.open_popover = HeaderPopover::None;
            cx.notify();
        }
    }

    pub fn has_open_popover(&self) -> bool {
        self.open_popover != HeaderPopover::None
    }

    pub fn select_relative(&mut self, delta: isize, cx: &mut Context<Self>) {
        if let Some(ix) = step_selection_index(&self.items, self.selected_id.as_deref(), delta)
            && let Some(item) = self.items.get(ix)
        {
            let id = item.id.clone();
            self.selected_id = Some(id.clone());
            self.scroll_handle
                .scroll_to_item(ix, gpui::ScrollStrategy::Center);
            cx.emit(ListEvent::Highlight(id));
            self.maybe_request_next_page(ix + 1, cx);
            cx.notify();
        }
    }

    pub fn select_edge(&mut self, first: bool, cx: &mut Context<Self>) {
        if self.items.is_empty() {
            return;
        }
        let ix = if first { 0 } else { self.items.len() - 1 };
        let id = self.items[ix].id.clone();
        self.selected_id = Some(id.clone());
        self.scroll_handle
            .scroll_to_item(ix, gpui::ScrollStrategy::Center);
        cx.emit(ListEvent::Highlight(id));
        self.maybe_request_next_page(ix + 1, cx);
        cx.notify();
    }

    pub fn open_selected(&mut self, cx: &mut Context<Self>) {
        if let Some(id) = self
            .selected_id
            .clone()
            .or_else(|| self.items.first().map(|item| item.id.clone()))
        {
            self.selected_id = Some(id.clone());
            cx.emit(ListEvent::Select(id));
            cx.notify();
        }
    }

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    fn active_popover_filter_count(&self) -> usize {
        let mut count = 0;
        if self.filter.namespace.is_some() {
            count += 1;
        }
        if self.filter.node_type.is_some() {
            count += 1;
        }
        if self.filter.provenance.is_some() {
            count += 1;
        }
        if self.filter.has_contradiction {
            count += 1;
        }
        if self.filter.stale_before_ms.is_some() || self.filter.untouched_only {
            count += 1;
        }
        if self.filter.max_trust.is_some() {
            count += 1;
        }
        if self.filter.duplicates_only {
            count += 1;
        }
        count
    }

    fn render_rows(
        &mut self,
        range: std::ops::Range<usize>,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        self.maybe_request_next_page(range.end, cx);
        let theme = self.theme;
        let now = Self::now_ms();
        let selected_id = self.selected_id.clone();

        let compact = self.row_density == RowDensity::Compact;
        let row_h = self.row_density.row_height_px();
        let right_inset = self.overlay_right_inset;

        range
            .filter_map(|ix| self.items.get(ix).map(|item| (ix, item)))
            .map(|(ix, item)| {
                let is_selected = selected_id.as_deref() == Some(item.id.as_str());
                let id_for_click = item.id.clone();
                let preview: SharedString = item.preview.to_string().into();
                let age: SharedString = format_relative_age(item.updated_at, now).into();
                let meta_line: SharedString = row_meta_line(item).into();
                let type_label: SharedString = item.node_type.to_string().into();
                let type_color = theme.type_color(&item.node_type);
                let marker = row_marker(item, self.pinned_ids.contains(&item.id));
                let marker_color = match marker {
                    Some(RowMarker::Quarantined | RowMarker::Conflict) => theme.danger,
                    Some(RowMarker::LowTrust) => theme.text_secondary,
                    Some(RowMarker::Pinned) => theme.accent,
                    None => theme.text_muted,
                };
                let aria: SharedString = match marker {
                    Some(m) => format!("{preview}. {}, {type_label}, {age} ago", m.label()),
                    None => format!("{preview}. {type_label}, {age} ago"),
                }
                .into();

                let is_hovered = is_row_hovered(
                    self.hovered_row,
                    self.suppress_hover_until_move,
                    ix,
                    self.external_hovered_id.as_deref(),
                    &item.id,
                );
                let bar_color = if is_selected {
                    theme.accent
                } else {
                    gpui::transparent_black()
                };

                let meta = div()
                    .w_full()
                    .min_w(px(0.))
                    .overflow_hidden()
                    .flex()
                    .items_center()
                    .gap(px(5.))
                    .text_size(px(12.))
                    .line_height(px(16.))
                    .text_color(theme.text_muted)
                    .child(
                        div()
                            .w(px(6.))
                            .h(px(6.))
                            .rounded_full()
                            .flex_shrink_0()
                            .bg(type_color),
                    )
                    .child(
                        div()
                            .flex_shrink_0()
                            .text_color(theme.text_secondary)
                            .child(type_label),
                    )
                    .when(!meta_line.is_empty(), |el| {
                        el.child(div().flex_shrink_0().child("·")).child(
                            div()
                                .flex_1()
                                .min_w(px(0.))
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .child(meta_line),
                        )
                    });

                let right_col = div()
                    .w(px(84.))
                    .flex_shrink_0()
                    .flex()
                    .flex_col()
                    .items_end()
                    .justify_center()
                    .gap(px(if compact { 1. } else { 4. }))
                    .child(
                        div()
                            .text_size(px(12.))
                            .line_height(px(16.))
                            .font_features(tabular_nums())
                            .text_color(theme.text_muted)
                            .child(age),
                    )
                    .when_some(marker, |col, m| {
                        col.child(crate::ui::views::kit::state_marker(m.label(), marker_color))
                    });

                let row = div()
                    .id(("memory-row", ix))
                    .focusable()
                    .cursor_pointer()
                    .role(Role::ListItem)
                    .aria_label(aria)
                    .aria_selected(is_selected)
                    .h(px(row_h))
                    .w_full()
                    .min_w(px(0.))
                    .overflow_hidden()
                    .pl(px(12.))
                    .pr(px(16.) + right_inset)
                    .py(px(if compact { 5. } else { 10. }))
                    .border_b_1()
                    .border_color(theme.border_subtle)
                    .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                        if this.suppress_hover_until_move {
                            if !*hovered && this.hovered_row == Some(ix) {
                                this.hovered_row = None;
                                cx.emit(ListEvent::Hover(None));
                                cx.notify();
                            }
                            return;
                        }
                        let next = if *hovered {
                            Some(ix)
                        } else if this.hovered_row == Some(ix) {
                            None
                        } else {
                            this.hovered_row
                        };
                        if next != this.hovered_row {
                            this.hovered_row = next;
                            let hovered_id = next
                                .and_then(|row| this.items.get(row))
                                .map(|item| item.id.clone());
                            cx.emit(ListEvent::Hover(hovered_id));
                            cx.notify();
                        }
                    }))
                    .focus_visible(move |s| s.border_1().border_color(theme.accent))
                    .flex()
                    .items_stretch()
                    .gap(px(10.))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.open_popover = HeaderPopover::None;
                        cx.emit(ListEvent::Select(id_for_click.clone()));
                    }))
                    .child(
                        div()
                            .w(px(2.))
                            .rounded(px(1.))
                            .flex_shrink_0()
                            .bg(bar_color),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .overflow_hidden()
                            .flex()
                            .flex_col()
                            .justify_center()
                            .gap(px(if compact { 1. } else { 4. }))
                            .child(
                                div()
                                    .w_full()
                                    .min_w(px(0.))
                                    .overflow_hidden()
                                    .whitespace_nowrap()
                                    .text_ellipsis()
                                    .text_size(px(14.))
                                    .line_height(px(if compact { 18. } else { 20. }))
                                    .font_weight(if is_selected {
                                        FontWeight::MEDIUM
                                    } else {
                                        FontWeight::NORMAL
                                    })
                                    .text_color(theme.text_primary)
                                    .child(preview),
                            )
                            .child(meta),
                    )
                    .child(right_col);

                if is_hovered && !is_selected {
                    row.with_animation(
                        ("memory-row-bg", ix),
                        Animation::new(Duration::from_millis(DURATION_FAST_MS))
                            .with_easing(ease_out_cubic),
                        move |el, t| el.bg(lerp_hsla(gpui::transparent_black(), theme.bg_hover, t)),
                    )
                    .into_any_element()
                } else {
                    row.bg(if is_selected {
                        theme.bg_selected
                    } else {
                        gpui::transparent_black()
                    })
                    .into_any_element()
                }
            })
            .collect()
    }

    fn render_filter_popover(&self, viewport_h: f32, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let namespaces = self
            .overview
            .as_ref()
            .map(|o| o.namespaces.clone())
            .unwrap_or_default();
        let types = self
            .overview
            .as_ref()
            .map(|o| o.types.clone())
            .unwrap_or_default();
        let provenances = self
            .overview
            .as_ref()
            .map(|o| o.provenances.clone())
            .unwrap_or_default();
        let has_facets = !namespaces.is_empty() || !types.is_empty() || !provenances.is_empty();
        let (popover_max_h, scroll_max_h) = filter_popover_heights(viewport_h);

        let group_est = |len: usize| -> f32 {
            if len == 0 {
                0.0
            } else {
                let shown = len.min(12) as f32;
                18.0 + shown * 28.0 + shown * 4.0 + 12.0
            }
        };
        let has_health = self.filter.stale_before_ms.is_some()
            || self.filter.untouched_only
            || self.filter.duplicates_only
            || self.filter.max_trust.is_some();
        let est_content_h = group_est(namespaces.len())
            + group_est(types.len())
            + group_est(provenances.len())
            + 30.0
            + if has_health { 42.0 } else { 0.0 };
        let max_y = self.filter_scroll_handle.max_offset().y.as_f32();
        let scroll_y = (-self.filter_scroll_handle.offset().y.as_f32()).max(0.0);
        let show_scroll_hint = if max_y > 1.0 {
            (max_y - scroll_y) > 2.0
        } else {
            est_content_h > scroll_max_h
        };

        deferred(
            div()
                .id("list-filter-popover")
                .w(px(264.))
                .max_h(px(popover_max_h))
                .rounded(px(14.))
                .bg(theme.glass_floating)
                .border_1()
                .border_color(theme.glass_border)
                .shadow_lg()
                .relative()
                .p(px(12.))
                .flex()
                .flex_col()
                .gap(px(10.))
                .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| {
                    cx.stop_propagation();
                })
                .on_scroll(cx.listener(|_, _, _, cx| {
                    cx.stop_propagation();
                    cx.notify();
                }))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .flex_shrink_0()
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(theme.text_primary)
                                .child("Filters"),
                        )
                        .when(!self.filter.is_empty(), |hdr| {
                            hdr.child(
                                div()
                                    .id("popover-clear-filters")
                                    .focusable()
                                    .cursor_pointer()
                                    .px(px(6.))
                                    .py(px(2.))
                                    .rounded(px(4.))
                                    .hover(move |s| s.bg(theme.bg_elevated))
                                    .text_size(px(12.))
                                    .text_color(theme.text_secondary)
                                    .child("Clear")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.open_popover = HeaderPopover::None;
                                        cx.emit(ListEvent::ClearFilters);
                                    })),
                            )
                        }),
                )
                .child(
                    div()
                        .relative()
                        .w_full()
                        .min_h(px(0.))
                        .max_h(px(scroll_max_h))
                        .child(
                            div()
                                .id("list-filter-scroll")
                                .w_full()
                                .min_h(px(0.))
                                .max_h(px(scroll_max_h))
                                .pr(px(8.))
                                .overflow_y_scroll()
                                .track_scroll(&self.filter_scroll_handle)
                                .flex()
                                .flex_col()
                                .gap(px(12.))
                                .when(!namespaces.is_empty(), |col| {
                                    col.child(self.render_facet_group(
                                        "Namespace",
                                        "ns",
                                        &namespaces,
                                        self.filter.namespace.as_deref(),
                                        |name, _, cx| cx.emit(ListEvent::ToggleNamespace(name)),
                                        cx,
                                    ))
                                })
                                .when(!types.is_empty(), |col| {
                                    col.child(self.render_facet_group(
                                        "Type",
                                        "type",
                                        &types,
                                        self.filter.node_type.as_deref(),
                                        |name, _, cx| cx.emit(ListEvent::ToggleType(name)),
                                        cx,
                                    ))
                                })
                                .when(!provenances.is_empty(), |col| {
                                    col.child(self.render_facet_group(
                                        "Provenance",
                                        "prov",
                                        &provenances,
                                        self.filter.provenance.as_deref(),
                                        |name, _, cx| cx.emit(ListEvent::ToggleProvenance(name)),
                                        cx,
                                    ))
                                })
                                .child(
                                    div()
                                        .id("popover-toggle-contradiction")
                                        .focusable()
                                        .cursor_pointer()
                                        .role(Role::Button)
                                        .aria_label(if self.filter.has_contradiction {
                                            "Has contradiction: On"
                                        } else {
                                            "Has contradiction: Off"
                                        })
                                        .h(px(30.))
                                        .px(px(8.))
                                        .rounded(px(6.))
                                        .bg(if self.filter.has_contradiction {
                                            theme.bg_selected
                                        } else {
                                            gpui::transparent_black()
                                        })
                                        .hover(move |s| s.bg(theme.bg_elevated))
                                        .flex()
                                        .items_center()
                                        .justify_between()
                                        .on_click(cx.listener(|_, _, _, cx| {
                                            cx.emit(ListEvent::ToggleContradictions);
                                        }))
                                        .child(
                                            div()
                                                .text_size(px(13.))
                                                .text_color(theme.text_primary)
                                                .child("Has contradiction"),
                                        )
                                        .child(
                                            div()
                                                .text_size(px(12.))
                                                .text_color(theme.text_muted)
                                                .child(if self.filter.has_contradiction {
                                                    "On"
                                                } else {
                                                    "Off"
                                                }),
                                        ),
                                )
                                .when(has_health, |col| {
                                    let mut labels = Vec::new();
                                    if self.filter.stale_before_ms.is_some() {
                                        labels.push("Stale / expired / drifted");
                                    }
                                    if self.filter.untouched_only {
                                        labels.push("Untouched for 90 days");
                                    }
                                    if self.filter.duplicates_only {
                                        labels.push("Exact duplicates");
                                    }
                                    if self.filter.max_trust.is_some() {
                                        labels.push("Low trust (< 0.50)");
                                    }
                                    col.child(
                                        div()
                                            .px(px(8.))
                                            .py(px(6.))
                                            .rounded(px(6.))
                                            .bg(theme.bg_selected)
                                            .text_size(px(12.))
                                            .text_color(theme.text_primary)
                                            .child(format!("Health: {}", labels.join(", "))),
                                    )
                                })
                                .when(!has_facets, |col| {
                                    col.child(
                                        div()
                                            .text_size(px(12.))
                                            .text_color(theme.text_muted)
                                            .child("No facet filters available."),
                                    )
                                }),
                        )
                        .child(render_vertical_scroll_overlay(
                            self.filter_scroll_handle.clone(),
                            theme.bg_floating,
                            theme,
                        )),
                )
                .when(show_scroll_hint, |pop| {
                    pop.child(
                        div()
                            .id("filter-scroll-more-hint")
                            .flex_shrink_0()
                            .pt(px(6.))
                            .border_t_1()
                            .border_color(theme.border_subtle)
                            .flex()
                            .items_center()
                            .justify_center()
                            .gap(px(4.))
                            .text_size(px(11.))
                            .text_color(theme.text_muted)
                            .child("Scroll for more")
                            .child(render_ui_icon(UiIcon::ChevronDown, 12.0, theme.text_muted)),
                    )
                }),
        )
        .with_priority(10)
        .into_any_element()
    }

    fn render_facet_group(
        &self,
        title: &'static str,
        id_prefix: &'static str,
        facets: &[crate::core::model::FacetCount],
        active_val: Option<&str>,
        on_select: impl Fn(String, &mut Self, &mut Context<Self>) + Clone + 'static,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let mut col = div().flex().flex_col().gap(px(4.)).child(
            div()
                .text_size(px(12.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.text_muted)
                .child(title),
        );

        for (ix, facet) in facets.iter().take(12).enumerate() {
            let active = active_val == Some(facet.name.as_str());
            let name = facet.name.clone();
            let cb = on_select.clone();
            col = col.child(
                div()
                    .id((id_prefix, ix))
                    .focusable()
                    .cursor_pointer()
                    .role(Role::Button)
                    .aria_label(format!("{} ({})", facet.name, facet.count))
                    .h(px(28.))
                    .px(px(8.))
                    .rounded(px(6.))
                    .bg(if active {
                        theme.bg_selected
                    } else {
                        gpui::transparent_black()
                    })
                    .hover(move |s| s.bg(theme.bg_elevated))
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        cb(name.clone(), this, cx);
                    }))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .min_w(px(0.))
                            .flex_1()
                            .child(div().w(px(2.)).h(px(14.)).rounded(px(1.)).bg(if active {
                                theme.accent
                            } else {
                                gpui::transparent_black()
                            }))
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .text_color(theme.text_primary)
                                    .truncate()
                                    .child(facet.name.clone()),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .font_features(tabular_nums())
                            .text_color(theme.text_muted)
                            .child(format!("{}", facet.count)),
                    ),
            );
        }

        col.into_any_element()
    }

    fn render_sort_popover(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let options = [SortOrder::Recency, SortOrder::Importance, SortOrder::Trust];

        deferred(
            div()
                .id("list-sort-popover")
                .w(px(176.))
                .rounded(px(14.))
                .bg(theme.glass_floating)
                .border_1()
                .border_color(theme.glass_border)
                .shadow_lg()
                .relative()
                .p(px(6.))
                .flex()
                .flex_col()
                .gap(px(2.))
                .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| {
                    cx.stop_propagation();
                })
                .children(options.into_iter().enumerate().map(|(ix, sort)| {
                    let active = self.filter.sort == sort;
                    div()
                        .id(("sort-option", ix))
                        .focusable()
                        .cursor_pointer()
                        .role(Role::Button)
                        .aria_label(sort.label())
                        .h(px(30.))
                        .px(px(8.))
                        .rounded(px(6.))
                        .bg(if active {
                            theme.bg_selected
                        } else {
                            gpui::transparent_black()
                        })
                        .hover(move |s| s.bg(theme.bg_elevated))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.open_popover = HeaderPopover::None;
                            cx.emit(ListEvent::SetSort(sort));
                        }))
                        .child(div().w(px(2.)).h(px(14.)).rounded(px(1.)).bg(if active {
                            theme.accent
                        } else {
                            gpui::transparent_black()
                        }))
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(if active {
                                    FontWeight::MEDIUM
                                } else {
                                    FontWeight::NORMAL
                                })
                                .text_color(theme.text_primary)
                                .child(sort.label()),
                        )
                })),
        )
        .with_priority(10)
        .into_any_element()
    }
}

impl Render for MemoryListView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let total = self.items.len();
        let viewport_h = window.viewport_size().height.as_f32();
        let now = Self::now_ms();

        let (_, page_title) = page_header_titles(&self.filter, self.active_view_name.as_deref());

        let count_text = format_list_count_text(
            total,
            self.total_matching,
            self.total_store_nodes,
            self.filtered,
            self.has_more,
        );
        let mut summary_parts = vec![count_text];
        if self.total_store_nodes > 0
            && let Some(ts) = self.overview.as_ref().and_then(|o| o.newest_updated_at)
        {
            summary_parts.push(format!("updated {}", format_relative_age(ts, now)));
        }
        let summary_line = summary_parts.join(" · ");

        let filter_count = self.active_popover_filter_count();
        let filter_label = if filter_count > 0 {
            format!("Filter ({filter_count})")
        } else {
            "Filter".to_string()
        };
        let sort_label = format!("Sort: {}", self.filter.sort.label());

        let header = div()
            .id("list-page-header")
            .w_full()
            .min_w(px(0.))
            .overflow_hidden()
            .pt(px(18.))
            .pb(px(12.))
            .pl(px(16.))
            .pr(px(16.) + self.overlay_right_inset)
            .border_b_1()
            .border_color(theme.border_subtle)
            .flex()
            .flex_col()
            .gap(px(3.))
            .child(
                div()
                    .w_full()
                    .min_w(px(0.))
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .child({
                        let title_anim: SharedString = format!("page-title-{page_title}").into();
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .text_size(px(20.))
                            .line_height(px(26.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.text_primary)
                            .truncate()
                            .child(page_title)
                            .with_animation(
                                title_anim,
                                Animation::new(Duration::from_millis(DURATION_NORMAL_MS))
                                    .with_easing(ease_out_cubic),
                                |el, t| el.opacity(0.35 + 0.65 * t),
                            )
                    })
                    .when(self.total_store_nodes > 0 || self.filtered, |row| {
                        row.child(
                            div()
                                .flex_shrink_0()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .child({
                                    let filter_expand = cx.entity().clone();
                                    let filter_collapse = filter_expand.clone();
                                    div()
                                        .id("list-filter-btn")
                                        .focusable()
                                        .cursor_pointer()
                                        .role(Role::Button)
                                        .aria_label(filter_label.clone())
                                        .aria_expanded(self.open_popover == HeaderPopover::Filter)
                                        .h(px(28.))
                                        .px(px(10.))
                                        .rounded(px(6.))
                                        .bg(
                                            if self.open_popover == HeaderPopover::Filter
                                                || filter_count > 0
                                            {
                                                theme.bg_elevated
                                            } else {
                                                gpui::transparent_black()
                                            },
                                        )
                                        .border_1()
                                        .border_color(theme.border_subtle)
                                        .hover(move |s| s.bg(theme.bg_elevated))
                                        .focus_visible(move |s| {
                                            s.border_1().border_color(theme.accent)
                                        })
                                        .flex()
                                        .items_center()
                                        .gap(px(6.))
                                        .text_size(px(12.))
                                        .text_color(theme.text_primary)
                                        .child(render_ui_icon(
                                            UiIcon::Filter,
                                            13.0,
                                            theme.text_secondary,
                                        ))
                                        .child(filter_label)
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.open_popover =
                                                if this.open_popover == HeaderPopover::Filter {
                                                    HeaderPopover::None
                                                } else {
                                                    this.filter_scroll_handle
                                                        .set_offset(point(px(0.), px(0.)));
                                                    cx.emit(ListEvent::PopoverOpened);
                                                    HeaderPopover::Filter
                                                };
                                            cx.notify();
                                        }))
                                        .on_a11y_action(
                                            AccessibleAction::Expand,
                                            move |_, _, cx| {
                                                filter_expand.update(cx, |this, cx| {
                                                    if this.open_popover != HeaderPopover::Filter {
                                                        this.filter_scroll_handle
                                                            .set_offset(point(px(0.), px(0.)));
                                                        cx.emit(ListEvent::PopoverOpened);
                                                        this.open_popover = HeaderPopover::Filter;
                                                        cx.notify();
                                                    }
                                                });
                                            },
                                        )
                                        .on_a11y_action(
                                            AccessibleAction::Collapse,
                                            move |_, _, cx| {
                                                filter_collapse.update(cx, |this, cx| {
                                                    if this.open_popover == HeaderPopover::Filter {
                                                        this.open_popover = HeaderPopover::None;
                                                        cx.notify();
                                                    }
                                                });
                                            },
                                        )
                                })
                                .child({
                                    let sort_expand = cx.entity().clone();
                                    let sort_collapse = sort_expand.clone();
                                    div()
                                        .id("list-sort-btn")
                                        .focusable()
                                        .cursor_pointer()
                                        .role(Role::Button)
                                        .aria_label(sort_label.clone())
                                        .aria_expanded(self.open_popover == HeaderPopover::Sort)
                                        .h(px(28.))
                                        .px(px(10.))
                                        .rounded(px(6.))
                                        .bg(if self.open_popover == HeaderPopover::Sort {
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
                                        .gap(px(6.))
                                        .text_size(px(12.))
                                        .text_color(theme.text_primary)
                                        .child(render_ui_icon(
                                            UiIcon::Sort,
                                            13.0,
                                            theme.text_secondary,
                                        ))
                                        .child(sort_label)
                                        .child(render_ui_icon(
                                            UiIcon::ChevronDown,
                                            12.0,
                                            theme.text_muted,
                                        ))
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.open_popover =
                                                if this.open_popover == HeaderPopover::Sort {
                                                    HeaderPopover::None
                                                } else {
                                                    cx.emit(ListEvent::PopoverOpened);
                                                    HeaderPopover::Sort
                                                };
                                            cx.notify();
                                        }))
                                        .on_a11y_action(
                                            AccessibleAction::Expand,
                                            move |_, _, cx| {
                                                sort_expand.update(cx, |this, cx| {
                                                    if this.open_popover != HeaderPopover::Sort {
                                                        cx.emit(ListEvent::PopoverOpened);
                                                        this.open_popover = HeaderPopover::Sort;
                                                        cx.notify();
                                                    }
                                                });
                                            },
                                        )
                                        .on_a11y_action(
                                            AccessibleAction::Collapse,
                                            move |_, _, cx| {
                                                sort_collapse.update(cx, |this, cx| {
                                                    if this.open_popover == HeaderPopover::Sort {
                                                        this.open_popover = HeaderPopover::None;
                                                        cx.notify();
                                                    }
                                                });
                                            },
                                        )
                                }),
                        )
                    }),
            )
            .child(
                div()
                    .text_size(px(12.))
                    .line_height(px(16.))
                    .font_features(tabular_nums())
                    .text_color(theme.text_muted)
                    .truncate()
                    .child(summary_line),
            );

        let body: AnyElement = if let Some(missing_path) = &self.missing_db_path {
            let path_display = if missing_path.chars().count() > 96 {
                let tail: String = missing_path
                    .chars()
                    .rev()
                    .take(93)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect();
                format!("…{tail}")
            } else {
                missing_path.clone()
            };
            div()
                .flex_1()
                .px(px(24.))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .max_w(px(460.))
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(12.))
                        .child(
                            div()
                                .text_size(px(19.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(theme.text_primary)
                                .child("No memory store yet"),
                        )
                        .child(
                            div()
                                .text_size(px(15.))
                                .line_height(px(21.))
                                .text_color(theme.text_muted)
                                .text_center()
                                .child("A store keeps what your AI remembers on this machine. Create one at the path below, or open an existing store from Settings."),
                        )
                        .child(
                            div()
                                .w_full()
                                .px(px(12.))
                                .py(px(8.))
                                .rounded(px(6.))
                                .bg(theme.bg_panel)
                                .border_1()
                                .border_color(theme.border_subtle)
                                .text_size(px(12.))
                                .text_color(theme.text_muted)
                                .truncate()
                                .child(path_display),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .child(
                                    div()
                                        .id("create-memory-store")
                                        .focusable()
                                        .role(Role::Button)
                                        .cursor_pointer()
                                        .h(px(34.))
                                        .px(px(14.))
                                        .rounded(px(6.))
                                        .bg(theme.accent)
                                        .hover(move |s| s.opacity(0.92))
                                        .text_size(px(13.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(theme.primary_btn_fg)
                                        .flex()
                                        .items_center()
                                        .child("Create memory store")
                                        .on_click(cx.listener({
                                            let target = PathBuf::from(missing_path);
                                            move |_, _, _, cx| {
                                                cx.emit(ListEvent::CreateStore(target.clone()));
                                            }
                                        })),
                                )
                                .child(
                                    div()
                                        .id("retry-open-db")
                                        .focusable()
                                        .cursor_pointer()
                                        .h(px(34.))
                                        .px(px(14.))
                                        .rounded(px(6.))
                                        .bg(theme.bg_elevated)
                                        .border_1()
                                        .border_color(theme.border_subtle)
                                        .hover(move |s| s.bg(theme.bg_selected))
                                        .text_size(px(13.))
                                        .text_color(theme.text_primary)
                                        .flex()
                                        .items_center()
                                        .child("Retry")
                                        .on_click(cx.listener(|_, _, _, cx| {
                                            cx.emit(ListEvent::RetryLoad);
                                        })),
                                ),
                        )
                        .child(
                            div()
                                .pt(px(2.))
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .text_color(theme.text_muted)
                                        .child("Prefer the CLI? `memos init --yes`"),
                                )
                                .child(
                                    div()
                                        .id("copy-init-cmd")
                                        .focusable()
                                        .cursor_pointer()
                                        .px(px(4.))
                                        .rounded(px(4.))
                                        .hover(move |s| s.bg(theme.bg_elevated))
                                        .text_size(px(12.))
                                        .text_color(theme.text_secondary)
                                        .child("Copy")
                                        .on_click(cx.listener(|_, _, _, cx| {
                                            cx.emit(ListEvent::CopyInitCommand);
                                        })),
                                ),
                        ),
                )
                .into_any_element()
        } else if let Some(err) = &self.error_banner {
            div()
                .flex_1()
                .px(px(24.))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .max_w(px(460.))
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(12.))
                        .child(
                            div()
                                .text_size(px(19.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(theme.danger)
                                .child("Could not open database"),
                        )
                        .child(
                            div()
                                .text_size(px(15.))
                                .line_height(px(21.))
                                .text_color(theme.text_muted)
                                .text_center()
                                .child(err.clone()),
                        )
                        .child(
                            div()
                                .id("retry-err-db")
                                .focusable()
                                .cursor_pointer()
                                .h(px(34.))
                                .px(px(14.))
                                .rounded(px(6.))
                                .bg(theme.bg_elevated)
                                .border_1()
                                .border_color(theme.border_subtle)
                                .text_size(px(13.))
                                .text_color(theme.text_primary)
                                .flex()
                                .items_center()
                                .child("Retry")
                                .on_click(cx.listener(|_, _, _, cx| {
                                    cx.emit(ListEvent::RetryLoad);
                                })),
                        ),
                )
                .into_any_element()
        } else if self.is_loading && total == 0 {
            div()
                .flex_1()
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(13.))
                .text_color(theme.text_muted)
                .child("Loading memories…")
                .into_any_element()
        } else if total == 0 && self.filtered {
            div()
                .flex_1()
                .px(px(24.))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .max_w(px(380.))
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(12.))
                        .child(
                            div()
                                .text_size(px(19.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(theme.text_primary)
                                .child("No matching memories"),
                        )
                        .child(
                            div()
                                .text_size(px(15.))
                                .line_height(px(21.))
                                .text_color(theme.text_muted)
                                .text_center()
                                .child("Try clearing your search or filter selections."),
                        )
                        .child(
                            div()
                                .id("clear-empty-filters")
                                .focusable()
                                .cursor_pointer()
                                .h(px(34.))
                                .px(px(14.))
                                .rounded(px(6.))
                                .bg(theme.bg_elevated)
                                .border_1()
                                .border_color(theme.border_subtle)
                                .hover(move |s| s.bg(theme.bg_selected))
                                .text_size(px(13.))
                                .text_color(theme.text_primary)
                                .flex()
                                .items_center()
                                .child("Reset filters")
                                .on_click(cx.listener(|_, _, _, cx| {
                                    cx.emit(ListEvent::ClearFilters);
                                })),
                        ),
                )
                .into_any_element()
        } else if total == 0 {
            div()
                .flex_1()
                .px(px(24.))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .max_w(px(460.))
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(16.))
                        .when(!self.no_fun, |col| {
                            let view_handle = cx.entity().clone();
                            col.child(render_momo_button(
                                "empty-state-momo",
                                64.0,
                                self.momo_status,
                                0.0,
                                1.0,
                                theme,
                                move |_, _, cx| {
                                    view_handle.update(cx, |_, cx| {
                                        cx.emit(ListEvent::OpenHealth);
                                    });
                                },
                            ))
                        })
                        .child(
                            div()
                                .text_size(px(19.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(theme.text_primary)
                                .child("No memories yet"),
                        )
                        .child(
                            div()
                                .text_size(px(15.))
                                .line_height(px(21.))
                                .text_color(theme.text_muted)
                                .text_center()
                                .child("Connect an AI tool so it can start remembering, or add the first memory yourself."),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(10.))
                                .child(
                                    div()
                                        .id("empty-connect-tool")
                                        .focusable()
                                        .role(Role::Button)
                                        .aria_label("Connect an AI tool")
                                        .cursor_pointer()
                                        .h(px(34.))
                                        .px(px(14.))
                                        .rounded(px(6.))
                                        .bg(theme.accent)
                                        .hover(move |s| s.opacity(0.92))
                                        .text_size(px(13.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(theme.primary_btn_fg)
                                        .flex()
                                        .items_center()
                                        .child("Connect an AI tool")
                                        .on_click(cx.listener(|_, _, _, cx| {
                                            cx.emit(ListEvent::OpenTools);
                                        })),
                                )
                                .child(
                                    div()
                                        .id("copy-store-cmd")
                                        .focusable()
                                        .role(Role::Button)
                                        .aria_label("Copy CLI command")
                                        .cursor_pointer()
                                        .px(px(4.))
                                        .rounded(px(4.))
                                        .hover(move |s| s.bg(theme.bg_elevated))
                                        .text_size(px(12.))
                                        .text_color(theme.text_muted)
                                        .child("Copy CLI command")
                                        .on_click(cx.listener(|_, _, _, cx| {
                                            cx.emit(ListEvent::CopyStoreCommand);
                                        })),
                                ),
                        ),
                )
                .into_any_element()
        } else {
            let entity = cx.entity().clone();
            let list_el = uniform_list("memory-virtual-list", total, move |range, _window, cx| {
                entity.update(cx, |this, cx| this.render_rows(range, cx))
            })
            .track_scroll(&self.scroll_handle)
            .w_full()
            .flex_1()
            .min_h(px(0.));

            div()
                .w_full()
                .flex_1()
                .min_w(px(0.))
                .min_h(px(0.))
                .overflow_hidden()
                .py(px(4.))
                .flex()
                .flex_col()
                .child(list_el)
                .into_any_element()
        };

        div()
            .id("memory-list-root")
            .relative()
            .flex_1()
            .min_w(px(0.))
            .overflow_hidden()
            .h_full()
            .bg(theme.bg_app)
            .flex()
            .flex_col()
            .on_mouse_move(cx.listener(|this, _, _, cx| {
                if this.suppress_hover_until_move {
                    this.suppress_hover_until_move = false;
                    cx.notify();
                }
            }))
            .child(header)
            .when_some(self.pending_new_count, |col, count| {
                let msg = if count == 0 {
                    "Store updated".to_string()
                } else if count == 1 {
                    "1 new memory".to_string()
                } else {
                    format!("{count} new memories")
                };
                col.child(
                    div()
                        .id("live-memory-strip")
                        .w_full()
                        .min_w(px(0.))
                        .h(px(34.))
                        .pl(px(16.))
                        .pr(px(16.) + self.overlay_right_inset)
                        .bg(theme.bg_sunken)
                        .border_b_1()
                        .border_color(theme.border_subtle)
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(8.))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .min_w(px(0.))
                                .child(status_dot(theme.success))
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(theme.text_primary)
                                        .truncate()
                                        .child(SharedString::from(msg)),
                                ),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .flex_shrink_0()
                                .when(count > 0, |row| {
                                    row.child(
                                        div()
                                            .id("live-jump-newest-btn")
                                            .focusable()
                                            .cursor_pointer()
                                            .role(Role::Button)
                                            .aria_label("Jump to newest memory")
                                            .h(px(24.))
                                            .px(px(8.))
                                            .rounded(px(5.))
                                            .hover(move |s| s.bg(theme.bg_hover))
                                            .flex()
                                            .items_center()
                                            .text_size(px(12.))
                                            .text_color(theme.text_secondary)
                                            .on_click(cx.listener(|_, _, _, cx| {
                                                cx.emit(ListEvent::ApplyLiveUpdates {
                                                    jump_to_newest: true,
                                                });
                                            }))
                                            .child("Jump to newest"),
                                    )
                                })
                                .child(
                                    div()
                                        .id("live-refresh-btn")
                                        .focusable()
                                        .cursor_pointer()
                                        .role(Role::Button)
                                        .aria_label("Refresh list")
                                        .h(px(24.))
                                        .px(px(10.))
                                        .rounded(px(5.))
                                        .bg(theme.bg_elevated)
                                        .border_1()
                                        .border_color(theme.border_subtle)
                                        .hover(move |s| s.bg(theme.bg_hover))
                                        .flex()
                                        .items_center()
                                        .text_size(px(12.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(theme.text_primary)
                                        .on_click(cx.listener(|_, _, _, cx| {
                                            cx.emit(ListEvent::ApplyLiveUpdates {
                                                jump_to_newest: false,
                                            });
                                        }))
                                        .child("Refresh"),
                                ),
                        ),
                )
            })
            .child(body)
            .when(self.open_popover != HeaderPopover::None, |container| {
                let popover = match self.open_popover {
                    HeaderPopover::Filter => self.render_filter_popover(viewport_h, cx),
                    HeaderPopover::Sort => self.render_sort_popover(cx),
                    HeaderPopover::None => unreachable!(),
                };
                container.child(
                    div()
                        .absolute()
                        .top(px(66.))
                        .right(px(16.) + self.overlay_right_inset)
                        .child(popover),
                )
            })
            .into_any_element()
    }
}

fn page_header_titles(filter: &QueryFilter, active_view_name: Option<&str>) -> (String, String) {
    if let Some(name) = active_view_name
        && !name.trim().is_empty()
    {
        let upper = name.trim().to_ascii_uppercase();
        let title = match name.trim() {
            "All" => "All memories".to_string(),
            "Recent" => "Recent memories".to_string(),
            "Important" => "Important memories".to_string(),
            other => other.to_string(),
        };
        return (format!("STORE / {upper}"), title);
    }
    if filter.is_empty() {
        return ("STORE / ALL".to_string(), "All memories".to_string());
    }
    if let Some(tag) = &filter.tag {
        return ("STORE / TAG".to_string(), format!("#{tag}"));
    }
    if let Some(ns) = &filter.namespace {
        return ("STORE / NAMESPACE".to_string(), ns.clone());
    }
    if filter.has_contradiction {
        return (
            "STORE / CONTRADICTIONS".to_string(),
            "Contradictions".to_string(),
        );
    }
    if filter.needs_review_only {
        return (
            "TODAY / NEEDS REVIEW".to_string(),
            "Needs review".to_string(),
        );
    }
    if filter.updated_not_new_after_ms.is_some() {
        return (
            "TODAY / CHANGED".to_string(),
            "Changed in last 24h".to_string(),
        );
    }
    if filter.expiring_window_ms.is_some() {
        return (
            "TODAY / EXPIRING".to_string(),
            "Expiring in 7 days".to_string(),
        );
    }
    if filter.created_after_ms.is_some() {
        return ("TODAY / NEW".to_string(), "New or recent".to_string());
    }
    if !filter.query.trim().is_empty() {
        return ("STORE / SEARCH".to_string(), "Search results".to_string());
    }
    (
        "STORE / FILTERED".to_string(),
        "Filtered memories".to_string(),
    )
}

fn filter_popover_heights(viewport_h: f32) -> (f32, f32) {
    let popover_max_h = (viewport_h - 190.0).clamp(200.0, 350.0);
    let scroll_max_h = (popover_max_h - 68.0).clamp(120.0, 282.0);
    (popover_max_h, scroll_max_h)
}

pub fn format_list_count_text(
    shown: usize,
    total_matching: usize,
    total_store_nodes: usize,
    filtered: bool,
    has_more: bool,
) -> String {
    if has_more || shown < total_matching {
        format!("showing {shown} of {total_matching} memories")
    } else if filtered {
        format!("{shown} of {total_store_nodes} memories")
    } else if total_store_nodes == 1 {
        "1 memory".to_string()
    } else {
        format!("{total_store_nodes} memories")
    }
}

/// Upper bound on rows retained in the list. Six pages of 750 rows is far
/// more than a session scrolls through, and it keeps memory bounded on stores
/// with tens of thousands of memories.
pub const LIST_MAX_ITEMS: usize = 5_000;

pub fn append_deduped_items(
    existing: &mut Vec<MemoryListItem>,
    seen: &mut HashSet<String>,
    next_items: Vec<MemoryListItem>,
) -> usize {
    let mut added = 0usize;
    for item in next_items {
        if seen.insert(item.id.clone()) {
            existing.push(item);
            added += 1;
        }
    }
    if existing.len() > LIST_MAX_ITEMS {
        let drop_n = existing.len() - LIST_MAX_ITEMS;
        for item in existing.drain(0..drop_n) {
            seen.remove(&item.id);
        }
    }
    added
}

fn step_selection_index(
    items: &[MemoryListItem],
    selected_id: Option<&str>,
    delta: isize,
) -> Option<usize> {
    if items.is_empty() {
        return None;
    }
    let current = selected_id.and_then(|id| items.iter().position(|item| item.id == id));
    let next = match current {
        Some(ix) => {
            let signed = ix as isize + delta;
            signed.clamp(0, items.len().saturating_sub(1) as isize) as usize
        }
        None => {
            if delta < 0 {
                items.len() - 1
            } else {
                0
            }
        }
    };
    Some(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_item(id: &str) -> MemoryListItem {
        MemoryListItem {
            id: id.to_string(),
            short_id: id[..id.len().min(6)].into(),
            preview: format!("Preview {id}").into(),
            node_type: "fact".into(),
            namespace: "default".into(),
            provenance: "user".into(),
            source: "manual".into(),
            harness: String::new().into(),
            tags: Vec::new(),
            importance: 0.5,
            trust_score: 0.9,
            created_at: 100,
            updated_at: 100,
            has_contradiction: false,
            quarantined: false,
        }
    }

    #[test]
    fn step_selection_index_navigates_and_clamps() {
        let items = vec![sample_item("m1"), sample_item("m2"), sample_item("m3")];
        assert_eq!(step_selection_index(&items, None, 1), Some(0));
        assert_eq!(step_selection_index(&items, None, -1), Some(2));
        assert_eq!(step_selection_index(&items, Some("m1"), 1), Some(1));
        assert_eq!(step_selection_index(&items, Some("m1"), -1), Some(0));
        assert_eq!(step_selection_index(&items, Some("m3"), 1), Some(2));
        assert_eq!(step_selection_index(&[], Some("m1"), 1), None);
    }

    #[test]
    fn filter_popover_heights_cap_inside_600px_and_900px_viewports() {
        let (pop_600, scroll_600) = filter_popover_heights(560.0);
        assert!(pop_600 <= 350.0);
        assert!(scroll_600 < pop_600);
        assert!(pop_600 + 90.0 <= 560.0);

        let (pop_900, scroll_900) = filter_popover_heights(860.0);
        assert_eq!(pop_900, 350.0);
        assert_eq!(scroll_900, 282.0);
    }

    #[test]
    fn clear_hover_state_clears_row_and_suppresses_until_move() {
        let mut view = MemoryListView::new(ThemePalette::for_mode(
            crate::core::settings::ThemeMode::Dark,
        ));
        view.hovered_row = Some(3);
        view.suppress_hover_until_move = false;
        assert!(view.clear_hover_state());
        assert_eq!(view.hovered_row, None);
        assert!(view.suppress_hover_until_move);
        assert!(!view.clear_hover_state());
        assert!(is_row_hovered(None, true, 0, Some("m1"), "m1"));
        assert!(!is_row_hovered(None, true, 0, Some("m1"), "m2"));
    }

    #[test]
    fn append_deduped_items_and_count_text_behave_cleanly() {
        let mut items = vec![sample_item("m1"), sample_item("m2")];
        let mut seen: HashSet<String> = items.iter().map(|i| i.id.clone()).collect();
        let added = append_deduped_items(
            &mut items,
            &mut seen,
            vec![sample_item("m2"), sample_item("m3"), sample_item("m4")],
        );
        assert_eq!(added, 2);
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["m1", "m2", "m3", "m4"]);

        assert_eq!(
            format_list_count_text(500, 1200, 2000, false, true),
            "showing 500 of 1200 memories"
        );
        assert_eq!(
            format_list_count_text(500, 750, 2000, true, true),
            "showing 500 of 750 memories"
        );
        assert_eq!(
            format_list_count_text(42, 42, 2000, true, false),
            "42 of 2000 memories"
        );
        assert_eq!(format_list_count_text(1, 1, 1, false, false), "1 memory");
    }

    #[test]
    fn append_caps_retained_rows_and_keeps_the_dedupe_set_in_sync() {
        let mut items = Vec::new();
        let mut seen = HashSet::new();
        let batch: Vec<_> = (0..LIST_MAX_ITEMS + 250)
            .map(|i| sample_item(&format!("m{i}")))
            .collect();
        append_deduped_items(&mut items, &mut seen, batch);
        assert_eq!(items.len(), LIST_MAX_ITEMS);
        assert_eq!(seen.len(), LIST_MAX_ITEMS);
        assert_eq!(items.first().map(|i| i.id.as_str()), Some("m250"));
        assert!(!seen.contains("m0"));

        // Every retained id is still deduplicated.
        let added = append_deduped_items(
            &mut items,
            &mut seen,
            vec![sample_item("m250"), sample_item("tail")],
        );
        assert_eq!(added, 1);
    }
}
