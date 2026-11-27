use std::time::{SystemTime, UNIX_EPOCH};

use gpui::{
    AnyElement, Context, EventEmitter, FontWeight, InteractiveElement, IntoElement, ParentElement,
    Render, Role, ScrollHandle, SharedString, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder, px,
};

use crate::core::model::format_relative_age;
use crate::core::write_bridge::ReviewQueueItem;
use crate::ui::views::kit::{self, ButtonKind};
use crate::ui::views::{
    ThemePalette, UiIcon, render_ui_icon, render_vertical_scroll_overlay, tabular_nums,
    tooltip_view,
};

#[derive(Clone, Debug)]
pub enum ReviewEvent {
    Refresh,
    OpenMemory(String),
    Approve(String),
    Reject(String),
    OpenSettings,
    /// Approve or reject every id, one writer call at a time.
    Batch {
        ids: Vec<String>,
        approve: bool,
    },
    /// Stop a running batch after the current item.
    StopBatch,
    /// Open the candidate side by side with the memory it conflicts with.
    Compare(String),
}

/// Ordered multi-selection of review candidates.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReviewSelection {
    ids: Vec<String>,
}

impl ReviewSelection {
    pub fn len(&self) -> usize {
        self.ids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    pub fn contains(&self, id: &str) -> bool {
        self.ids.iter().any(|i| i == id)
    }

    pub fn toggle(&mut self, id: &str) {
        if let Some(pos) = self.ids.iter().position(|i| i == id) {
            self.ids.remove(pos);
        } else {
            self.ids.push(id.to_string());
        }
    }

    pub fn select_all(&mut self, items: &[ReviewQueueItem]) {
        self.ids = items.iter().map(|i| i.id.clone()).collect();
    }

    pub fn clear(&mut self) {
        self.ids.clear();
    }

    /// Drop ids that are no longer in the queue (after a reload).
    pub fn retain_present(&mut self, items: &[ReviewQueueItem]) {
        self.ids.retain(|id| items.iter().any(|it| &it.id == id));
    }

    /// Selected ids in queue order, so a batch runs top to bottom.
    pub fn ordered_ids(&self, items: &[ReviewQueueItem]) -> Vec<String> {
        items
            .iter()
            .filter(|it| self.contains(&it.id))
            .map(|it| it.id.clone())
            .collect()
    }
}

/// Live state of a batch run, owned by the app and mirrored here for display.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BatchProgress {
    pub approve: bool,
    /// The memories in this run, in the order they are sent.
    pub ids: Vec<String>,
    pub total: usize,
    pub done: usize,
    pub failed: Vec<(String, String)>,
    pub stopped: bool,
    pub finished: bool,
    /// Position of each id in `ids`, so a row finds its state in O(1); the
    /// Review view asks for every row after every decision.
    pub index: std::collections::HashMap<String, usize>,
    pub failed_ids: std::collections::HashSet<String>,
}

/// Where one row stands in a batch run, shown in place of its buttons.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BatchRowState {
    Waiting,
    InProgress,
    Done,
    Failed,
    NotAttempted,
}

impl BatchProgress {
    pub fn new(approve: bool, ids: Vec<String>) -> Self {
        let index = ids
            .iter()
            .enumerate()
            .map(|(pos, id)| (id.clone(), pos))
            .collect();
        Self {
            approve,
            total: ids.len(),
            ids,
            index,
            ..Default::default()
        }
    }

    pub fn record_failure(&mut self, id: String, message: String) {
        self.failed_ids.insert(id.clone());
        self.failed.push((id, message));
    }

    /// `None` when the memory is not part of this run.
    pub fn row_state(&self, id: &str) -> Option<BatchRowState> {
        let pos = *self.index.get(id)?;
        Some(if self.failed_ids.contains(id) {
            BatchRowState::Failed
        } else if pos < self.done {
            BatchRowState::Done
        } else if self.finished {
            BatchRowState::NotAttempted
        } else if pos == self.done {
            BatchRowState::InProgress
        } else {
            BatchRowState::Waiting
        })
    }

    pub fn row_state_label(&self, state: BatchRowState) -> &'static str {
        match (state, self.approve) {
            (BatchRowState::Waiting, _) => "Waiting",
            (BatchRowState::InProgress, true) => "Approving…",
            (BatchRowState::InProgress, false) => "Rejecting…",
            (BatchRowState::Done, true) => "Approved",
            (BatchRowState::Done, false) => "Rejected",
            (BatchRowState::Failed, _) => "Failed",
            (BatchRowState::NotAttempted, _) => "Not attempted",
        }
    }

    pub fn succeeded(&self) -> usize {
        self.done.saturating_sub(self.failed.len())
    }

    /// One honest sentence: what happened, what did not, nothing implied atomic.
    pub fn summary(&self) -> String {
        let verb = if self.approve { "Approved" } else { "Rejected" };
        let gerund = if self.approve {
            "Approving"
        } else {
            "Rejecting"
        };
        if !self.finished {
            return format!(
                "{gerund} {} of {}…",
                (self.done + 1).min(self.total),
                self.total
            );
        }
        let mut s = format!("{verb} {} of {}", self.succeeded(), self.total);
        if !self.failed.is_empty() {
            s.push_str(&format!(". {} failed", self.failed.len()));
        }
        let skipped = self.total.saturating_sub(self.done);
        if self.stopped && skipped > 0 {
            s.push_str(&format!(". Stopped; {skipped} not attempted"));
        }
        s.push('.');
        s
    }
}

/// Why a candidate is waiting, in plain words.
pub fn pending_reason_text(item: &ReviewQueueItem) -> String {
    match item
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty())
    {
        None => "Queued by an agent for approval".to_string(),
        Some(r) if r.eq_ignore_ascii_case("review:pending") => {
            "Queued by an agent for approval".to_string()
        }
        Some(r) => r.strip_prefix("review:").unwrap_or(r).trim().to_string(),
    }
}

/// Confidence below this is called out next to the candidate.
pub const LOW_CONFIDENCE: f32 = 0.5;

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
    checked: ReviewSelection,
    /// Batch action waiting for its confirming click.
    armed_batch: Option<bool>,
    batch: Option<BatchProgress>,
    hovered_ix: Option<usize>,
    /// Memories with a recorded conflict; their rows offer Compare.
    conflict_ids: std::sync::Arc<std::collections::HashSet<String>>,
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
            checked: ReviewSelection::default(),
            armed_batch: None,
            batch: None,
            hovered_ix: None,
            conflict_ids: Default::default(),
            theme,
        }
    }

    pub fn set_theme(&mut self, theme: ThemePalette, cx: &mut Context<Self>) {
        self.theme = theme;
        cx.notify();
    }

    pub fn set_conflict_ids(
        &mut self,
        ids: std::sync::Arc<std::collections::HashSet<String>>,
        cx: &mut Context<Self>,
    ) {
        if self.conflict_ids != ids {
            self.conflict_ids = ids;
            cx.notify();
        }
    }

    pub fn set_write_mode(&mut self, write_mode: bool, cx: &mut Context<Self>) {
        if self.write_mode != write_mode {
            self.write_mode = write_mode;
            if !write_mode {
                self.pending_reject = None;
                self.checked.clear();
                self.armed_batch = None;
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
        if id.is_some() {
            self.clear_finished_batch();
        }
        self.busy_id = id;
        cx.notify();
    }

    /// A finished run's summary describes the last batch only; once the user
    /// starts something new it would sit above the wrong state, so drop it.
    fn clear_finished_batch(&mut self) {
        if self.batch.as_ref().is_some_and(|b| b.finished) {
            self.batch = None;
        }
    }

    pub fn set_batch_progress(&mut self, progress: Option<BatchProgress>, cx: &mut Context<Self>) {
        self.batch = progress;
        cx.notify();
    }

    pub fn is_batch_running(&self) -> bool {
        self.batch.as_ref().is_some_and(|b| !b.finished)
    }

    pub fn set_items(&mut self, items: Vec<ReviewQueueItem>, cx: &mut Context<Self>) {
        self.items = items;
        self.pending_reject = None;
        self.loading = false;
        self.busy_id = None;
        self.error = None;
        self.checked.retain_present(&self.items);
        if self.checked.is_empty() {
            self.armed_batch = None;
        }
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

    /// Space on the focused candidate toggles it into the batch selection.
    pub fn toggle_checked_selected(&mut self, cx: &mut Context<Self>) {
        if !self.write_mode || self.is_batch_running() {
            return;
        }
        let target = self
            .selected_id
            .clone()
            .or_else(|| self.items.first().map(|i| i.id.clone()));
        if let Some(id) = target {
            self.clear_finished_batch();
            self.selected_id = Some(id.clone());
            self.checked.toggle(&id);
            self.armed_batch = None;
            cx.notify();
        }
    }

    /// Esc clears a batch selection before anything else closes.
    pub fn clear_checked(&mut self, cx: &mut Context<Self>) -> bool {
        if self.checked.is_empty() && self.armed_batch.is_none() {
            return false;
        }
        self.checked.clear();
        self.armed_batch = None;
        cx.notify();
        true
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
        let is_checked = self.checked.contains(&item.id);
        let batch_running = self.is_batch_running();
        let mutation_enabled =
            is_review_mutation_enabled(self.write_mode, self.busy_id.as_deref()) && !batch_running;
        let row_busy = self.busy_id.as_deref() == Some(item.id.as_str());
        // While a batch runs, each row in it says where it stands instead of
        // showing buttons that cannot be used.
        let batch_state = self
            .batch
            .as_ref()
            .filter(|b| !b.finished)
            .and_then(|b| b.row_state(&item.id).map(|s| (s, b.row_state_label(s))));
        let reject_armed = self.pending_reject.as_deref() == Some(item.id.as_str());
        let id_open = item.id.clone();
        let id_check = item.id.clone();
        let id_approve = item.id.clone();
        let id_reject = item.id.clone();
        let id_compare = item.id.clone();
        let in_conflict = self.conflict_ids.contains(&item.id);

        let age = format_relative_age(item.created_at, now_ms);
        let mut meta_parts = vec![item.node_type.clone()];
        let ns = item.namespace.trim();
        if !ns.is_empty() && ns != "default" {
            meta_parts.push(ns.to_string());
        }
        meta_parts.push(format!("{age} ago"));
        if let Some(conf) = item.confidence {
            meta_parts.push(format!(
                "confidence {:.0}%",
                (conf.clamp(0.0, 1.0) * 100.0).round()
            ));
        }
        let meta_line: SharedString = meta_parts.join(" · ").into();
        let low_confidence = item.confidence.is_some_and(|c| c < LOW_CONFIDENCE);
        let reason: SharedString = pending_reason_text(item).into();
        let title: SharedString = item.preview.clone().into();
        // Row actions appear on the row being worked on, not on every row.
        let show_actions =
            is_selected || is_checked || reject_armed || row_busy || self.hovered_ix == Some(ix);
        let aria: SharedString = format!("{title}. {reason}. {meta_line}").into();

        div()
            .id(("review-row", ix))
            .focusable()
            .role(Role::ListItem)
            .aria_label(aria)
            .aria_selected(is_selected)
            .cursor_pointer()
            .w_full()
            .min_w(px(0.))
            .pl(px(12.))
            .pr(px(4.))
            .py(px(12.))
            .border_b_1()
            .border_color(theme.border_subtle)
            .bg(if is_selected {
                theme.bg_selected
            } else {
                gpui::transparent_black()
            })
            .hover(move |s| {
                s.bg(if is_selected {
                    theme.bg_selected
                } else {
                    theme.bg_hover
                })
            })
            .focus_visible(move |s| s.border_1().border_color(theme.accent))
            .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                let next = if *hovered {
                    Some(ix)
                } else if this.hovered_ix == Some(ix) {
                    None
                } else {
                    this.hovered_ix
                };
                if next != this.hovered_ix {
                    this.hovered_ix = next;
                    cx.notify();
                }
            }))
            .flex()
            .items_start()
            .gap(px(10.))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.selected_id = Some(id_open.clone());
                cx.emit(ReviewEvent::OpenMemory(id_open.clone()));
                cx.notify();
            }))
            .when(self.write_mode, |row| {
                row.child(
                    div()
                        .id(("review-check", ix))
                        .focusable()
                        .role(Role::CheckBox)
                        .aria_label(if is_checked {
                            "Remove from batch"
                        } else {
                            "Add to batch"
                        })
                        .aria_toggled(is_checked.into())
                        .mt(px(2.))
                        .w(px(16.))
                        .h(px(16.))
                        .flex_shrink_0()
                        .rounded(px(4.))
                        .border_1()
                        .border_color(if is_checked {
                            theme.accent
                        } else {
                            theme.border_strong
                        })
                        .bg(if is_checked {
                            theme.accent
                        } else {
                            gpui::transparent_black()
                        })
                        .flex()
                        .items_center()
                        .justify_center()
                        .focus_visible(move |s| s.border_color(theme.text_primary))
                        .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| {
                            cx.stop_propagation();
                        })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.stop_propagation();
                            if !this.is_batch_running() {
                                this.clear_finished_batch();
                                this.checked.toggle(&id_check);
                                this.armed_batch = None;
                                cx.notify();
                            }
                        }))
                        .when(is_checked, |el| {
                            el.child(render_ui_icon(UiIcon::Check, 11.0, theme.primary_btn_fg))
                        }),
                )
            })
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.))
                    .flex()
                    .flex_col()
                    .gap(px(3.))
                    .child(
                        div()
                            .w_full()
                            .min_w(px(0.))
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .text_size(px(14.))
                            .line_height(px(20.))
                            .text_color(theme.text_primary)
                            .child(title),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .min_w(px(0.))
                            .child(
                                div()
                                    .w(px(6.))
                                    .h(px(6.))
                                    .rounded_full()
                                    .flex_shrink_0()
                                    .bg(theme.type_color(&item.node_type)),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .min_w(px(0.))
                                    .text_size(px(12.))
                                    .line_height(px(16.))
                                    .font_features(tabular_nums())
                                    .text_color(theme.text_muted)
                                    .truncate()
                                    .child(meta_line),
                            )
                            .when(in_conflict, |row| {
                                row.child(kit::state_marker("Conflict", theme.danger))
                            })
                            .when(low_confidence, |row| {
                                row.child(kit::state_marker("Low confidence", theme.text_secondary))
                            }),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .line_height(px(16.))
                            .text_color(theme.text_secondary)
                            .truncate()
                            .child(reason),
                    ),
            )
            .when_some(batch_state, |row, (state, label)| {
                let color = match state {
                    BatchRowState::Failed => theme.danger,
                    BatchRowState::Done => theme.success,
                    BatchRowState::InProgress => theme.text_primary,
                    _ => theme.text_muted,
                };
                row.child(
                    div()
                        .flex_shrink_0()
                        .text_size(px(12.))
                        .child(kit::state_marker(label, color)),
                )
            })
            // Comparing only reads, so it is offered in view-only mode too.
            .when(
                in_conflict && show_actions && batch_state.is_none(),
                |row| {
                    row.child(
                        kit::button(
                            ("review-compare", ix),
                            "Compare",
                            ButtonKind::Subtle,
                            &theme,
                        )
                        .tooltip(tooltip_view(
                            "Side by side with the memory it conflicts with",
                            theme,
                        ))
                        .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| {
                            cx.stop_propagation();
                        })
                        .on_click(cx.listener(move |_, _, _, cx| {
                            cx.stop_propagation();
                            cx.emit(ReviewEvent::Compare(id_compare.clone()));
                        })),
                    )
                },
            )
            .when(
                self.write_mode && show_actions && batch_state.is_none(),
                |row| {
                    row.child(
                        div()
                            .flex_shrink_0()
                            .flex()
                            .items_center()
                            .gap(px(4.))
                            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| {
                                cx.stop_propagation();
                            })
                            .when(reject_armed, |r| {
                                r.child(
                                    kit::button(
                                        ("review-reject-cancel", ix),
                                        "Keep",
                                        ButtonKind::Subtle,
                                        &theme,
                                    )
                                    .on_click(cx.listener(
                                        |this, _, _, cx| {
                                            cx.stop_propagation();
                                            this.pending_reject = None;
                                            cx.notify();
                                        },
                                    )),
                                )
                            })
                            .child(if mutation_enabled {
                                kit::button(
                                    ("review-reject", ix),
                                    if reject_armed {
                                        "Confirm reject"
                                    } else {
                                        "Reject"
                                    },
                                    ButtonKind::Danger,
                                    &theme,
                                )
                                .on_click(cx.listener(
                                    move |this, _, _, cx| {
                                        cx.stop_propagation();
                                        if this.pending_reject.as_deref()
                                            == Some(id_reject.as_str())
                                        {
                                            this.pending_reject = None;
                                            cx.emit(ReviewEvent::Reject(id_reject.clone()));
                                        } else {
                                            this.pending_reject = Some(id_reject.clone());
                                            cx.notify();
                                        }
                                    },
                                ))
                            } else {
                                kit::button_disabled(
                                    ("review-reject", ix),
                                    if row_busy { "Working…" } else { "Reject" },
                                    "another review action is running",
                                    &theme,
                                )
                            })
                            .child(if mutation_enabled {
                                kit::button(
                                    ("review-approve", ix),
                                    "Approve",
                                    ButtonKind::Secondary,
                                    &theme,
                                )
                                .tooltip(tooltip_view("Approve so agents can recall it", theme))
                                .on_click(cx.listener(
                                    move |this, _, _, cx| {
                                        cx.stop_propagation();
                                        this.pending_reject = None;
                                        cx.emit(ReviewEvent::Approve(id_approve.clone()));
                                    },
                                ))
                            } else {
                                // The busy row already says "Working…" once.
                                kit::button_disabled(
                                    ("review-approve", ix),
                                    "Approve",
                                    "another review action is running",
                                    &theme,
                                )
                                .when(row_busy, |b| b.invisible())
                            }),
                    )
                },
            )
            .into_any_element()
    }

    fn render_batch_bar(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = self.theme;
        if let Some(batch) = &self.batch {
            let running = !batch.finished;
            let pct = if batch.total == 0 {
                0.0
            } else {
                batch.done as f32 / batch.total as f32
            };
            let failures: Vec<AnyElement> = batch
                .failed
                .iter()
                .take(3)
                .map(|(id, msg)| {
                    let short: String = self
                        .items
                        .iter()
                        .find(|it| &it.id == id)
                        .map(|it| crate::core::model::make_single_line_preview(&it.preview, 48))
                        .unwrap_or_else(|| id.chars().take(8).collect());
                    div()
                        .text_size(px(12.))
                        .text_color(theme.text_muted)
                        .truncate()
                        .child(SharedString::from(format!("{short}: {msg}")))
                        .into_any_element()
                })
                .collect();
            return Some(
                div()
                    .id("review-batch-progress")
                    .role(Role::Status)
                    .w_full()
                    .px(px(20.))
                    .pr(px(20.) + self.overlay_right_inset)
                    .py(px(10.))
                    .border_b_1()
                    .border_color(theme.border_subtle)
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(12.))
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .font_features(tabular_nums())
                                    .text_color(theme.text_primary)
                                    .child(SharedString::from(batch.summary())),
                            )
                            .child(if running {
                                kit::button("review-batch-stop", "Stop after this one", ButtonKind::Subtle, &theme)
                                    .on_click(cx.listener(|_, _, _, cx| cx.emit(ReviewEvent::StopBatch)))
                                    .into_any_element()
                            } else {
                                kit::button("review-batch-dismiss", "Done", ButtonKind::Subtle, &theme)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.batch = None;
                                        cx.notify();
                                    }))
                                    .into_any_element()
                            }),
                    )
                    .when(running, |col| {
                        col.child(
                            div()
                                .w_full()
                                .h(px(3.))
                                .rounded(px(2.))
                                .bg(theme.bg_elevated)
                                .child(
                                    div()
                                        .h_full()
                                        .rounded(px(2.))
                                        .w(gpui::relative(pct.clamp(0.0, 1.0)))
                                        .bg(theme.text_secondary),
                                ),
                        )
                    })
                    .children(failures)
                    .when(!running && !batch.failed.is_empty(), |col| {
                        col.child(
                            div()
                                .text_size(px(12.))
                                .text_color(theme.text_muted)
                                .child("Each memory is reviewed separately, so the ones that succeeded stay done. Failed ones are still in the queue."),
                        )
                    })
                    .into_any_element(),
            );
        }
        if !self.write_mode || self.items.is_empty() {
            return None;
        }
        let n = self.checked.len();
        let noun = if n == 1 { "memory" } else { "memories" };
        let bar = div()
            .id("review-batch-bar")
            .w_full()
            .px(px(20.))
            .pr(px(20.) + self.overlay_right_inset)
            .h(px(44.))
            .border_b_1()
            .border_color(theme.border_subtle)
            .flex()
            .items_center()
            .justify_between()
            .gap(px(12.));
        let bar = match (n, self.armed_batch) {
            (0, _) => bar
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(theme.text_muted)
                        .child("Tick candidates or press Space to review several at once"),
                )
                .child(
                    kit::button(
                        "review-select-all",
                        "Select all",
                        ButtonKind::Subtle,
                        &theme,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.clear_finished_batch();
                        this.checked.select_all(&this.items);
                        cx.notify();
                    })),
                ),
            (_, Some(approve)) => {
                let question: SharedString = if approve {
                    format!("Approve {n} {noun}? Agents will be able to recall them.").into()
                } else {
                    format!("Reject {n} {noun}? They are removed from the store.").into()
                };
                let ids = self.checked.ordered_ids(&self.items);
                bar.child(
                    div()
                        .flex_1()
                        .min_w(px(0.))
                        .text_size(px(13.))
                        .text_color(theme.text_primary)
                        .truncate()
                        .child(question),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .child(
                            kit::button(
                                "review-batch-cancel",
                                "Cancel",
                                ButtonKind::Secondary,
                                &theme,
                            )
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.armed_batch = None;
                                cx.notify();
                            })),
                        )
                        .child(
                            kit::button(
                                "review-batch-confirm",
                                if approve {
                                    format!("Approve {n}")
                                } else {
                                    format!("Reject {n}")
                                },
                                if approve {
                                    ButtonKind::Primary
                                } else {
                                    ButtonKind::Danger
                                },
                                &theme,
                            )
                            .on_click(cx.listener(
                                move |this, _, _, cx| {
                                    this.armed_batch = None;
                                    this.checked.clear();
                                    cx.emit(ReviewEvent::Batch {
                                        ids: ids.clone(),
                                        approve,
                                    });
                                    cx.notify();
                                },
                            )),
                        ),
                )
            }
            (_, None) => bar
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .text_size(px(13.))
                        .font_features(tabular_nums())
                        .text_color(theme.text_primary)
                        .child(SharedString::from(format!("{n} selected")))
                        .child(
                            kit::button("review-batch-clear", "Clear", ButtonKind::Subtle, &theme)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.checked.clear();
                                    cx.notify();
                                })),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .child(
                            kit::button(
                                "review-batch-reject",
                                format!("Reject {n}…"),
                                ButtonKind::Danger,
                                &theme,
                            )
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.armed_batch = Some(false);
                                cx.notify();
                            })),
                        )
                        .child(
                            kit::button(
                                "review-batch-approve",
                                format!("Approve {n}…"),
                                ButtonKind::Secondary,
                                &theme,
                            )
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.armed_batch = Some(true);
                                cx.notify();
                            })),
                        ),
                ),
        };
        Some(bar.into_any_element())
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
            .pt(px(18.))
            .pb(px(12.))
            .pl(px(20.))
            .pr(px(20.) + self.overlay_right_inset)
            .border_b_1()
            .border_color(theme.border_subtle)
            .flex()
            .items_center()
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
                            .text_size(px(20.))
                            .line_height(px(26.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.text_primary)
                            .child("Review queue"),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .line_height(px(16.))
                            .font_features(tabular_nums())
                            .text_color(theme.text_muted)
                            .child(SharedString::from(pending_label)),
                    ),
            )
            .child(
                kit::button(
                    "review-refresh-btn",
                    "Refresh",
                    ButtonKind::Secondary,
                    &theme,
                )
                .on_click(cx.listener(|_, _, _, cx| {
                    cx.emit(ReviewEvent::Refresh);
                })),
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
                        .id("review-error-card")
                        .w_full()
                        .max_w(px(460.))
                        .flex()
                        .flex_col()
                        .gap(px(12.))
                        .child(
                            div()
                                .text_size(px(15.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(theme.text_primary)
                                .child(err.title()),
                        )
                        .child(kit::notice(
                            if err.is_capability_missing() {
                                kit::NoticeKind::Warning
                            } else {
                                kit::NoticeKind::Danger
                            },
                            err.message().to_string(),
                            &theme,
                        ))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .child(
                                    kit::button(
                                        "review-error-settings-btn",
                                        "Open Settings",
                                        ButtonKind::Secondary,
                                        &theme,
                                    )
                                    .on_click(cx.listener(
                                        |_, _, _, cx| {
                                            cx.emit(ReviewEvent::OpenSettings);
                                        },
                                    )),
                                )
                                .child(
                                    kit::button(
                                        "review-retry-btn",
                                        "Retry",
                                        ButtonKind::Subtle,
                                        &theme,
                                    )
                                    .on_click(cx.listener(
                                        |_, _, _, cx| {
                                            cx.emit(ReviewEvent::Refresh);
                                        },
                                    )),
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
                .text_size(px(13.))
                .text_color(theme.text_muted)
                .child("Loading the review queue…")
                .into_any_element()
        } else if self.items.is_empty() {
            div()
                .id("review-empty-state")
                .flex_1()
                .px(px(24.))
                .flex()
                .items_center()
                .justify_center()
                .child(kit::empty_state(
                    "Nothing waiting for review",
                    if self.write_mode {
                        "When an agent stores a memory that needs approval, it waits here until you approve or reject it."
                    } else {
                        "When an agent stores a memory that needs approval, it waits here. Turn on editing in Settings to approve or reject."
                    },
                    &theme,
                ))
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
                        .pl(px(8.))
                        .pr(px(16.) + self.overlay_right_inset)
                        .flex()
                        .flex_col()
                        .children(rows),
                )
                .child(render_vertical_scroll_overlay(
                    scroll_handle,
                    theme.bg_app,
                    theme,
                ))
                .into_any_element()
        };

        let batch_bar = self.render_batch_bar(cx);
        let gate = review_gate_notice(self.write_mode).filter(|_| !self.items.is_empty());

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
            .when_some(gate, |col, _| {
                col.child(
                    div()
                        .w_full()
                        .px(px(20.))
                        .pr(px(20.) + self.overlay_right_inset)
                        .h(px(44.))
                        .border_b_1()
                        .border_color(theme.border_subtle)
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(12.))
                        .child(
                            div()
                                .flex_1()
                                .min_w(px(0.))
                                .text_size(px(12.))
                                .text_color(theme.text_muted)
                                .truncate()
                                .child("View only. Turn on editing to approve or reject, one at a time or in batches."),
                        )
                        .child(
                            kit::button("review-gate-settings", "Settings", ButtonKind::Subtle, &theme)
                                .on_click(cx.listener(|_, _, _, cx| {
                                    cx.emit(ReviewEvent::OpenSettings);
                                })),
                        ),
                )
            })
            .when_some(batch_bar, |col, bar| col.child(bar))
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

    #[test]
    fn batch_selection_keeps_queue_order_and_prunes_after_reload() {
        let mk = |id: &str| ReviewQueueItem {
            id: id.to_string(),
            short_id: id.to_string(),
            preview: id.to_string(),
            content: id.to_string(),
            node_type: "fact".to_string(),
            namespace: "default".to_string(),
            created_at: 0,
            confidence: None,
            reason: None,
        };
        let items = vec![mk("a"), mk("b"), mk("c")];
        let mut sel = ReviewSelection::default();
        sel.toggle("c");
        sel.toggle("a");
        assert_eq!(sel.ordered_ids(&items), vec!["a", "c"]);
        sel.toggle("c");
        assert_eq!(sel.len(), 1);
        sel.select_all(&items);
        assert_eq!(sel.len(), 3);
        sel.retain_present(&[mk("b")]);
        assert_eq!(sel.ordered_ids(&items), vec!["b"]);
        sel.clear();
        assert!(sel.is_empty());
    }

    #[test]
    fn batch_rows_report_their_own_state() {
        let mut p = BatchProgress::new(true, vec!["a".into(), "b".into(), "c".into()]);
        assert_eq!(p.row_state("a"), Some(BatchRowState::InProgress));
        assert_eq!(p.row_state("b"), Some(BatchRowState::Waiting));
        assert_eq!(p.row_state("zzz"), None);
        p.done = 2;
        p.record_failure("b".into(), "timeout".into());
        assert_eq!(p.row_state("a"), Some(BatchRowState::Done));
        assert_eq!(p.row_state("b"), Some(BatchRowState::Failed));
        assert_eq!(p.row_state("c"), Some(BatchRowState::InProgress));
        assert_eq!(p.row_state_label(BatchRowState::InProgress), "Approving…");
        p.finished = true;
        p.stopped = true;
        assert_eq!(p.row_state("c"), Some(BatchRowState::NotAttempted));
    }

    #[test]
    fn batch_summary_reports_partial_results_honestly() {
        let mut p = BatchProgress {
            approve: true,
            total: 5,
            ..Default::default()
        };
        assert_eq!(p.summary(), "Approving 1 of 5…");
        p.done = 3;
        p.failed.push(("x".into(), "timeout".into()));
        p.stopped = true;
        p.finished = true;
        assert_eq!(
            p.summary(),
            "Approved 2 of 5. 1 failed. Stopped; 2 not attempted."
        );
        let r = BatchProgress {
            approve: false,
            total: 2,
            done: 2,
            finished: true,
            ..Default::default()
        };
        assert_eq!(r.summary(), "Rejected 2 of 2.");
    }

    #[test]
    fn pending_reasons_read_as_sentences() {
        let mut item = ReviewQueueItem {
            id: "a".into(),
            short_id: "a".into(),
            preview: "p".into(),
            content: "c".into(),
            node_type: "fact".into(),
            namespace: "default".into(),
            created_at: 0,
            confidence: None,
            reason: Some("review:pending".into()),
        };
        assert_eq!(
            pending_reason_text(&item),
            "Queued by an agent for approval"
        );
        item.reason = Some("review: low evidence".into());
        assert_eq!(pending_reason_text(&item), "low evidence");
        item.reason = None;
        assert_eq!(
            pending_reason_text(&item),
            "Queued by an agent for approval"
        );
    }
}
