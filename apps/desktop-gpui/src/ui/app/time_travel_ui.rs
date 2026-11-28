//! Time travel: a scrubber above the Memories surface that shows the store as
//! it stood at a past moment (bitemporal "as of", see `core::timetravel`).
//!
//! The as-of point lives in `QueryFilter::as_of_ms`, so it composes with
//! search, scopes, saved views, recents, the graph and context packs, and the
//! `asof:YYYY-MM-DD` token reaches the same state from the search box.
//! Everything here is read-only: one histogram query when the bar opens and
//! one aggregate count per as-of change, both on the background executor.

use std::path::PathBuf;

use gpui::{
    AnyElement, Context, FontWeight, InteractiveElement, IntoElement, ParentElement, Pixels,
    SharedString, StatefulInteractiveElement, Styled, Task, div, prelude::FluentBuilder, px,
};

use super::MemOSApp;
use crate::core::health::now_unix_ms;
use crate::core::model::QueryFilter;
use crate::core::timetravel::{AsOfSummary, Timeline, format_as_of_date, format_as_of_label};
use crate::ui::views::kit::{self, ButtonKind, button, button_disabled, state_marker};
use crate::ui::views::{tabular_nums, tooltip_view};

/// Bars are drawn on a square-root scale so one busy import day does not
/// flatten every other bar to nothing.
const BAR_AREA_H: f32 = 28.;

#[derive(Default)]
pub(super) struct TimeTravelPanel {
    /// The bar is showing (opened from the palette, or an `asof:` is active).
    open: bool,
    timeline: Option<Timeline>,
    timeline_for: Option<PathBuf>,
    timeline_loading: bool,
    summary: Option<AsOfSummary>,
    /// The filter the current summary was computed for.
    summary_for: Option<QueryFilter>,
    generation: u64,
    _timeline_task: Option<Task<()>>,
    _summary_task: Option<Task<()>>,
}

impl MemOSApp {
    pub(super) fn time_travel_visible(&self) -> bool {
        self.time_travel.open || self.filter.as_of_ms.is_some()
    }

    /// Open the bar (palette command). Starts at "now" until a bar is picked.
    pub(super) fn open_time_travel(&mut self, cx: &mut Context<Self>) {
        self.time_travel.open = true;
        if self.active_surface != super::WorkspaceSurface::Memories {
            self.active_surface = super::WorkspaceSurface::Memories;
            self.sidebar.update(cx, |s, cx| {
                s.set_active_surface(crate::ui::views::sidebar::SidebarSurface::Memories, cx)
            });
        }
        self.ensure_timeline(cx);
        cx.notify();
    }

    /// Leave the past: clear the as-of point and close the bar.
    pub(super) fn close_time_travel(&mut self, cx: &mut Context<Self>) {
        self.time_travel.open = false;
        self.time_travel.summary = None;
        self.time_travel.summary_for = None;
        if self.filter.as_of_ms.take().is_some() {
            self.mark_custom_filter_changed(cx);
        } else {
            cx.notify();
        }
    }

    pub(super) fn set_as_of(&mut self, as_of_ms: Option<i64>, cx: &mut Context<Self>) {
        if self.filter.as_of_ms == as_of_ms {
            return;
        }
        self.time_travel.open = true;
        self.filter.as_of_ms = as_of_ms;
        self.mark_custom_filter_changed(cx);
    }

    /// Called whenever the filter is re-queried: keeps the histogram loaded
    /// and the "N existed then" summary in step with the active filter.
    pub(super) fn refresh_time_travel(&mut self, cx: &mut Context<Self>) {
        if self.filter.as_of_ms.is_some() {
            self.ensure_timeline(cx);
        }
        if self.filter.as_of_ms.is_none() {
            self.time_travel.summary = None;
            self.time_travel.summary_for = None;
            self.time_travel._summary_task = None;
            return;
        }
        if self.time_travel.summary_for.as_ref() == Some(&self.filter) {
            return;
        }
        let filter = self.filter.clone();
        self.time_travel.summary_for = Some(filter.clone());
        self.time_travel.generation = self.time_travel.generation.wrapping_add(1);
        let generation = self.time_travel.generation;
        let db_path = self.resolved_db.path.clone();
        let shared = self.shared_store.clone();
        self.time_travel._summary_task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move {
                    shared.with_store(&db_path, |s| s.load_as_of_summary(&filter, now_unix_ms()))
                })
                .await;
            let _ = this.update(cx, |app, cx| {
                if app.time_travel.generation != generation {
                    return;
                }
                app.time_travel.summary = res.ok();
                cx.notify();
            });
        }));
    }

    fn ensure_timeline(&mut self, cx: &mut Context<Self>) {
        let path = self.resolved_db.path.clone();
        let panel = &mut self.time_travel;
        if panel.timeline_loading || panel.timeline_for.as_ref() == Some(&path) {
            return;
        }
        panel.timeline_loading = true;
        panel.timeline_for = Some(path.clone());
        let shared = self.shared_store.clone();
        panel._timeline_task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move { shared.with_store(&path, |s| s.load_timeline(now_unix_ms())) })
                .await;
            let _ = this.update(cx, |app, cx| {
                app.time_travel.timeline_loading = false;
                match res {
                    Ok(t) => app.time_travel.timeline = Some(t),
                    Err(_) => {
                        app.time_travel.timeline = None;
                        app.time_travel.timeline_for = None;
                    }
                }
                cx.notify();
            });
        }));
    }

    /// The store changed on disk: drop cached history and, if the bar is
    /// showing, re-read it so the histogram and counts stay truthful.
    pub(super) fn time_travel_store_changed(&mut self, cx: &mut Context<Self>) {
        self.time_travel.timeline_for = None;
        self.time_travel.summary_for = None;
        if self.time_travel_visible() {
            self.ensure_timeline(cx);
            self.refresh_time_travel(cx);
        }
    }

    /// `right_inset` is the width of the detail overlay covering the right
    /// edge of the surface at narrow widths, matching the list's own inset.
    pub(super) fn render_time_travel_bar(
        &self,
        right_inset: Pixels,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let entity = cx.entity();
        let as_of = self.filter.as_of_ms;
        let panel = &self.time_travel;

        let title: SharedString = match as_of {
            Some(ms) => format!("As of {}", format_as_of_label(ms)).into(),
            None => "Now".into(),
        };
        let detail: SharedString = match (as_of, &panel.summary) {
            (None, _) => {
                "Pick a bar to see the store as it stood at the end of that period.".into()
            }
            (Some(_), Some(s)) => s.sentence().into(),
            (Some(_), None) => "Counting…".into(),
        };

        // Header row: where you are, what it means, how to move.
        let mut nav = div()
            .flex()
            .items_center()
            .gap(px(kit::space::S1))
            .flex_shrink_0();
        let prev = panel.timeline.as_ref().and_then(|t| {
            let from = as_of.unwrap_or(i64::MAX);
            t.previous_change(from.min(now_unix_ms()))
        });
        let next = match (panel.timeline.as_ref(), as_of) {
            (Some(t), Some(ms)) => Some(t.next_change(ms)),
            _ => None,
        };
        nav = nav.child(match prev {
            Some(ms) => {
                let e = entity.clone();
                button("tt-prev", "Earlier", ButtonKind::Subtle, &theme)
                    .tooltip(tooltip_view("Step back to the previous change", theme))
                    .on_click(move |_, _, cx| e.update(cx, |app, cx| app.set_as_of(Some(ms), cx)))
                    .into_any_element()
            }
            None => {
                button_disabled("tt-prev", "Earlier", "nothing earlier", &theme).into_any_element()
            }
        });
        nav = nav.child(match next {
            Some(target) => {
                let e = entity.clone();
                button("tt-next", "Later", ButtonKind::Subtle, &theme)
                    .tooltip(tooltip_view(
                        if target.is_some() {
                            "Step forward to the next change"
                        } else {
                            "Step forward to now"
                        },
                        theme,
                    ))
                    .on_click(move |_, _, cx| e.update(cx, |app, cx| app.set_as_of(target, cx)))
                    .into_any_element()
            }
            None => {
                button_disabled("tt-next", "Later", "already at now", &theme).into_any_element()
            }
        });
        let e_close = entity.clone();
        nav = nav.child(
            button("tt-close", "Back to now", ButtonKind::Secondary, &theme)
                .on_click(move |_, _, cx| e_close.update(cx, |app, cx| app.close_time_travel(cx))),
        );

        let header = div()
            .w_full()
            .min_w(px(0.))
            .flex()
            .items_center()
            .gap(px(kit::space::S3))
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.))
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(kit::space::S2))
                            .child(
                                div()
                                    .text_size(px(kit::text::BASE))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.text_primary)
                                    .font_features(tabular_nums())
                                    .whitespace_nowrap()
                                    .child(title),
                            )
                            .when(as_of.is_some(), |row| {
                                row.child(state_marker("Past view", theme.accent))
                            }),
                    )
                    .child(
                        // Wraps rather than truncates: at the minimum window
                        // width the counts are the point of the bar.
                        div()
                            .text_size(px(kit::text::SM))
                            .line_height(px(17.))
                            .text_color(theme.text_muted)
                            .font_features(tabular_nums())
                            .child(detail),
                    ),
            )
            .child(nav);

        let histogram = match &panel.timeline {
            Some(t) if !t.is_empty() => self.render_histogram(t, as_of, cx),
            Some(_) => div()
                .h(px(BAR_AREA_H))
                .flex()
                .items_center()
                .text_size(px(kit::text::SM))
                .text_color(theme.text_muted)
                .child("No dated memories yet, so there is no history to travel through.")
                .into_any_element(),
            None => div()
                .h(px(BAR_AREA_H))
                .flex()
                .items_center()
                .text_size(px(kit::text::SM))
                .text_color(theme.text_muted)
                .child("Reading history…")
                .into_any_element(),
        };

        div()
            .id("time-travel-bar")
            .w_full()
            .min_w(px(0.))
            .flex_shrink_0()
            .pl(px(kit::space::S4))
            .pr(px(kit::space::S4) + right_inset)
            .pt(px(kit::space::S3))
            .pb(px(kit::space::S2))
            .bg(theme.bg_panel)
            .border_b_1()
            .border_color(theme.border_subtle)
            .flex()
            .flex_col()
            .gap(px(kit::space::S2))
            .child(header)
            .child(histogram)
            .when(as_of.is_some(), |col| {
                col.child(
                    div()
                        .text_size(px(kit::text::XS))
                        .text_color(theme.text_muted)
                        .child(
                            "Forgotten memories are deleted, so they cannot appear in a past view.",
                        ),
                )
            })
            .into_any_element()
    }

    fn render_histogram(
        &self,
        timeline: &Timeline,
        as_of: Option<i64>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let entity = cx.entity();
        let max = timeline.max_activity().max(1) as f32;
        let selected = as_of.and_then(|ms| timeline.bucket_index(ms));
        let last_ix = timeline.buckets.len().saturating_sub(1);
        let width = timeline.width_ms;

        let mut bars = div()
            .w_full()
            .min_w(px(0.))
            .h(px(BAR_AREA_H))
            .flex()
            .items_end()
            .gap(px(1.));
        for (ix, bucket) in timeline.buckets.iter().enumerate() {
            let activity = bucket.activity();
            let scale = |n: u32| ((n as f32).sqrt() / max.sqrt()) * BAR_AREA_H;
            let total_h = if activity == 0 {
                0.
            } else {
                scale(activity).max(2.)
            };
            let change_h = if activity == 0 {
                0.
            } else {
                total_h * (bucket.ended + bucket.expired) as f32 / activity as f32
            };
            let in_future = as_of.is_some_and(|ms| bucket.start_ms > ms);
            let is_selected = selected == Some(ix);
            let base_color = if is_selected {
                theme.accent
            } else {
                theme.text_muted
            };
            let target = if ix == last_ix && as_of.is_none() {
                None
            } else {
                Some(bucket.end_ms(width).min(now_unix_ms()))
            };
            let tip = format!(
                "{} · {} written · {} superseded · {} expired",
                format_as_of_label(bucket.end_ms(width).min(now_unix_ms())),
                bucket.created,
                bucket.ended,
                bucket.expired
            );
            let e = entity.clone();
            bars = bars.child(
                div()
                    .id(("tt-bar", ix))
                    .flex_1()
                    .min_w(px(1.))
                    .h_full()
                    .flex()
                    .flex_col()
                    .justify_end()
                    .cursor_pointer()
                    .rounded_t(px(1.))
                    .hover(move |s| s.bg(theme.bg_hover))
                    .opacity(if in_future { 0.35 } else { 1.0 })
                    .tooltip(tooltip_view(tip, theme))
                    .on_click(move |_, _, cx| e.update(cx, |app, cx| app.set_as_of(target, cx)))
                    .when(change_h > 0., |col| {
                        col.child(div().w_full().h(px(change_h)).bg(theme.danger).opacity(0.7))
                    })
                    .child(
                        div()
                            .w_full()
                            .h(px((total_h - change_h).max(0.)))
                            .bg(base_color),
                    ),
            );
        }

        let first_label = format_as_of_date(timeline.origin_ms);
        div()
            .w_full()
            .min_w(px(0.))
            .flex()
            .flex_col()
            .gap(px(kit::space::S1))
            .child(bars)
            .child(
                div()
                    .w_full()
                    .flex()
                    .justify_between()
                    .text_size(px(kit::text::XS))
                    .text_color(theme.text_muted)
                    .font_features(tabular_nums())
                    .child(first_label)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(kit::space::S3))
                            .child(state_marker("Written", theme.text_muted))
                            .when(timeline.has_validity || timeline.has_expiry, |row| {
                                row.child(state_marker("Superseded or expired", theme.danger))
                            }),
                    )
                    .child("Now"),
            )
            .into_any_element()
    }
}
