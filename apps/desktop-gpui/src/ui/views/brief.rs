use gpui::{
    AnyElement, Context, EventEmitter, FontWeight, InteractiveElement, IntoElement, ParentElement,
    Render, Role, ScrollHandle, SharedString, StatefulInteractiveElement, Styled, Window, div, px,
};

use crate::core::model::{
    BriefContradictionPair, BriefSnapshot, MemoryListItem, QueryFilter, SortOrder,
    format_relative_age, format_time_relative_and_absolute,
};
use crate::ui::views::{
    ThemePalette, UiIcon, render_ui_icon, render_vertical_scroll_overlay, status_dot, tabular_nums,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BriefSectionKind {
    New,
    Changed,
    Expiring,
    Contradictions,
    NeedsReview,
}

impl BriefSectionKind {
    pub fn title(self) -> &'static str {
        match self {
            BriefSectionKind::New => "New",
            BriefSectionKind::Changed => "Changed",
            BriefSectionKind::Expiring => "Expiring soon",
            BriefSectionKind::Contradictions => "Contradictions",
            BriefSectionKind::NeedsReview => "Worth a look",
        }
    }

    pub fn view_name(self) -> &'static str {
        match self {
            BriefSectionKind::New => "Today · New",
            BriefSectionKind::Changed => "Today · Changed",
            BriefSectionKind::Expiring => "Today · Expiring",
            BriefSectionKind::Contradictions => "Contradictions",
            BriefSectionKind::NeedsReview => "Today · Worth a look",
        }
    }

    pub fn to_filter(self, now_ms: i64) -> QueryFilter {
        const ONE_DAY_MS: i64 = 86_400_000;
        const SEVEN_DAYS_MS: i64 = 7 * 86_400_000;
        let day_ago = now_ms.saturating_sub(ONE_DAY_MS);
        let week_ahead = now_ms.saturating_add(SEVEN_DAYS_MS);
        match self {
            BriefSectionKind::New => QueryFilter {
                created_after_ms: Some(day_ago),
                sort: SortOrder::Recency,
                ..Default::default()
            },
            BriefSectionKind::Changed => QueryFilter {
                updated_not_new_after_ms: Some(day_ago),
                sort: SortOrder::Recency,
                ..Default::default()
            },
            BriefSectionKind::Expiring => QueryFilter {
                expiring_window_ms: Some((now_ms, week_ahead)),
                sort: SortOrder::Recency,
                ..Default::default()
            },
            BriefSectionKind::Contradictions => QueryFilter {
                has_contradiction: true,
                sort: SortOrder::Recency,
                ..Default::default()
            },
            BriefSectionKind::NeedsReview => QueryFilter {
                needs_review_only: true,
                sort: SortOrder::Recency,
                ..Default::default()
            },
        }
    }
}

#[derive(Clone, Debug)]
pub enum BriefEvent {
    OpenMemory(String),
    ViewAll(BriefSectionKind),
    ViewAllMemories,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BriefRowCursorItem {
    pub memory_id: String,
}

pub fn brief_selectable_ids(snapshot: &BriefSnapshot) -> Vec<String> {
    let mut ids = Vec::new();
    for item in &snapshot.new_items {
        ids.push(item.id.clone());
    }
    for item in &snapshot.changed_items {
        ids.push(item.id.clone());
    }
    for item in &snapshot.expiring_items {
        ids.push(item.id.clone());
    }
    for pair in &snapshot.contradiction_pairs {
        ids.push(pair.node_a_id.clone());
    }
    for item in &snapshot.needs_review_items {
        ids.push(item.id.clone());
    }
    ids
}

pub fn format_brief_date_utc(now_ms: i64) -> String {
    let secs = now_ms.div_euclid(1000);
    if let Ok(dt) = time::OffsetDateTime::from_unix_timestamp(secs) {
        let format = time::macros::format_description!("[year]-[month]-[day]");
        dt.format(&format).unwrap_or_else(|_| "Today".to_string())
    } else {
        "Today".to_string()
    }
}

/// Human date for the Today header, e.g. `Wed, Nov 18`.
pub fn format_brief_date_label(now_ms: i64) -> String {
    let secs = now_ms.div_euclid(1000);
    if let Ok(dt) = time::OffsetDateTime::from_unix_timestamp(secs) {
        let format =
            time::macros::format_description!("[weekday repr:short], [month repr:short] [day]");
        dt.format(&format).unwrap_or_else(|_| "Today".to_string())
    } else {
        "Today".to_string()
    }
}

pub struct BriefView {
    snapshot: BriefSnapshot,
    selected_id: Option<String>,
    loading: bool,
    error: Option<String>,
    overlay_right_inset: gpui::Pixels,
    scroll_handle: ScrollHandle,
    theme: ThemePalette,
}

impl EventEmitter<BriefEvent> for BriefView {}

impl BriefView {
    pub fn new(theme: ThemePalette) -> Self {
        Self {
            snapshot: BriefSnapshot::default(),
            selected_id: None,
            loading: false,
            error: None,
            overlay_right_inset: px(0.),
            scroll_handle: ScrollHandle::new(),
            theme,
        }
    }

    pub fn set_theme(&mut self, theme: ThemePalette, cx: &mut Context<Self>) {
        self.theme = theme;
        cx.notify();
    }

    pub fn set_loading(&mut self, loading: bool, cx: &mut Context<Self>) {
        self.loading = loading;
        cx.notify();
    }

    pub fn set_error(&mut self, error: Option<String>, cx: &mut Context<Self>) {
        self.error = error;
        self.loading = false;
        cx.notify();
    }

    pub fn set_overlay_right_inset(&mut self, inset: gpui::Pixels, cx: &mut Context<Self>) {
        if self.overlay_right_inset != inset {
            self.overlay_right_inset = inset;
            cx.notify();
        }
    }

    pub fn set_selected(&mut self, id: Option<String>, cx: &mut Context<Self>) {
        if self.selected_id != id {
            self.selected_id = id;
            cx.notify();
        }
    }

    pub fn set_snapshot(&mut self, snapshot: BriefSnapshot, cx: &mut Context<Self>) {
        self.snapshot = snapshot;
        self.loading = false;
        self.error = None;
        let ids = brief_selectable_ids(&self.snapshot);
        if self
            .selected_id
            .as_ref()
            .is_some_and(|sel| !ids.contains(sel))
        {
            self.selected_id = None;
        }
        cx.notify();
    }

    pub fn select_relative(&mut self, delta: isize, cx: &mut Context<Self>) {
        let ids = brief_selectable_ids(&self.snapshot);
        if ids.is_empty() {
            return;
        }
        let current = self
            .selected_id
            .as_ref()
            .and_then(|sel| ids.iter().position(|id| id == sel));
        let next_ix = match current {
            Some(ix) => {
                (ix as isize + delta).clamp(0, ids.len().saturating_sub(1) as isize) as usize
            }
            None => {
                if delta < 0 {
                    ids.len() - 1
                } else {
                    0
                }
            }
        };
        let next_id = ids[next_ix].clone();
        self.selected_id = Some(next_id);
        cx.notify();
    }

    pub fn open_selected(&mut self, cx: &mut Context<Self>) {
        let ids = brief_selectable_ids(&self.snapshot);
        let target = self
            .selected_id
            .clone()
            .filter(|sel| ids.contains(sel))
            .or_else(|| ids.into_iter().next());
        if let Some(id) = target {
            self.selected_id = Some(id.clone());
            cx.emit(BriefEvent::OpenMemory(id));
            cx.notify();
        }
    }

    fn render_memory_row(
        &self,
        section: BriefSectionKind,
        ix: usize,
        item: &MemoryListItem,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let is_selected = self.selected_id.as_deref() == Some(item.id.as_str());
        let id_for_click = item.id.clone();
        let age = format_relative_age(item.updated_at, self.snapshot.now_ms);
        let type_color = theme.type_color(&item.node_type);
        let meta = format!("{} · {} · {}", item.node_type, item.namespace, age);
        div()
            .id((section.title(), ix))
            .focusable()
            .role(Role::ListItem)
            .aria_selected(is_selected)
            .cursor_pointer()
            .w_full()
            .px(px(12.))
            .py(px(9.))
            .rounded(px(6.))
            .bg(if is_selected {
                theme.bg_selected
            } else {
                theme.bg_panel
            })
            .hover(move |s| {
                s.bg(if is_selected {
                    theme.bg_selected
                } else {
                    theme.bg_hover
                })
            })
            .flex()
            .flex_col()
            .gap(px(4.))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.selected_id = Some(id_for_click.clone());
                cx.emit(BriefEvent::OpenMemory(id_for_click.clone()));
                cx.notify();
            }))
            .child(
                div()
                    .w_full()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(7.))
                            .min_w(px(0.))
                            .flex_1()
                            .child(status_dot(type_color))
                            .child(
                                div()
                                    .text_size(px(14.))
                                    .line_height(px(19.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.text_primary)
                                    .truncate()
                                    .child(SharedString::from(item.preview.to_string())),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(11.))
                            .font_features(tabular_nums())
                            .text_color(theme.text_muted)
                            .flex_shrink_0()
                            .child(SharedString::from(format!("#{}", item.short_id))),
                    ),
            )
            .child(
                div()
                    .text_size(px(12.))
                    .line_height(px(16.))
                    .font_features(tabular_nums())
                    .text_color(theme.text_muted)
                    .truncate()
                    .child(SharedString::from(meta)),
            )
            .into_any_element()
    }

    fn render_contradiction_row(
        &self,
        ix: usize,
        pair: &BriefContradictionPair,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let is_selected = self.selected_id.as_deref() == Some(pair.node_a_id.as_str())
            || self.selected_id.as_deref() == Some(pair.node_b_id.as_str());
        let id_a = pair.node_a_id.clone();
        let id_b = pair.node_b_id.clone();
        let detected = format_time_relative_and_absolute(pair.detected_at, self.snapshot.now_ms);
        div()
            .id(("brief-contra", ix))
            .focusable()
            .role(Role::ListItem)
            .aria_selected(is_selected)
            .w_full()
            .p(px(12.))
            .rounded(px(6.))
            .bg(if is_selected {
                theme.bg_selected
            } else {
                theme.bg_panel
            })
            .flex()
            .flex_col()
            .gap(px(6.))
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
                            .gap(px(6.))
                            .child(status_dot(theme.danger))
                            .child(
                                div()
                                    .text_size(px(11.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme.danger)
                                    .child(SharedString::from(format_contradiction_status_label(
                                        &pair.status,
                                    ))),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(11.))
                            .font_features(tabular_nums())
                            .text_color(theme.text_muted)
                            .child(SharedString::from(detected)),
                    ),
            )
            .child(
                div()
                    .id(("brief-contra-a", ix))
                    .cursor_pointer()
                    .px(px(8.))
                    .py(px(5.))
                    .rounded(px(5.))
                    .bg(theme.bg_elevated)
                    .hover(move |s| s.bg(theme.bg_hover))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.selected_id = Some(id_a.clone());
                        cx.emit(BriefEvent::OpenMemory(id_a.clone()));
                        cx.notify();
                    }))
                    .child(
                        div()
                            .text_size(px(11.))
                            .font_features(tabular_nums())
                            .text_color(theme.text_muted)
                            .flex_shrink_0()
                            .child(SharedString::from(format!("#{}", pair.node_a_short_id))),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .text_size(px(13.))
                            .text_color(theme.text_primary)
                            .truncate()
                            .child(SharedString::from(pair.node_a_preview.clone())),
                    ),
            )
            .child(
                div()
                    .id(("brief-contra-b", ix))
                    .cursor_pointer()
                    .px(px(8.))
                    .py(px(5.))
                    .rounded(px(5.))
                    .bg(theme.bg_elevated)
                    .hover(move |s| s.bg(theme.bg_hover))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.selected_id = Some(id_b.clone());
                        cx.emit(BriefEvent::OpenMemory(id_b.clone()));
                        cx.notify();
                    }))
                    .child(
                        div()
                            .text_size(px(11.))
                            .font_features(tabular_nums())
                            .text_color(theme.text_muted)
                            .flex_shrink_0()
                            .child(SharedString::from(format!("#{}", pair.node_b_short_id))),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .text_size(px(13.))
                            .text_color(theme.text_primary)
                            .truncate()
                            .child(SharedString::from(pair.node_b_preview.clone())),
                    ),
            )
            .into_any_element()
    }

    fn render_section_card(
        &self,
        kind: BriefSectionKind,
        total_count: usize,
        rows: Vec<AnyElement>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        div()
            .w_full()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(
                div()
                    .w_full()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .child({
                        let mut title_row = div().flex().items_center().gap(px(8.));
                        if kind == BriefSectionKind::Contradictions {
                            title_row = title_row.child(status_dot(theme.danger));
                        }
                        title_row
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme.text_primary)
                                    .child(kind.title()),
                            )
                            .child({
                                let (pill_bg, pill_fg) = if kind == BriefSectionKind::Contradictions
                                {
                                    (theme.danger_soft, theme.danger)
                                } else {
                                    (theme.bg_badge, theme.text_muted)
                                };
                                div()
                                    .px(px(7.))
                                    .py(px(1.))
                                    .rounded(px(10.))
                                    .bg(pill_bg)
                                    .text_size(px(11.))
                                    .font_features(tabular_nums())
                                    .text_color(pill_fg)
                                    .child(SharedString::from(total_count.to_string()))
                            })
                    })
                    .child(
                        div()
                            .id(("brief-view-all", kind as usize))
                            .focusable()
                            .role(Role::Button)
                            .cursor_pointer()
                            .px(px(8.))
                            .py(px(3.))
                            .rounded(px(5.))
                            .hover(move |s| s.bg(theme.bg_elevated))
                            .flex()
                            .items_center()
                            .gap(px(4.))
                            .text_size(px(12.))
                            .text_color(theme.accent_text)
                            .on_click(cx.listener(move |_, _, _, cx| {
                                cx.emit(BriefEvent::ViewAll(kind));
                            }))
                            .child("View all")
                            .child(render_ui_icon(UiIcon::ArrowRight, 11.0, theme.accent_text)),
                    ),
            )
            .child(div().flex().flex_col().gap(px(6.)).children(rows))
            .into_any_element()
    }
}

impl Render for BriefView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let date_label = format_brief_date_label(self.snapshot.now_ms);
        let subtitle = date_label;
        let scroll_handle = self.scroll_handle.clone();

        let header = div()
            .id("brief-page-header")
            .w_full()
            .min_w(px(0.))
            .pt(px(22.))
            .pb(px(14.))
            .pl(px(20.))
            .pr(px(20.) + self.overlay_right_inset)
            .border_b_1()
            .border_color(theme.border_subtle)
            .flex()
            .flex_col()
            .gap(px(3.))
            .child(
                div()
                    .text_size(px(21.))
                    .line_height(px(26.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(theme.text_primary)
                    .child("Today"),
            )
            .child(
                div()
                    .text_size(px(13.))
                    .line_height(px(18.))
                    .font_features(tabular_nums())
                    .text_color(theme.text_muted)
                    .child(SharedString::from(subtitle)),
            );

        let body: AnyElement = if let Some(err) = &self.error {
            div()
                .flex_1()
                .px(px(24.))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .max_w(px(420.))
                        .text_size(px(14.))
                        .text_color(theme.danger)
                        .child(SharedString::from(err.clone())),
                )
                .into_any_element()
        } else if self.loading && self.snapshot.is_empty() {
            div()
                .flex_1()
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .text_size(px(14.))
                        .text_color(theme.text_muted)
                        .child("Loading today's brief…"),
                )
                .into_any_element()
        } else if self.snapshot.is_empty() {
            div()
                .id("brief-empty-state")
                .flex_1()
                .px(px(24.))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .max_w(px(420.))
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(14.))
                        .child(
                            div()
                                .text_size(px(18.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(theme.text_primary)
                                .child("Nothing changed in the last 24 hours"),
                        )
                        .child(
                            div()
                                .id("brief-view-all-memories-btn")
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
                                .on_click(cx.listener(|_, _, _, cx| {
                                    cx.emit(BriefEvent::ViewAllMemories);
                                }))
                                .child("View all memories"),
                        ),
                )
                .into_any_element()
        } else {
            let mut sections: Vec<AnyElement> = Vec::new();
            if !self.snapshot.new_items.is_empty() {
                let rows = self
                    .snapshot
                    .new_items
                    .iter()
                    .enumerate()
                    .map(|(ix, it)| self.render_memory_row(BriefSectionKind::New, ix, it, cx))
                    .collect();
                sections.push(self.render_section_card(
                    BriefSectionKind::New,
                    self.snapshot.new_count,
                    rows,
                    cx,
                ));
            }
            if !self.snapshot.changed_items.is_empty() {
                let rows = self
                    .snapshot
                    .changed_items
                    .iter()
                    .enumerate()
                    .map(|(ix, it)| self.render_memory_row(BriefSectionKind::Changed, ix, it, cx))
                    .collect();
                sections.push(self.render_section_card(
                    BriefSectionKind::Changed,
                    self.snapshot.changed_count,
                    rows,
                    cx,
                ));
            }
            if !self.snapshot.expiring_items.is_empty() {
                let rows = self
                    .snapshot
                    .expiring_items
                    .iter()
                    .enumerate()
                    .map(|(ix, it)| self.render_memory_row(BriefSectionKind::Expiring, ix, it, cx))
                    .collect();
                sections.push(self.render_section_card(
                    BriefSectionKind::Expiring,
                    self.snapshot.expiring_count,
                    rows,
                    cx,
                ));
            }
            if !self.snapshot.contradiction_pairs.is_empty() {
                let rows = self
                    .snapshot
                    .contradiction_pairs
                    .iter()
                    .enumerate()
                    .map(|(ix, pair)| self.render_contradiction_row(ix, pair, cx))
                    .collect();
                sections.push(self.render_section_card(
                    BriefSectionKind::Contradictions,
                    self.snapshot.contradiction_count,
                    rows,
                    cx,
                ));
            }
            if !self.snapshot.needs_review_items.is_empty() {
                let rows = self
                    .snapshot
                    .needs_review_items
                    .iter()
                    .enumerate()
                    .map(|(ix, it)| {
                        self.render_memory_row(BriefSectionKind::NeedsReview, ix, it, cx)
                    })
                    .collect();
                sections.push(self.render_section_card(
                    BriefSectionKind::NeedsReview,
                    self.snapshot.needs_review_count,
                    rows,
                    cx,
                ));
            }

            div()
                .relative()
                .flex_1()
                .min_h(px(0.))
                .w_full()
                .child(
                    div()
                        .id("brief-scroll")
                        .size_full()
                        .overflow_y_scroll()
                        .track_scroll(&self.scroll_handle)
                        .pl(px(20.))
                        .pr(px(20.) + self.overlay_right_inset)
                        .py(px(18.))
                        .flex()
                        .flex_col()
                        .gap(px(20.))
                        .children(sections),
                )
                .child(render_vertical_scroll_overlay(
                    scroll_handle,
                    theme.bg_app,
                    theme,
                ))
                .into_any_element()
        };

        div()
            .id("brief-view-root")
            .flex_1()
            .h_full()
            .min_w(px(0.))
            .overflow_hidden()
            .bg(theme.bg_app)
            .flex()
            .flex_col()
            .child(header)
            .child(body)
    }
}

/// Format contradiction status without repeating `"Unresolved (unresolved)"`.
pub fn format_contradiction_status_label(status: &str) -> String {
    let trimmed = status.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("unresolved") {
        "Unresolved".to_string()
    } else {
        let mut chars = trimmed.chars();
        match chars.next() {
            Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
            None => "Unresolved".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_item(id: &str) -> MemoryListItem {
        MemoryListItem {
            id: id.to_string(),
            short_id: id.into(),
            preview: format!("Item {id}").into(),
            node_type: "fact".into(),
            namespace: "default".into(),
            provenance: "user".into(),
            source: "cli".into(),
            harness: "codex".into(),
            tags: Vec::new(),
            importance: 0.5,
            trust_score: 0.9,
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
            has_contradiction: false,
            quarantined: false,
        }
    }

    #[test]
    fn brief_selectable_ids_and_section_filters_work() {
        let now_ms = 1_793_577_600_000_i64;
        assert_eq!(format_brief_date_utc(now_ms), "2026-11-02");

        let empty = BriefSnapshot {
            now_ms,
            ..Default::default()
        };
        assert!(empty.is_empty());
        assert!(brief_selectable_ids(&empty).is_empty());

        let populated = BriefSnapshot {
            now_ms,
            new_items: vec![mk_item("n1")],
            new_count: 1,
            changed_items: vec![mk_item("c1")],
            changed_count: 1,
            expiring_items: vec![mk_item("e1")],
            expiring_count: 1,
            contradiction_pairs: vec![BriefContradictionPair {
                id: "pair1".to_string(),
                node_a_id: "x1".to_string(),
                node_a_short_id: "x1".to_string(),
                node_a_preview: "A".to_string(),
                node_b_id: "x2".to_string(),
                node_b_short_id: "x2".to_string(),
                node_b_preview: "B".to_string(),
                status: "open".to_string(),
                detected_at: now_ms,
            }],
            contradiction_count: 1,
            needs_review_items: vec![mk_item("r1")],
            needs_review_count: 1,
            unique_count: 5,
        };
        assert!(!populated.is_empty());
        assert_eq!(populated.total_count(), 5);
        assert_eq!(
            brief_selectable_ids(&populated),
            vec!["n1", "c1", "e1", "x1", "r1"]
        );

        assert_eq!(
            BriefSectionKind::New.to_filter(now_ms).created_after_ms,
            Some(now_ms - 86_400_000)
        );
        assert_eq!(
            BriefSectionKind::Changed
                .to_filter(now_ms)
                .updated_not_new_after_ms,
            Some(now_ms - 86_400_000)
        );
        assert_eq!(
            BriefSectionKind::Expiring
                .to_filter(now_ms)
                .expiring_window_ms,
            Some((now_ms, now_ms + 7 * 86_400_000))
        );
        assert!(
            BriefSectionKind::Contradictions
                .to_filter(now_ms)
                .has_contradiction
        );
        assert!(
            BriefSectionKind::NeedsReview
                .to_filter(now_ms)
                .needs_review_only
        );
        assert_eq!(
            format_contradiction_status_label("unresolved"),
            "Unresolved"
        );
        assert_eq!(format_contradiction_status_label(""), "Unresolved");
        assert_eq!(format_contradiction_status_label("open"), "Open");
    }
}
