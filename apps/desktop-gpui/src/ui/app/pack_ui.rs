//! Context pack builder: collect memories from the selection, the current view
//! or an explicit pin list, fit them to a token budget, and copy them in the
//! format an agent or document needs. Entirely local and read-only.

use std::collections::HashSet;
use std::rc::Rc;
use std::sync::Arc;

use gpui::{
    AnyElement, ClipboardItem, Context, InteractiveElement, IntoElement, ParentElement,
    ScrollHandle, SharedString, StatefulInteractiveElement, Styled, Task, Window, div, point,
    prelude::FluentBuilder, px,
};

use super::MemOSApp;
use crate::core::context_pack::{
    ContextPack, PACK_PIN_LIMIT, PACK_VIEW_FETCH_LIMIT, PackBudget, PackFormat, PackSource,
    build_context_pack, toggle_pin,
};
use crate::core::db::DbError;
use crate::core::model::{ContextPreviewItem, describe_filter_target, make_single_line_preview};
use crate::ui::request::RequestToken;
use crate::ui::views::kit::{
    self, ButtonKind, ModalShell, NoticeKind, Segment, button, button_disabled, empty_state,
    icon_button, notice, section_label, segmented,
};
use crate::ui::views::{UiIcon, render_vertical_scroll_overlay, tabular_nums};

#[derive(Default)]
pub(super) struct PackState {
    pub open: bool,
    pub source: PackSource,
    pub format: PackFormat,
    pub budget: PackBudget,
    /// Ordered pin list; session-only so nothing about the store is written to disk.
    pub pins: Vec<String>,
    pub pin_set: Arc<HashSet<String>>,
    pub loading: bool,
    pub items: Vec<ContextPreviewItem>,
    pub total_matching: usize,
    pub title: String,
    pub subtitle: String,
    pub built: Option<ContextPack>,
    pub error: Option<String>,
    pub scroll: ScrollHandle,
    pub generation: RequestToken,
    pub task: Option<Task<()>>,
}

impl PackState {
    pub fn is_pinned(&self, id: &str) -> bool {
        self.pin_set.contains(id)
    }
}

impl MemOSApp {
    /// Open the pack builder. `source` of `None` keeps the last source, falling
    /// back to the selection when one exists.
    pub(super) fn open_context_pack(
        &mut self,
        source: Option<PackSource>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.dismiss_popovers(super::PopoverOwner::None, cx);
        self.close_all_modals();
        let source = source.unwrap_or(if self.pack.open || !self.pack.pins.is_empty() {
            self.pack.source
        } else if self.selected_id.is_some() {
            PackSource::Selected
        } else {
            PackSource::CurrentView
        });
        self.pack.open = true;
        self.pack.source = source;
        self.pack.scroll.set_offset(point(px(0.), px(0.)));
        window.focus(&self.focus_handle, cx);
        self.load_pack_items(cx);
    }

    pub(super) fn close_context_pack(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.pack.open = false;
        self.pack.task = None;
        self.pack.generation.advance();
        window.focus(&self.focus_handle, cx);
        cx.notify();
    }

    fn set_pack_source(&mut self, source: PackSource, cx: &mut Context<Self>) {
        if self.pack.source != source {
            self.pack.source = source;
            self.pack.scroll.set_offset(point(px(0.), px(0.)));
            self.load_pack_items(cx);
        }
    }

    fn set_pack_format(&mut self, format: PackFormat, cx: &mut Context<Self>) {
        self.pack.format = format;
        self.rebuild_pack();
        cx.notify();
    }

    fn set_pack_budget(&mut self, budget: PackBudget, cx: &mut Context<Self>) {
        self.pack.budget = budget;
        self.rebuild_pack();
        cx.notify();
    }

    fn rebuild_pack(&mut self) {
        self.pack.built = if self.pack.items.is_empty() {
            None
        } else {
            Some(build_context_pack(
                &self.pack.items,
                self.pack.total_matching,
                &self.pack.title,
                self.pack.format,
                self.pack.budget,
            ))
        };
    }

    fn load_pack_items(&mut self, cx: &mut Context<Self>) {
        let request = self.pack.generation.advance();
        self.pack.error = None;
        self.pack.built = None;
        self.pack.items.clear();
        self.pack.total_matching = 0;

        enum Load {
            Ready(Vec<ContextPreviewItem>, usize),
            View,
            Ids(Vec<String>),
        }

        let load = match self.pack.source {
            PackSource::Selected => {
                let Some(sel) = self.selected_id.clone() else {
                    self.pack.title = "Selected memory".to_string();
                    self.pack.subtitle = "Nothing selected".to_string();
                    self.pack.loading = false;
                    cx.notify();
                    return;
                };
                self.pack.title = "Selected memory".to_string();
                match self.detail_view.read(cx).detail().filter(|d| d.id == sel) {
                    Some(d) => {
                        self.pack.subtitle = format!("Selected memory · {}", d.citation_token);
                        Load::Ready(
                            vec![ContextPreviewItem {
                                id: d.id.clone(),
                                short_id: d.short_id.clone(),
                                node_type: d.node_type.clone(),
                                namespace: d.namespace.clone(),
                                content: d.content.clone(),
                                summary: d.summary.clone(),
                                tags: d.tags.clone(),
                                updated_at: d.updated_at,
                            }],
                            1,
                        )
                    }
                    None => {
                        self.pack.subtitle = "Selected memory".to_string();
                        Load::Ids(vec![sel])
                    }
                }
            }
            PackSource::CurrentView => {
                self.pack.title = self.current_view_title();
                self.pack.subtitle = describe_filter_target(&self.filter);
                Load::View
            }
            PackSource::Pinned => {
                let n = self.pack.pins.len();
                self.pack.title = "Pinned memories".to_string();
                self.pack.subtitle = if n == 1 {
                    "1 pinned memory".to_string()
                } else {
                    format!("{n} pinned memories")
                };
                if n == 0 {
                    self.pack.loading = false;
                    cx.notify();
                    return;
                }
                Load::Ids(self.pack.pins.clone())
            }
        };

        if let Load::Ready(items, total) = load {
            self.pack.items = items;
            self.pack.total_matching = total;
            self.pack.loading = false;
            self.rebuild_pack();
            cx.notify();
            return;
        }

        self.pack.loading = true;
        cx.notify();
        let db_path = self.resolved_db.path.clone();
        let shared = self.shared_store.clone();
        let filter = self.filter.clone();
        let overview = self.overview.clone();
        self.pack.task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move {
                    shared.with_store(&db_path, |store| match load {
                        Load::Ids(ids) => {
                            let items = store.load_context_items_by_ids(&ids)?;
                            let n = items.len();
                            Ok::<_, DbError>((items, n))
                        }
                        Load::View => {
                            let contradiction_ids = match overview {
                                Some(ov) => ov.contradiction_node_ids,
                                None => store.load_overview()?.contradiction_node_ids,
                            };
                            store.load_context_items_for_filter(
                                &filter,
                                &contradiction_ids,
                                PACK_VIEW_FETCH_LIMIT,
                            )
                        }
                        Load::Ready(items, n) => Ok((items, n)),
                    })
                })
                .await;
            let _ = this.update(cx, |app, cx| {
                if !app.pack.generation.is_current(request) {
                    return;
                }
                app.pack.loading = false;
                match res {
                    Ok((items, total)) => {
                        for item in &items {
                            crate::telemetry::register_sensitive_text(&item.content);
                        }
                        app.pack.items = items;
                        app.pack.total_matching = total;
                        app.rebuild_pack();
                    }
                    Err(err) => {
                        app.pack.error =
                            Some(super::sanitize_db_error(&err, &app.resolved_db.path));
                    }
                }
                cx.notify();
            });
        }));
    }

    /// Pin or unpin the selected memory (keyboard `P`, inspector, palette).
    pub(super) fn toggle_pin_selected(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.selected_id.clone() else {
            self.set_notice("Select a memory to pin it", cx);
            return;
        };
        self.toggle_pin(&id, cx);
    }

    pub(super) fn toggle_pin(&mut self, id: &str, cx: &mut Context<Self>) {
        let was_full = self.pack.pins.len() >= PACK_PIN_LIMIT && !self.pack.is_pinned(id);
        let pinned = toggle_pin(&mut self.pack.pins, id);
        self.sync_pins(cx);
        let n = self.pack.pins.len();
        if was_full {
            self.set_notice(
                format!("Context pack is full ({PACK_PIN_LIMIT} pinned)"),
                cx,
            );
        } else if pinned {
            self.set_notice(format!("Pinned to context pack · {n}"), cx);
        } else {
            self.set_notice(format!("Unpinned · {n} left in context pack"), cx);
        }
        if self.pack.open && self.pack.source == PackSource::Pinned {
            self.load_pack_items(cx);
        }
    }

    pub(super) fn clear_pins(&mut self, cx: &mut Context<Self>) {
        self.pack.pins.clear();
        self.sync_pins(cx);
        if self.pack.open && self.pack.source == PackSource::Pinned {
            self.load_pack_items(cx);
        }
        self.set_notice("Cleared pinned memories", cx);
    }

    fn sync_pins(&mut self, cx: &mut Context<Self>) {
        let set: Arc<HashSet<String>> = Arc::new(self.pack.pins.iter().cloned().collect());
        self.pack.pin_set = set.clone();
        self.list_view
            .update(cx, |l, cx| l.set_pinned_ids(set.clone(), cx));
        self.detail_view
            .update(cx, |d, cx| d.set_pinned_ids(set, cx));
        cx.notify();
    }

    fn copy_pack(&mut self, cx: &mut Context<Self>) {
        let Some(pack) = self.pack.built.as_ref() else {
            return;
        };
        let n = pack.included_count();
        cx.write_to_clipboard(ClipboardItem::new_string(pack.payload.clone()));
        let noun = if n == 1 { "memory" } else { "memories" };
        self.set_notice(
            format!(
                "Copied {n} {noun} · ≈ {} tokens",
                format_count(pack.estimated_tokens)
            ),
            cx,
        );
    }

    pub(super) fn render_pack_modal(&self, viewport_h: f32, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let entity = cx.entity();
        let pin_count = self.pack.pins.len();

        let source_segments = PackSource::ALL
            .into_iter()
            .map(|src| {
                let label = match src {
                    PackSource::Pinned if pin_count > 0 => format!("Pinned · {pin_count}"),
                    _ => src.label().to_string(),
                };
                let e = entity.clone();
                Segment::new(label, self.pack.source == src, move |_, _, cx| {
                    e.update(cx, |app, cx| app.set_pack_source(src, cx));
                })
            })
            .collect();
        let budget_segments = PackBudget::ALL
            .into_iter()
            .map(|b| {
                let e = entity.clone();
                Segment::new(b.label(), self.pack.budget == b, move |_, _, cx| {
                    e.update(cx, |app, cx| app.set_pack_budget(b, cx));
                })
            })
            .collect();
        let format_segments = PackFormat::ALL
            .into_iter()
            .map(|f| {
                let e = entity.clone();
                Segment::new(f.label(), self.pack.format == f, move |_, _, cx| {
                    e.update(cx, |app, cx| app.set_pack_format(f, cx));
                })
            })
            .collect();

        let control_row = |label: &'static str, control: AnyElement| {
            div()
                .flex()
                .items_center()
                .gap(px(kit::space::S3))
                .child(
                    div()
                        .w(px(56.))
                        .flex_shrink_0()
                        .text_size(px(kit::text::SM))
                        .text_color(theme.text_muted)
                        .child(label),
                )
                .child(control)
        };

        let mut shell = ModalShell::new("context-pack-dialog", "Context pack")
            .subtitle(self.pack.subtitle.clone())
            .width(640.)
            .child(control_row(
                "Source",
                segmented("pack-source", "Pack source", source_segments, &theme),
            ))
            .child(control_row(
                "Budget",
                segmented("pack-budget", "Token budget", budget_segments, &theme),
            ))
            .child(control_row(
                "Format",
                segmented("pack-format", "Copy format", format_segments, &theme),
            ));

        // Pinned list with per-item removal.
        if self.pack.source == PackSource::Pinned && !self.pack.items.is_empty() {
            let included: HashSet<&str> = self
                .pack
                .built
                .as_ref()
                .map(|b| b.included_ids.iter().map(String::as_str).collect())
                .unwrap_or_default();
            let rows = self.pack.items.iter().enumerate().map(|(ix, item)| {
                let id = item.id.clone();
                let left_out = !included.contains(item.id.as_str());
                let preview = make_single_line_preview(
                    if item.summary.trim().is_empty() {
                        &item.content
                    } else {
                        &item.summary
                    },
                    90,
                );
                let e = entity.clone();
                div()
                    .h(px(28.))
                    .w_full()
                    .min_w(px(0.))
                    .flex()
                    .items_center()
                    .gap(px(kit::space::S2))
                    .child(
                        div()
                            .w(px(44.))
                            .flex_shrink_0()
                            .font_family(kit::MONO_FONT)
                            .text_size(px(kit::text::XS))
                            .text_color(theme.text_muted)
                            .child(SharedString::from(item.short_id.clone())),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .text_size(px(kit::text::SM))
                            .text_color(if left_out {
                                theme.text_muted
                            } else {
                                theme.text_primary
                            })
                            .truncate()
                            .child(SharedString::from(preview)),
                    )
                    .when(left_out, |row| {
                        row.child(
                            div()
                                .flex_shrink_0()
                                .text_size(px(kit::text::XS))
                                .text_color(theme.text_muted)
                                .child("over budget"),
                        )
                    })
                    .child(
                        icon_button(("pack-unpin", ix), UiIcon::Close, "Unpin", &theme)
                            .tooltip(crate::ui::views::tooltip_view("Unpin", theme))
                            .on_click(move |_, _, cx| {
                                e.update(cx, |app, cx| app.toggle_pin(&id, cx));
                            }),
                    )
            });
            shell = shell.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(section_label("Pinned", &theme))
                            .child({
                                let e = entity.clone();
                                button("pack-clear-pins", "Clear all", ButtonKind::Subtle, &theme)
                                    .on_click(move |_, _, cx| {
                                        e.update(cx, |app, cx| app.clear_pins(cx));
                                    })
                            }),
                    )
                    .child(
                        div()
                            .id("pack-pinned-list")
                            .max_h(px(140.))
                            .overflow_y_scroll()
                            .flex()
                            .flex_col()
                            .children(rows),
                    ),
            );
        }

        // Notices that explain what the copy will and will not contain.
        if let Some(pack) = &self.pack.built {
            if pack.first_exceeds_budget {
                shell = shell.child(notice(
                    NoticeKind::Warning,
                    "This memory alone is larger than the budget. It is included in full; memories are never cut.",
                    &theme,
                ));
            } else if pack.omitted_for_budget > 0 {
                let n = pack.omitted_for_budget;
                shell = shell.child(notice(
                    NoticeKind::Info,
                    format!(
                        "{n} {} left out to stay under {} tokens. Memories are never cut; raise the budget to include more.",
                        if n == 1 { "memory" } else { "memories" },
                        self.pack.budget.label()
                    ),
                    &theme,
                ));
            }
            if self.pack.format == PackFormat::Citations {
                shell = shell.child(notice(
                    NoticeKind::Info,
                    "Citations is a digest: one line per memory, not the full text.",
                    &theme,
                ));
            }
            if self.pack.source == PackSource::CurrentView
                && pack.total_matching > PACK_VIEW_FETCH_LIMIT
            {
                shell = shell.child(notice(
                    NoticeKind::Info,
                    format!(
                        "Packs draw from the first {PACK_VIEW_FETCH_LIMIT} memories of this view, in list order. Narrow the filter or pin memories for a precise set."
                    ),
                    &theme,
                ));
            }
        }

        let payload_max_h = (viewport_h * 0.9 - 360.0).clamp(120.0, 380.0);
        let body: AnyElement = if self.pack.loading {
            div()
                .h(px(96.))
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(kit::text::SM))
                .text_color(theme.text_muted)
                .child("Collecting memories…")
                .into_any_element()
        } else if let Some(err) = &self.pack.error {
            notice(NoticeKind::Danger, err.clone(), &theme).into_any_element()
        } else if let Some(pack) = &self.pack.built {
            div()
                .relative()
                .w_full()
                .rounded(px(8.))
                .bg(theme.bg_sunken)
                .border_1()
                .border_color(theme.border_subtle)
                .overflow_hidden()
                .child(
                    div()
                        .id("context-pack-preview")
                        .w_full()
                        .max_h(px(payload_max_h))
                        .overflow_y_scroll()
                        .track_scroll(&self.pack.scroll)
                        .p(px(kit::space::S3))
                        .pr(px(kit::space::S4))
                        .font_family(kit::MONO_FONT)
                        .text_size(px(kit::text::SM))
                        .line_height(px(18.))
                        .text_color(theme.text_primary)
                        .child(SharedString::from(pack.payload.clone())),
                )
                .child(render_vertical_scroll_overlay(
                    self.pack.scroll.clone(),
                    theme.bg_sunken,
                    theme,
                ))
                .into_any_element()
        } else {
            match self.pack.source {
                PackSource::Selected => empty_state(
                    "No memory selected",
                    "Select a memory in the list, or switch the source to Current view.",
                    &theme,
                ),
                PackSource::Pinned => empty_state(
                    "Nothing pinned yet",
                    "Press P on a memory, or use Pin in the inspector, to collect a hand-picked set.",
                    &theme,
                ),
                PackSource::CurrentView => empty_state(
                    "No memories in this view",
                    "Clear a filter or search to give the pack something to draw from.",
                    &theme,
                ),
            }
            .into_any_element()
        };
        shell = shell.child(body);

        let footer: SharedString = match &self.pack.built {
            Some(pack) => {
                let n = pack.included_count();
                let count = if pack.total_matching > n {
                    format!("{n} of {}", format_count(pack.total_matching))
                } else {
                    n.to_string()
                };
                format!(
                    "{count} {} · ≈ {} tokens · {} chars",
                    if pack.total_matching == 1 {
                        "memory"
                    } else {
                        "memories"
                    },
                    format_count(pack.estimated_tokens),
                    format_count(pack.char_count)
                )
                .into()
            }
            None => "Local only · nothing leaves this computer until you paste it".into(),
        };
        shell = shell.footer_note(div().font_features(tabular_nums()).truncate().child(footer));

        let close_entity = entity.clone();
        shell = shell.action(
            button("pack-close", "Close", ButtonKind::Secondary, &theme).on_click(
                move |_, window, cx| {
                    close_entity.update(cx, |app, cx| app.close_context_pack(window, cx));
                },
            ),
        );
        if self.pack.built.is_some() {
            let copy_entity = entity.clone();
            shell = shell.action(
                button("pack-copy", "Copy pack", ButtonKind::Primary, &theme).on_click(
                    move |_, _, cx| {
                        copy_entity.update(cx, |app, cx| app.copy_pack(cx));
                    },
                ),
            );
        } else {
            shell = shell.action(button_disabled(
                "pack-copy",
                "Copy pack",
                "the pack is empty",
                &theme,
            ));
        }

        let dismiss_entity = entity;
        shell.render(
            &theme,
            Rc::new(move |window, cx| {
                dismiss_entity.update(cx, |app, cx| app.close_context_pack(window, cx));
            }),
        )
    }
}

/// `12,345`-style grouping for counts shown in the footer.
pub(super) fn format_count(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (ix, ch) in digits.chars().enumerate() {
        if ix > 0 && (digits.len() - ix).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::format_count;

    #[test]
    fn counts_are_grouped() {
        assert_eq!(format_count(0), "0");
        assert_eq!(format_count(999), "999");
        assert_eq!(format_count(1_000), "1,000");
        assert_eq!(format_count(1_234_567), "1,234,567");
    }
}
