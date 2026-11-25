use std::time::{SystemTime, UNIX_EPOCH};

use gpui::{
    AnyElement, Context, EventEmitter, FontWeight, InteractiveElement, IntoElement, ParentElement,
    Render, Role, ScrollHandle, SharedString, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder, px,
};

use crate::core::model::format_relative_age;
use crate::core::write_bridge::ReviewQueueItem;
use crate::ui::views::{
    ThemePalette, UiIcon, render_ui_icon, render_vertical_scroll_overlay, status_dot, tabular_nums,
    tooltip_view,
};

#[derive(Clone, Debug)]
pub enum ReviewEvent {
    Refresh,
    OpenMemory(String),
    Approve(String),
    Reject(String),
    OpenSettings,
}

pub fn is_review_mutation_enabled(write_mode: bool, busy_id: Option<&str>) -> bool {
    write_mode && busy_id.is_none()
}

pub fn review_gate_notice(write_mode: bool) -> Option<&'static str> {
    if write_mode {
        None
    } else {
        Some("Turn on editing to approve")
    }
}

pub fn review_selectable_ids(items: &[ReviewQueueItem]) -> Vec<String> {
    items.iter().map(|i| i.id.clone()).collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReviewLoadError {
    CapabilityMissing(String),
    Other(String),
}

impl ReviewLoadError {
    pub fn is_capability_missing(&self) -> bool {
        matches!(self, ReviewLoadError::CapabilityMissing(_))
    }

    pub fn message(&self) -> &str {
        match self {
            ReviewLoadError::CapabilityMissing(msg) | ReviewLoadError::Other(msg) => msg,
        }
    }

    pub fn title(&self) -> &'static str {
        match self {
            ReviewLoadError::CapabilityMissing(_) => "Review queue unavailable",
            ReviewLoadError::Other(_) => "Could not load review queue",
        }
    }
}

pub fn review_header_subtitle(
    loading: bool,
    item_count: usize,
    error: Option<&ReviewLoadError>,
) -> String {
    if let Some(err) = error {
        return match err {
            ReviewLoadError::CapabilityMissing(_) => {
                "Requires `memos_review` capability".to_string()
            }
            ReviewLoadError::Other(_) => "Could not load review queue".to_string(),
        };
    }
    if loading && item_count == 0 {
        return "Loading review queue…".to_string();
    }
    if item_count == 1 {
        "1 memory waiting for approval".to_string()
    } else {
        format!("{item_count} memories waiting for approval")
    }
}

pub struct ReviewView {
    items: Vec<ReviewQueueItem>,
    selected_id: Option<String>,
    /// First Reject click arms this id; the second confirms.
    pending_reject: Option<String>,
    loading: bool,
    busy_id: Option<String>,
    error: Option<ReviewLoadError>,
    write_mode: bool,
    overlay_right_inset: gpui::Pixels,
    scroll_handle: ScrollHandle,
    theme: ThemePalette,
}

impl EventEmitter<ReviewEvent> for ReviewView {}

impl ReviewView {
    pub fn new(theme: ThemePalette, write_mode: bool) -> Self {
        Self {
            items: Vec::new(),
            selected_id: None,
            pending_reject: None,
            loading: false,
            busy_id: None,
            error: None,
            write_mode,
            overlay_right_inset: px(0.),
            scroll_handle: ScrollHandle::new(),
            theme,
        }
    }

    pub fn set_theme(&mut self, theme: ThemePalette, cx: &mut Context<Self>) {
        self.theme = theme;
        cx.notify();
    }

    pub fn set_write_mode(&mut self, write_mode: bool, cx: &mut Context<Self>) {
        if self.write_mode != write_mode {
            self.write_mode = write_mode;
            if !write_mode {
                self.pending_reject = None;
            }
            cx.notify();
        }
    }

    pub fn set_overlay_right_inset(&mut self, inset: gpui::Pixels, cx: &mut Context<Self>) {
        if self.overlay_right_inset != inset {
            self.overlay_right_inset = inset;
            cx.notify();
        }
    }

    pub fn set_loading(&mut self, loading: bool, cx: &mut Context<Self>) {
        self.loading = loading;
        if loading {
            self.error = None;
        }
        cx.notify();
    }

    pub fn set_busy_id(&mut self, id: Option<String>, cx: &mut Context<Self>) {
        self.busy_id = id;
        cx.notify();
    }

    pub fn set_items(&mut self, items: Vec<ReviewQueueItem>, cx: &mut Context<Self>) {
        self.items = items;
        self.pending_reject = None;
        self.loading = false;
        self.busy_id = None;
        self.error = None;
        if self
            .selected_id
            .as_ref()
            .is_some_and(|sel| !self.items.iter().any(|it| &it.id == sel))
        {
            self.selected_id = None;
        }
        cx.notify();
    }

    pub fn set_error(&mut self, error: Option<String>, cx: &mut Context<Self>) {
        self.set_load_error(error.map(ReviewLoadError::Other), cx);
    }

    pub fn set_load_error(&mut self, error: Option<ReviewLoadError>, cx: &mut Context<Self>) {
        self.error = error;
        self.loading = false;
        self.busy_id = None;
        cx.notify();
    }

    pub fn set_selected(&mut self, id: Option<String>, cx: &mut Context<Self>) {
        if self.selected_id != id {
            self.selected_id = id;
            cx.notify();
        }
    }

    pub fn select_relative(&mut self, delta: isize, cx: &mut Context<Self>) {
        let ids = review_selectable_ids(&self.items);
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
        self.selected_id = Some(ids[next_ix].clone());
        cx.notify();
    }

    pub fn open_selected(&mut self, cx: &mut Context<Self>) {
        let target = self
            .selected_id
            .clone()
            .filter(|sel| self.items.iter().any(|it| &it.id == sel))
            .or_else(|| self.items.first().map(|it| it.id.clone()));
        if let Some(id) = target {
            self.selected_id = Some(id.clone());
            cx.emit(ReviewEvent::OpenMemory(id));
            cx.notify();
        }
    }

    fn render_item_row(
        &self,
        ix: usize,
        item: &ReviewQueueItem,
        now_ms: i64,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let is_selected = self.selected_id.as_deref() == Some(item.id.as_str());
        let mutation_enabled = is_review_mutation_enabled(self.write_mode, self.busy_id.as_deref());
        let row_busy = self.busy_id.as_deref() == Some(item.id.as_str());
        let reject_armed = self.pending_reject.as_deref() == Some(item.id.as_str());
        let id_open = item.id.clone();
        let id_approve = item.id.clone();
        let id_reject = item.id.clone();

        let age = format_relative_age(item.created_at, now_ms);
        let type_color = theme.type_color(&item.node_type);
        let mut meta_parts = vec![item.node_type.clone(), item.namespace.clone(), age];
        if let Some(conf) = item.confidence {
            meta_parts.push(format!("confidence {conf:.2}"));
        }
        let meta_line = meta_parts.join(" · ");

        let gate_tip: SharedString = review_gate_notice(self.write_mode)
            .unwrap_or("Approve this memory for recall")
            .into();
        let reject_tip: SharedString = review_gate_notice(self.write_mode)
            .unwrap_or("Reject and delete this pending memory")
            .into();

        div()
            .id(("review-row", ix))
            .focusable()
            .role(Role::ListItem)
            .aria_selected(is_selected)
            .cursor_pointer()
            .w_full()
            .p(px(14.))
            .rounded(px(8.))
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
            .gap(px(8.))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.selected_id = Some(id_open.clone());
                cx.emit(ReviewEvent::OpenMemory(id_open.clone()));
                cx.notify();
            }))
            .child(
                div()
                    .w_full()
                    .flex()
                    .items_start()
                    .justify_between()
                    .gap(px(12.))
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .flex()
                            .flex_col()
                            .gap(px(4.))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(7.))
                                    .min_w(px(0.))
                                    .child(status_dot(type_color))
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w(px(0.))
                                            .text_size(px(14.))
                                            .line_height(px(20.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text_primary)
                                            .child(SharedString::from(item.preview.clone())),
                                    ),
                            )
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .line_height(px(17.))
                                    .font_features(tabular_nums())
                                    .text_color(theme.text_muted)
                                    .child(SharedString::from(meta_line)),
                            )
                            .when_some(item.reason.clone(), |col, reason| {
                                col.child(
                                    div()
                                        .text_size(px(12.))
                                        .line_height(px(17.))
                                        .text_color(theme.text_secondary)
                                        .child(SharedString::from(reason)),
                                )
                            }),
                    )
                    .child(
                        div()
                            .flex_shrink_0()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .child(
                                div()
                                    .id(("review-approve", ix))
                                    .focusable()
                                    .role(Role::Button)
                                    .aria_label("Approve")
                                    .tooltip(tooltip_view(gate_tip, theme))
                                    .h(px(28.))
                                    .px(px(10.))
                                    .rounded(px(6.))
                                    .cursor(if mutation_enabled {
                                        gpui::CursorStyle::PointingHand
                                    } else {
                                        gpui::CursorStyle::Arrow
                                    })
                                    .bg(if mutation_enabled {
                                        theme.accent
                                    } else {
                                        theme.bg_elevated
                                    })
                                    .border_1()
                                    .border_color(if mutation_enabled {
                                        theme.accent
                                    } else {
                                        theme.border_subtle
                                    })
                                    .opacity(if mutation_enabled { 1.0 } else { 0.55 })
                                    .flex()
                                    .items_center()
                                    .text_size(px(12.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(if mutation_enabled {
                                        theme.primary_btn_fg
                                    } else {
                                        theme.text_muted
                                    })
                                    .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| {
                                        cx.stop_propagation();
                                    })
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        cx.stop_propagation();
                                        if is_review_mutation_enabled(
                                            this.write_mode,
                                            this.busy_id.as_deref(),
                                        ) {
                                            this.pending_reject = None;
                                            cx.emit(ReviewEvent::Approve(id_approve.clone()));
                                        }
                                    }))
                                    .child(if row_busy { "Working…" } else { "Approve" }),
                            )
                            .when(reject_armed, |row| {
                                row.child(
                                    div()
                                        .id(("review-reject-cancel", ix))
                                        .focusable()
                                        .role(Role::Button)
                                        .aria_label("Cancel reject")
                                        .h(px(28.))
                                        .px(px(8.))
                                        .rounded(px(6.))
                                        .cursor_pointer()
                                        .hover(move |s| s.bg(theme.bg_hover))
                                        .flex()
                                        .items_center()
                                        .text_size(px(12.))
                                        .text_color(theme.text_muted)
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            cx.stop_propagation();
                                            this.pending_reject = None;
                                            cx.notify();
                                        }))
                                        .child("Cancel"),
                                )
                            })
                            .child(
                                div()
                                    .id(("review-reject", ix))
                                    .focusable()
                                    .role(Role::Button)
                                    .aria_label("Reject")
                                    .tooltip(tooltip_view(reject_tip, theme))
                                    .h(px(28.))
                                    .px(px(10.))
                                    .rounded(px(6.))
                                    .cursor(if mutation_enabled {
                                        gpui::CursorStyle::PointingHand
                                    } else {
                                        gpui::CursorStyle::Arrow
                                    })
                                    .bg(if reject_armed {
                                        theme.danger
                                    } else {
                                        theme.bg_elevated
                                    })
                                    .border_1()
                                    .border_color(if mutation_enabled || reject_armed {
                                        theme.danger
                                    } else {
                                        theme.border_subtle
                                    })
                                    .opacity(if mutation_enabled { 1.0 } else { 0.55 })
                                    .flex()
                                    .items_center()
                                    .text_size(px(12.))
                                    .text_color(if reject_armed {
                                        theme.primary_btn_fg
                                    } else if mutation_enabled {
                                        theme.danger
                                    } else {
                                        theme.text_muted
                                    })
                                    .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| {
                                        cx.stop_propagation();
                                    })
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        cx.stop_propagation();
                                        if is_review_mutation_enabled(
                                            this.write_mode,
                                            this.busy_id.as_deref(),
                                        ) {
                                            if this.pending_reject.as_deref()
                                                == Some(id_reject.as_str())
                                            {
                                                this.pending_reject = None;
                                                cx.emit(ReviewEvent::Reject(id_reject.clone()));
                                            } else {
                                                this.pending_reject = Some(id_reject.clone());
                                                cx.notify();
                                            }
                                        }
                                    }))
                                    .child(if row_busy {
                                        "Working…"
                                    } else if reject_armed {
                                        "Confirm reject"
                                    } else {
                                        "Reject"
                                    }),
                            ),
                    ),
            )
            .into_any_element()
    }
}

impl Render for ReviewView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let scroll_handle = self.scroll_handle.clone();
        let pending_label =
            review_header_subtitle(self.loading, self.items.len(), self.error.as_ref());

        let header = div()
            .id("review-page-header")
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
                    .w_full()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .child(
                        div()
                            .text_size(px(20.))
                            .line_height(px(26.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.text_primary)
                            .child("Review queue"),
                    )
                    .child(
                        div()
                            .id("review-refresh-btn")
                            .focusable()
                            .role(Role::Button)
                            .cursor_pointer()
                            .h(px(28.))
                            .px(px(10.))
                            .rounded(px(6.))
                            .bg(theme.bg_elevated)
                            .border_1()
                            .border_color(theme.border_subtle)
                            .hover(move |s| s.bg(theme.bg_hover))
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .text_size(px(12.))
                            .text_color(theme.text_primary)
                            .on_click(cx.listener(|_, _, _, cx| {
                                cx.emit(ReviewEvent::Refresh);
                            }))
                            .child(render_ui_icon(UiIcon::Refresh, 13.0, theme.text_secondary))
                            .child("Refresh"),
                    ),
            )
            .child(
                div()
                    .text_size(px(13.))
                    .line_height(px(18.))
                    .font_features(tabular_nums())
                    .text_color(theme.text_muted)
                    .child(SharedString::from(pending_label)),
            );

        let body: AnyElement = if let Some(err) = &self.error {
            let cap_missing = err.is_capability_missing();
            let accent_border = if cap_missing {
                theme.warning
            } else {
                theme.danger
            };
            div()
                .flex_1()
                .px(px(24.))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .id("review-error-card")
                        .w_full()
                        .max_w(px(480.))
                        .p(px(20.))
                        .rounded(px(8.))
                        .bg(theme.bg_panel)
                        .border_1()
                        .border_color(accent_border)
                        .flex()
                        .flex_col()
                        .gap(px(12.))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .child(render_ui_icon(UiIcon::Warning, 16.0, accent_border))
                                .child(
                                    div()
                                        .text_size(px(15.))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(theme.text_primary)
                                        .child(err.title()),
                                ),
                        )
                        .child(
                            div()
                                .text_size(px(13.))
                                .line_height(px(19.))
                                .text_color(theme.text_secondary)
                                .child(SharedString::from(err.message().to_string())),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .child(
                                    div()
                                        .id("review-error-settings-btn")
                                        .focusable()
                                        .role(Role::Button)
                                        .aria_label("Open Settings")
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
                                        .on_click(cx.listener(|_, _, _, cx| {
                                            cx.emit(ReviewEvent::OpenSettings);
                                        }))
                                        .child("Settings"),
                                )
                                .child(
                                    div()
                                        .id("review-retry-btn")
                                        .focusable()
                                        .role(Role::Button)
                                        .aria_label("Retry loading review queue")
                                        .cursor_pointer()
                                        .h(px(32.))
                                        .px(px(14.))
                                        .rounded(px(6.))
                                        .bg(theme.bg_elevated)
                                        .border_1()
                                        .border_color(theme.border_subtle)
                                        .hover(move |s| s.bg(theme.bg_hover))
                                        .flex()
                                        .items_center()
                                        .text_size(px(13.))
                                        .text_color(theme.text_primary)
                                        .on_click(cx.listener(|_, _, _, cx| {
                                            cx.emit(ReviewEvent::Refresh);
                                        }))
                                        .child("Retry"),
                                ),
                        ),
                )
                .into_any_element()
        } else if self.loading && self.items.is_empty() {
            div()
                .flex_1()
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .text_size(px(14.))
                        .text_color(theme.text_muted)
                        .child("Loading review queue…"),
                )
                .into_any_element()
        } else if self.items.is_empty() {
            div()
                .id("review-empty-state")
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
                        .gap(px(10.))
                        .child(
                            div()
                                .text_size(px(18.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(theme.text_primary)
                                .child(if self.write_mode {
                                    "No memories waiting for review"
                                } else {
                                    "Nothing waiting for review"
                                }),
                        )
                        .child(
                            div()
                                .text_size(px(13.))
                                .text_color(theme.text_muted)
                                .text_center()
                                .child(if self.write_mode {
                                    "Agent-queued memories stored with review pending appear here for approval."
                                } else {
                                    "When an agent queues a memory for approval it appears here. Turn on editing to approve or reject."
                                }),
                        ),
                )
                .into_any_element()
        } else {
            let rows: Vec<AnyElement> = self
                .items
                .iter()
                .enumerate()
                .map(|(ix, item)| self.render_item_row(ix, item, now_ms, cx))
                .collect();

            div()
                .relative()
                .flex_1()
                .min_h(px(0.))
                .w_full()
                .child(
                    div()
                        .id("review-scroll")
                        .size_full()
                        .overflow_y_scroll()
                        .track_scroll(&self.scroll_handle)
                        .pl(px(20.))
                        .pr(px(20.) + self.overlay_right_inset)
                        .py(px(16.))
                        .flex()
                        .flex_col()
                        .gap(px(10.))
                        .children(rows),
                )
                .child(render_vertical_scroll_overlay(
                    scroll_handle,
                    theme.bg_app,
                    theme,
                ))
                .into_any_element()
        };

        div()
            .id("review-view-root")
            .flex_1()
            .h_full()
            .min_w(px(0.))
            .overflow_hidden()
            .bg(theme.bg_app)
            .flex()
            .flex_col()
            .child(header)
            .when_some(review_gate_notice(self.write_mode), |col, notice| {
                col.child(
                    div()
                        .id("review-read-only-banner")
                        .w_full()
                        .pl(px(20.))
                        .pr(px(20.) + self.overlay_right_inset)
                        .py(px(8.))
                        .bg(theme.bg_sunken)
                        .border_b_1()
                        .border_color(theme.border_subtle)
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(10.))
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(theme.text_secondary)
                                .child(notice),
                        )
                        .child(
                            div()
                                .id("review-open-settings-btn")
                                .focusable()
                                .role(Role::Button)
                                .cursor_pointer()
                                .px(px(8.))
                                .py(px(3.))
                                .rounded(px(5.))
                                .bg(theme.bg_elevated)
                                .border_1()
                                .border_color(theme.border_subtle)
                                .hover(move |s| s.bg(theme.bg_hover))
                                .text_size(px(11.))
                                .text_color(theme.text_primary)
                                .on_click(cx.listener(|_, _, _, cx| {
                                    cx.emit(ReviewEvent::OpenSettings);
                                }))
                                .child("Settings"),
                        ),
                )
            })
            .child(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_gate_and_selection_helpers_enforce_write_mode() {
        assert!(!is_review_mutation_enabled(false, None));
        assert!(is_review_mutation_enabled(true, None));
        assert!(!is_review_mutation_enabled(true, Some("id-1")));
        assert_eq!(
            review_gate_notice(false),
            Some("Turn on editing to approve")
        );
        assert_eq!(review_gate_notice(true), None);

        let items = vec![
            ReviewQueueItem {
                id: "m1".to_string(),
                short_id: "m1".to_string(),
                preview: "First".to_string(),
                content: "First".to_string(),
                node_type: "decision".to_string(),
                namespace: "default".to_string(),
                created_at: 100,
                confidence: Some(0.8),
                reason: Some("Auto-queued".to_string()),
            },
            ReviewQueueItem {
                id: "m2".to_string(),
                short_id: "m2".to_string(),
                preview: "Second".to_string(),
                content: "Second".to_string(),
                node_type: "fact".to_string(),
                namespace: "work".to_string(),
                created_at: 200,
                confidence: None,
                reason: None,
            },
        ];
        assert_eq!(review_selectable_ids(&items), vec!["m1", "m2"]);

        let cap_err = ReviewLoadError::CapabilityMissing(
            "This writer exposes 24 tools and not `memos_review`.".to_string(),
        );
        assert!(cap_err.is_capability_missing());
        assert_eq!(cap_err.title(), "Review queue unavailable");
        assert_eq!(
            review_header_subtitle(false, 0, Some(&cap_err)),
            "Requires `memos_review` capability"
        );
        assert_eq!(
            review_header_subtitle(false, 0, None),
            "0 memories waiting for approval"
        );
    }
}
