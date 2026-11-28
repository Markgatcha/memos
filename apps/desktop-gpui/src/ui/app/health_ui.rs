//! Store health as an action center: issues grouped by urgency, each with what
//! it means, why it matters, and one button that goes to the exact memories.

use std::rc::Rc;

use gpui::{
    AnyElement, Context, FontWeight, ParentElement, SharedString, StatefulInteractiveElement,
    Styled, div, prelude::FluentBuilder, px,
};

use super::MemOSApp;
use crate::core::health::{
    HealthIssue, HealthIssueAction, HealthPanelFilter, IssueSeverity, StoreHealthStatus,
    health_issues, now_unix_ms,
};
use crate::ui::views::kit::{
    self, ButtonKind, ModalShell, Segment, button, empty_state, section_label, segmented,
};
use crate::ui::views::tabular_nums;

impl MemOSApp {
    fn run_health_action(&mut self, action: HealthIssueAction, cx: &mut Context<Self>) {
        match action {
            HealthIssueAction::Filter(filter) => self.apply_health_fix_filter(*filter, cx),
            HealthIssueAction::OpenReview => {
                self.show_health_modal = false;
                self.open_review_view(cx);
            }
            HealthIssueAction::OpenToday => {
                self.show_health_modal = false;
                self.open_today_view(cx);
            }
            HealthIssueAction::None => {}
        }
    }

    pub(super) fn render_health_center(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let entity = cx.entity();
        let report = self.health_report.as_ref();
        let all_issues: Vec<HealthIssue> = report
            .map(|r| health_issues(r, self.pending_review_count, now_unix_ms()))
            .unwrap_or_default();
        let tab = self.health_filter;
        let issues: Vec<&HealthIssue> = all_issues
            .iter()
            .filter(|i| tab == HealthPanelFilter::All || i.panel == tab)
            .collect();
        let actionable = all_issues
            .iter()
            .filter(|i| i.severity != IssueSeverity::Info)
            .count();

        let subtitle: SharedString = match report {
            None => "Health appears once the store has loaded".into(),
            Some(r) if r.status == StoreHealthStatus::Empty => "Empty store".into(),
            Some(r) => match (actionable, self.integrity_alert()) {
                (0, Some(alert)) => format!("Score {} of 100 · {alert}", r.score).into(),
                (_, Some(alert)) => format!(
                    "Score {} of 100 · {actionable} to look at · {alert}",
                    r.score
                )
                .into(),
                (0, None) => format!("Score {} of 100 · nothing needs attention", r.score).into(),
                (1, None) => format!("Score {} of 100 · 1 thing to look at", r.score).into(),
                (n, None) => format!("Score {} of 100 · {n} things to look at", r.score).into(),
            },
        };

        let mut shell = ModalShell::new("health-dialog", "Store health")
            .subtitle(subtitle)
            .width(600.);

        if let Some(r) = report {
            let score = r.score;
            let bar_color = if score >= 80 {
                theme.success
            } else if score >= 50 {
                theme.accent
            } else {
                theme.danger
            };
            shell = shell.child(
                div()
                    .w_full()
                    .h(px(4.))
                    .rounded(px(2.))
                    .bg(theme.bg_elevated)
                    .overflow_hidden()
                    .child(
                        div()
                            .h_full()
                            .w(gpui::relative((score as f32 / 100.0).clamp(0.0, 1.0)))
                            .bg(bar_color),
                    ),
            );
            let tabs = HealthPanelFilter::ALL
                .into_iter()
                .map(|f| {
                    let e = entity.clone();
                    let label = match f {
                        HealthPanelFilter::All => "All",
                        HealthPanelFilter::Contradictions => "Conflicts & review",
                        HealthPanelFilter::Stale => "Freshness & trust",
                    };
                    Segment::new(label, tab == f, move |_, _, cx| {
                        e.update(cx, |app, cx| {
                            app.health_filter = f;
                            cx.notify();
                        })
                    })
                })
                .collect();
            shell = shell.child(segmented("health-tabs", "Health issues", tabs, &theme));
        }

        if issues.is_empty() {
            shell = shell.child(match report {
                None => empty_state(
                    "Still reading the store",
                    "Health is computed from counts only, after the list loads.",
                    &theme,
                ),
                Some(_) if tab != HealthPanelFilter::All => empty_state(
                    "Nothing here",
                    "No issues of this kind. The All tab shows everything else.",
                    &theme,
                ),
                Some(_) => empty_state(
                    "Nothing to clean up",
                    "Conflicts, expired, duplicate and low-trust memories show up here when they appear.",
                    &theme,
                ),
            });
        } else {
            let mut current: Option<IssueSeverity> = None;
            for (ix, issue) in issues.into_iter().enumerate() {
                if current != Some(issue.severity) {
                    current = Some(issue.severity);
                    shell = shell.child(
                        div()
                            .pt(px(if ix == 0 { 0. } else { kit::space::S2 }))
                            .child(section_label(issue.severity.heading(), &theme)),
                    );
                }
                let action = issue.action.clone();
                let has_action = action != HealthIssueAction::None;
                let e = entity.clone();
                let marker_color = match issue.severity {
                    IssueSeverity::Attention => theme.danger,
                    IssueSeverity::Review => theme.accent,
                    IssueSeverity::Info => theme.border_strong,
                };
                shell = shell.child(
                    div()
                        .w_full()
                        .min_w(px(0.))
                        .pl(px(kit::space::S3))
                        .border_l_2()
                        .border_color(marker_color)
                        .flex()
                        .items_start()
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
                                        .text_size(px(kit::text::BASE))
                                        .line_height(px(18.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .font_features(tabular_nums())
                                        .text_color(theme.text_primary)
                                        .child(SharedString::from(issue.title.clone())),
                                )
                                .child(
                                    div()
                                        .text_size(px(kit::text::SM))
                                        .line_height(px(17.))
                                        .text_color(theme.text_muted)
                                        .child(issue.impact),
                                ),
                        )
                        .when(has_action, |row| {
                            row.child(
                                button(
                                    SharedString::from(format!("health-issue-{}", issue.id)),
                                    issue.action_label,
                                    ButtonKind::Secondary,
                                    &theme,
                                )
                                .on_click(move |_, _, cx| {
                                    let action = action.clone();
                                    e.update(cx, |app, cx| app.run_health_action(action, cx));
                                }),
                            )
                        }),
                );
            }
        }

        if report.is_some_and(|r| r.status != StoreHealthStatus::Empty) {
            shell = shell.child(self.render_integrity_card(cx));
        }

        if let Some(r) = report {
            shell = shell.footer_note(div().font_features(tabular_nums()).child(
                SharedString::from(format!(
                    "{} memories · {} links · counts only, no memory text",
                    r.node_count, r.edge_count
                )),
            ));
        }
        let e_opt = entity.clone();
        let e_close = entity.clone();
        shell = shell
            .action(
                button(
                    "health-optimize",
                    "Optimize store",
                    ButtonKind::Subtle,
                    &theme,
                )
                .tooltip(crate::ui::views::tooltip_view(
                    "Adds missing read-path indexes. Never changes memories.",
                    theme,
                ))
                .on_click(move |_, _, cx| e_opt.update(cx, |app, cx| app.optimize_store(cx))),
            )
            .action(
                button("health-modal-close", "Close", ButtonKind::Secondary, &theme).on_click(
                    move |_, window, cx| {
                        e_close.update(cx, |app, cx| {
                            app.show_health_modal = false;
                            window.focus(&app.focus_handle, cx);
                            cx.notify();
                        })
                    },
                ),
            );
        shell.render(
            &theme,
            Rc::new(move |window, cx| {
                entity.update(cx, |app, cx| {
                    app.show_health_modal = false;
                    window.focus(&app.focus_handle, cx);
                    cx.notify();
                })
            }),
        )
    }
}
