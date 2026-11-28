//! Integrity card in Store health: verifies the tamper-evident mutation log
//! on the background executor and shows the verdict as a status card.
//!
//! Read-only end to end. The only file this touches is the desktop's own
//! `integrity-anchors.json` (the tip remembered after a clean pass); the store
//! is opened through the shared read-only connection like every other read.

use std::path::PathBuf;
use std::time::Instant;

use gpui::{
    AnyElement, ClipboardItem, Context, FontWeight, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, Task, div, prelude::FluentBuilder, px,
};

use super::MemOSApp;
use crate::core::health::now_unix_ms;
use crate::core::integrity::{
    AnchorBook, AnchorCheck, IntegrityReport, IntegrityStatus, verify_store_integrity,
};
use crate::core::model::format_relative_age;
use crate::core::timetravel::format_as_of_label;
use crate::ui::views::kit::{
    self, ButtonKind, NoticeKind, button, kv_row, notice, section_label, state_marker,
};
use crate::ui::views::tabular_nums;

#[derive(Default)]
pub(super) enum IntegrityState {
    #[default]
    Idle,
    Running,
    Done {
        report: Box<IntegrityReport>,
        elapsed_ms: u128,
        checked_at_ms: i64,
    },
    Failed(SharedString),
}

/// Per-window integrity state. Results are tied to the store they were
/// computed for, so switching stores quietly returns the card to idle.
#[derive(Default)]
pub(super) struct IntegrityPanel {
    state: IntegrityState,
    db_path: Option<PathBuf>,
    generation: u64,
    _task: Option<Task<()>>,
}

impl MemOSApp {
    /// Verify the chain. `accept_current` first drops the remembered anchor,
    /// for a store the user knowingly replaced (for example from a backup).
    pub(super) fn verify_integrity(&mut self, accept_current: bool, cx: &mut Context<Self>) {
        let db_path = self.resolved_db.path.clone();
        let shared = self.shared_store.clone();
        let panel = &mut self.integrity;
        panel.generation = panel.generation.wrapping_add(1);
        let generation = panel.generation;
        panel.state = IntegrityState::Running;
        panel.db_path = Some(db_path.clone());
        cx.notify();

        panel._task = Some(cx.spawn(async move |this, cx| {
            let started = Instant::now();
            let book_path = AnchorBook::default_path();
            let result = cx
                .background_executor()
                .spawn(async move {
                    let path = db_path.clone();
                    shared.with_store(&db_path, |store| {
                        verify_store_integrity(
                            store,
                            &path,
                            &book_path,
                            accept_current,
                            now_unix_ms(),
                        )
                    })
                })
                .await;
            let elapsed_ms = started.elapsed().as_millis();
            let _ = this.update(cx, |app, cx| {
                if app.integrity.generation != generation {
                    return;
                }
                app.integrity.state = match result {
                    Ok(report) => {
                        crate::core_info!(
                            status = report.status.label(),
                            entries = report.entries_checked,
                            elapsed_ms = elapsed_ms as u64,
                            "integrity check finished"
                        );
                        IntegrityState::Done {
                            report: Box::new(report),
                            elapsed_ms,
                            checked_at_ms: now_unix_ms(),
                        }
                    }
                    Err(err) => IntegrityState::Failed(
                        super::sanitize_db_error(&err, &app.resolved_db.path).into(),
                    ),
                };
                cx.notify();
            });
        }));
    }

    /// Short clause for the Health subtitle when the last check failed, so the
    /// dialog never says "nothing needs attention" above a tampered log.
    pub(super) fn integrity_alert(&self) -> Option<&'static str> {
        match self.current_integrity_state() {
            IntegrityState::Done { report, .. } => match report.status {
                IntegrityStatus::Broken => Some("mutation log failed verification"),
                IntegrityStatus::Inconsistent => Some("mutation log out of sync"),
                _ => None,
            },
            _ => None,
        }
    }

    fn current_integrity_state(&self) -> &IntegrityState {
        if self.integrity.db_path.as_deref() == Some(self.resolved_db.path.as_path()) {
            &self.integrity.state
        } else {
            &IntegrityState::Idle
        }
    }

    pub(super) fn render_integrity_card(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let entity = cx.entity();
        let state = self.current_integrity_state();

        let (marker, marker_color, headline): (&str, gpui::Hsla, SharedString) = match state {
            IntegrityState::Idle => (
                "Not checked",
                theme.text_muted,
                "Recompute the hash chain of every change ever made to this store and confirm nothing was edited behind MemOS's back.".into(),
            ),
            IntegrityState::Running => (
                "Checking",
                theme.accent,
                "Recomputing the hash chain…".into(),
            ),
            IntegrityState::Failed(msg) => ("Could not check", theme.danger, msg.clone()),
            IntegrityState::Done { report, .. } => {
                let color = match report.status {
                    IntegrityStatus::Verified => theme.success,
                    IntegrityStatus::Inconsistent => theme.accent,
                    IntegrityStatus::Broken => theme.danger,
                    IntegrityStatus::NotRecorded | IntegrityStatus::Empty => theme.text_muted,
                };
                (report.status.label(), color, report.headline().into())
            }
        };

        let mut card = div()
            .w_full()
            .min_w(px(0.))
            .pl(px(kit::space::S3))
            .border_l_2()
            .border_color(marker_color)
            .flex()
            .flex_col()
            .gap(px(kit::space::S2))
            .child(
                div()
                    .w_full()
                    .flex()
                    .items_center()
                    .gap(px(kit::space::S2))
                    .child(
                        div()
                            .text_size(px(kit::text::BASE))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text_primary)
                            .child("Mutation log"),
                    )
                    .child(state_marker(marker, marker_color)),
            )
            .child(
                div()
                    .text_size(px(kit::text::SM))
                    .line_height(px(17.))
                    .text_color(theme.text_secondary)
                    .font_features(tabular_nums())
                    .child(headline),
            );

        let mut tip_hash: Option<String> = None;
        let mut diverged = false;
        if let IntegrityState::Done {
            report,
            elapsed_ms,
            checked_at_ms,
        } = state
        {
            diverged = report.anchor == AnchorCheck::Diverged;
            let now = now_unix_ms();
            let mut facts = div().w_full().flex().flex_col().gap(px(2.));
            if let (Some(first), Some(last)) = (report.first_ts, report.last_ts) {
                let (first, last) = (format_as_of_label(first), format_as_of_label(last));
                let span = if first == last {
                    first
                } else {
                    format!("{first} to {last}")
                };
                facts = facts.child(kv_row("Covers", span, &theme));
            }
            if let Some(tip) = &report.tip {
                // A tip is only worth anchoring elsewhere when the chain held.
                if report.status != IntegrityStatus::Broken {
                    tip_hash = Some(tip.entry_hash.clone());
                }
                facts = facts.child(kv_row(
                    "Tip",
                    format!("#{} · {}…", tip.seq, short_hash(&tip.entry_hash)),
                    &theme,
                ));
            }
            if report.unlogged_nodes > 0 {
                facts = facts.child(kv_row(
                    "Before log",
                    format!(
                        "{} {} predate the log",
                        report.unlogged_nodes,
                        if report.unlogged_nodes == 1 {
                            "memory"
                        } else {
                            "memories"
                        }
                    ),
                    &theme,
                ));
            }
            if report.legacy_entries > 0 {
                facts = facts.child(kv_row(
                    "Legacy",
                    format!("{} first-format entries", report.legacy_entries),
                    &theme,
                ));
            }
            facts = facts.child(kv_row(
                "Checked",
                format!(
                    "{} ago · took {} ms",
                    format_relative_age(*checked_at_ms, now),
                    elapsed_ms
                ),
                &theme,
            ));
            card = card.child(facts);

            if matches!(
                report.status,
                IntegrityStatus::Verified | IntegrityStatus::Inconsistent
            ) {
                card = card.child(notice(
                    NoticeKind::Info,
                    "This compares log order and which memories exist; memos log verify also compares each memory's full contents. Copy the tip hash somewhere off this machine to make a future rewrite provable.",
                    &theme,
                ));
            }
            if diverged {
                card = card.child(notice(
                    NoticeKind::Danger,
                    "If you restored this store from a backup or replaced it on purpose, accept its current history as the new baseline. Otherwise keep a copy of the file before writing to it.",
                    &theme,
                ));
            }
        }

        let running = matches!(state, IntegrityState::Running);
        let checked = matches!(state, IntegrityState::Done { .. });
        let mut actions = div().flex().items_center().gap(px(kit::space::S2));
        if running {
            actions = actions.child(kit::button_disabled(
                "integrity-verify",
                "Checking…",
                "a check is already running",
                &theme,
            ));
        } else {
            let e = entity.clone();
            actions = actions.child(
                button(
                    "integrity-verify",
                    if checked {
                        "Check again"
                    } else {
                        "Verify chain"
                    },
                    ButtonKind::Secondary,
                    &theme,
                )
                .on_click(move |_, _, cx| e.update(cx, |app, cx| app.verify_integrity(false, cx))),
            );
        }
        if let Some(hash) = tip_hash {
            let e = entity.clone();
            actions = actions.child(
                button(
                    "integrity-copy-tip",
                    "Copy tip hash",
                    ButtonKind::Subtle,
                    &theme,
                )
                .on_click(move |_, _, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(hash.clone()));
                    e.update(cx, |app, cx| {
                        app.set_notice(
                            "Tip hash copied. Check it later with memos log verify --expect.",
                            cx,
                        )
                    });
                }),
            );
        }
        let e_accept = entity.clone();
        actions = actions.when(diverged && !running, |row| {
            row.child(
                button(
                    "integrity-accept",
                    "Accept current history",
                    ButtonKind::Subtle,
                    &theme,
                )
                .on_click(move |_, _, cx| {
                    e_accept.update(cx, |app, cx| app.verify_integrity(true, cx))
                }),
            )
        });
        card = card.child(actions);

        div()
            .w_full()
            .pt(px(kit::space::S2))
            .flex()
            .flex_col()
            .gap(px(kit::space::S2))
            .child(section_label("Integrity", &theme))
            .child(card)
            .into_any_element()
    }
}

fn short_hash(hash: &str) -> &str {
    hash.get(..12).unwrap_or(hash)
}
