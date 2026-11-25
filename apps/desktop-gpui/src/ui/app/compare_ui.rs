//! Side-by-side comparison for a pair of memories, usually a contradiction.
//! Read-only investigation first; write actions appear only in write mode.

use std::rc::Rc;
use std::time::{SystemTime, UNIX_EPOCH};

use gpui::{
    AnyElement, Context, FontWeight, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, Task, Window, div, prelude::FluentBuilder, px,
};

use super::MemOSApp;
use crate::core::compare::{Side, compare_rows, comparison_hint, more_trusted_side, newer_side};
use crate::core::db::DbError;
use crate::core::model::{MemoryDetail, format_time_relative_and_absolute};
use crate::ui::request::RequestToken;
use crate::ui::views::brief::format_contradiction_status_label;
use crate::ui::views::kit::{
    self, ButtonKind, ModalShell, NoticeKind, button, notice, state_marker,
};
use crate::ui::views::{ThemePalette, tabular_nums};

#[derive(Default)]
pub(super) struct CompareState {
    pub open: bool,
    pub left: Option<MemoryDetail>,
    pub right: Option<MemoryDetail>,
    pub loading: bool,
    pub error: Option<String>,
    pub generation: RequestToken,
    pub task: Option<Task<()>>,
}

impl CompareState {
    pub fn detail_for(&self, id: &str) -> Option<&MemoryDetail> {
        [self.left.as_ref(), self.right.as_ref()]
            .into_iter()
            .flatten()
            .find(|d| d.id == id)
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl MemOSApp {
    pub(super) fn open_compare(
        &mut self,
        left_id: String,
        right_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.dismiss_popovers(super::PopoverOwner::None, cx);
        self.close_all_modals();
        self.compare.open = true;
        self.compare.loading = true;
        self.compare.error = None;
        self.compare.left = None;
        self.compare.right = None;
        window.focus(&self.focus_handle, cx);
        cx.notify();

        let request = self.compare.generation.advance();
        let db_path = self.resolved_db.path.clone();
        let shared = self.shared_store.clone();
        self.compare.task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move {
                    shared.with_store(&db_path, |store| {
                        let a = store.load_node_detail(&left_id)?;
                        let b = store.load_node_detail(&right_id)?;
                        Ok::<_, DbError>((a, b))
                    })
                })
                .await;
            let _ = this.update(cx, |app, cx| {
                if !app.compare.generation.is_current(request) {
                    return;
                }
                app.compare.loading = false;
                match res {
                    Ok((Some(a), Some(b))) => {
                        for d in [&a, &b] {
                            crate::telemetry::register_sensitive_text(&d.content);
                        }
                        app.compare.left = Some(a);
                        app.compare.right = Some(b);
                    }
                    Ok(_) => {
                        app.compare.error = Some(
                            "One of these memories is no longer in the store. It may have been forgotten or superseded."
                                .to_string(),
                        );
                    }
                    Err(err) => {
                        app.compare.error =
                            Some(super::sanitize_db_error(&err, &app.resolved_db.path));
                    }
                }
                cx.notify();
            });
        }));
    }

    /// Compare the selected memory with its first contradicting memory.
    pub(super) fn compare_selected(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(sel) = self.selected_id.clone() else {
            self.set_notice("Select a memory with a conflict to compare", cx);
            return;
        };
        let peer = self
            .detail_view
            .read(cx)
            .detail()
            .filter(|d| d.id == sel)
            .and_then(|d| d.contradictions.first().map(|c| c.peer_id.clone()));
        match peer {
            Some(peer) => self.open_compare(sel, peer, window, cx),
            None => self.set_notice("This memory has no recorded conflict", cx),
        }
    }

    pub(super) fn close_compare(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.compare.open = false;
        self.compare.task = None;
        self.compare.generation.advance();
        window.focus(&self.focus_handle, cx);
        cx.notify();
    }

    pub(super) fn render_compare_modal(
        &self,
        viewport_h: f32,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let entity = cx.entity();
        let now = now_ms();

        let mut shell = ModalShell::new("compare-dialog", "Compare memories").width(900.);

        match (&self.compare.left, &self.compare.right) {
            (Some(a), Some(b)) => {
                let link = a.contradictions.iter().find(|c| c.peer_id == b.id);
                let subtitle = match link {
                    Some(c) => format!(
                        "{} conflict · detected {}",
                        format_contradiction_status_label(&c.status),
                        format_time_relative_and_absolute(c.detected_at, now)
                    ),
                    None => format!("{} and {}", a.citation_token, b.citation_token),
                };
                shell = shell.subtitle(subtitle).child(notice(
                    NoticeKind::Info,
                    comparison_hint(a, b),
                    &theme,
                ));

                let content_max_h = (viewport_h * 0.92 - 470.0).clamp(96.0, 260.0);
                let newer = newer_side(a, b);
                let trusted = more_trusted_side(a, b);
                shell = shell.child(
                    div()
                        .w_full()
                        .flex()
                        .gap(px(kit::space::S4))
                        .child(self.render_compare_column(
                            Side::Left,
                            a,
                            newer,
                            trusted,
                            content_max_h,
                            cx,
                        ))
                        .child(div().w(px(1.)).flex_shrink_0().bg(theme.border_subtle))
                        .child(self.render_compare_column(
                            Side::Right,
                            b,
                            newer,
                            trusted,
                            content_max_h,
                            cx,
                        )),
                );

                let rows = compare_rows(a, b, now);
                shell = shell.child(
                    div()
                        .w_full()
                        .pt(px(kit::space::S2))
                        .border_t_1()
                        .border_color(theme.border_subtle)
                        .flex()
                        .flex_col()
                        .children(rows.into_iter().map(|r| {
                            let value = |v: String| {
                                div()
                                    .flex_1()
                                    .min_w(px(0.))
                                    .text_size(px(kit::text::SM))
                                    .font_features(tabular_nums())
                                    .text_color(if r.differs {
                                        theme.text_primary
                                    } else {
                                        theme.text_muted
                                    })
                                    .when(r.differs, |el| el.font_weight(FontWeight::MEDIUM))
                                    .truncate()
                                    .child(SharedString::from(v))
                            };
                            div()
                                .h(px(24.))
                                .w_full()
                                .flex()
                                .items_center()
                                .gap(px(kit::space::S4))
                                .child(
                                    div()
                                        .w(px(88.))
                                        .flex_shrink_0()
                                        .text_size(px(kit::text::SM))
                                        .text_color(theme.text_muted)
                                        .child(r.label),
                                )
                                .child(value(r.left))
                                .child(value(r.right))
                                .child(
                                    div()
                                        .w(px(48.))
                                        .flex_shrink_0()
                                        .text_size(px(kit::text::XS))
                                        .text_color(theme.text_muted)
                                        .child(if r.differs { "differs" } else { "" }),
                                )
                        })),
                );
                if !self.settings.write_mode {
                    shell = shell
                        .footer_note(div().child(
                            "View only. Turn on editing in Settings to forget either side.",
                        ));
                } else {
                    shell = shell.footer_note(div().child(
                        "Forgetting is permanent in the store's history; edit instead to keep provenance.",
                    ));
                }
            }
            _ => {
                let body: AnyElement = match &self.compare.error {
                    Some(err) => notice(NoticeKind::Danger, err.clone(), &theme).into_any_element(),
                    None => div()
                        .h(px(120.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_size(px(kit::text::SM))
                        .text_color(theme.text_muted)
                        .child(if self.compare.loading {
                            "Loading both memories…"
                        } else {
                            "Nothing to compare"
                        })
                        .into_any_element(),
                };
                shell = shell.child(body);
            }
        }

        let close_entity = entity.clone();
        shell = shell.action(
            button("compare-close", "Close", ButtonKind::Secondary, &theme).on_click(
                move |_, window, cx| {
                    close_entity.update(cx, |app, cx| app.close_compare(window, cx))
                },
            ),
        );
        shell.render(
            &theme,
            Rc::new(move |window, cx| entity.update(cx, |app, cx| app.close_compare(window, cx))),
        )
    }

    fn render_compare_column(
        &self,
        side: Side,
        d: &MemoryDetail,
        newer: Option<Side>,
        trusted: Option<Side>,
        content_max_h: f32,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme: ThemePalette = self.theme;
        let entity = cx.entity();
        let key = match side {
            Side::Left => "left",
            Side::Right => "right",
        };
        let body = if d.content.trim().is_empty() {
            d.summary.clone()
        } else {
            d.content.clone()
        };
        let id_open = d.id.clone();
        let id_pin = d.id.clone();
        let id_forget = d.id.clone();
        let pinned = self.pack.is_pinned(&d.id);
        let tags = if d.tags.is_empty() {
            None
        } else {
            Some(
                d.tags
                    .iter()
                    .map(|t| format!("#{t}"))
                    .collect::<Vec<_>>()
                    .join("  "),
            )
        };

        div()
            .flex_1()
            .min_w(px(0.))
            .flex()
            .flex_col()
            .gap(px(kit::space::S2))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(kit::space::S2))
                    .child(
                        div()
                            .w(px(7.))
                            .h(px(7.))
                            .rounded_full()
                            .bg(theme.type_color(&d.node_type)),
                    )
                    .child(
                        div()
                            .text_size(px(kit::text::SM))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text_secondary)
                            .child(SharedString::from(format!(
                                "{} · {}",
                                d.node_type, d.citation_token
                            ))),
                    )
                    .when(newer == Some(side), |row| {
                        row.child(state_marker("Newer", theme.text_secondary))
                    })
                    .when(trusted == Some(side), |row| {
                        row.child(state_marker("More trusted", theme.success))
                    }),
            )
            .child(
                div()
                    .id(SharedString::from(format!("compare-body-{key}")))
                    .max_h(px(content_max_h))
                    .overflow_y_scroll()
                    .text_size(px(kit::text::READ))
                    .line_height(px(21.))
                    .text_color(theme.text_primary)
                    .child(SharedString::from(body)),
            )
            .when_some(tags, |col, t| {
                col.child(
                    div()
                        .text_size(px(kit::text::SM))
                        .text_color(theme.text_muted)
                        .truncate()
                        .child(SharedString::from(t)),
                )
            })
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(kit::space::S2))
                    .child({
                        let e = entity.clone();
                        button(
                            SharedString::from(format!("compare-open-{key}")),
                            "Open",
                            ButtonKind::Secondary,
                            &theme,
                        )
                        .on_click(move |_, window, cx| {
                            e.update(cx, |app, cx| {
                                app.close_compare(window, cx);
                                app.select_memory(id_open.clone(), true, cx);
                            })
                        })
                    })
                    .child({
                        let e = entity.clone();
                        button(
                            SharedString::from(format!("compare-pin-{key}")),
                            if pinned { "Unpin" } else { "Pin" },
                            ButtonKind::Subtle,
                            &theme,
                        )
                        .on_click(move |_, _, cx| {
                            e.update(cx, |app, cx| app.toggle_pin(&id_pin, cx))
                        })
                    })
                    .when(self.settings.write_mode, |row| {
                        let e = entity.clone();
                        row.child(
                            button(
                                SharedString::from(format!("compare-forget-{key}")),
                                "Forget…",
                                ButtonKind::Danger,
                                &theme,
                            )
                            .on_click(move |_, _, cx| {
                                e.update(cx, |app, cx| {
                                    app.open_forget_confirm_for(id_forget.clone(), cx)
                                })
                            }),
                        )
                    }),
            )
            .into_any_element()
    }
}
