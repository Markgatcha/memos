//! Single-key workbench shortcuts that apply across surfaces. Surface-specific
//! navigation (j/k, arrows, Enter) stays in `on_root_key_down`.

use std::rc::Rc;

use gpui::{AnyElement, Context, IntoElement, ParentElement, Styled, Window, div, px};

use super::{MemOSApp, WorkspaceSurface};
use crate::core::model::ViewMode;
use crate::ui::views::keycap;
use crate::ui::views::kit::{self, ModalShell, section_label};

impl MemOSApp {
    /// Returns `true` when the key was handled. Called only when no text field
    /// or overlay has focus and no modifier is held.
    pub(super) fn handle_workbench_key(
        &mut self,
        key: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        match key {
            "c" => self.open_context_pack(None, window, cx),
            "p" => self.toggle_pin_selected(cx),
            "x" => self.compare_selected(window, cx),
            "i" => self.toggle_inspector(cx),
            "f" if self.active_surface == WorkspaceSurface::Memories
                && self.view_mode == ViewMode::Graph =>
            {
                self.graph_view.update(cx, |g, cx| g.toggle_focus_mode(cx));
            }
            "=" | "+" if self.is_graph_visible() => {
                self.graph_view.update(cx, |g, cx| g.zoom_by(1.25, cx));
            }
            "-" if self.is_graph_visible() => {
                self.graph_view.update(cx, |g, cx| g.zoom_by(0.8, cx));
            }
            "0" if self.is_graph_visible() => {
                self.graph_view.update(cx, |g, cx| g.fit_view(cx));
            }
            _ => return false,
        }
        true
    }

    fn is_graph_visible(&self) -> bool {
        self.active_surface == WorkspaceSurface::Memories && self.view_mode == ViewMode::Graph
    }

    /// Switch between standard and large reading text (persisted).
    pub(super) fn toggle_reading_size(&mut self, cx: &mut Context<Self>) {
        self.settings.large_reading_text = !self.settings.large_reading_text;
        let large = self.settings.large_reading_text;
        if !self.smoke_exit_after_first_frame {
            self.settings.save_async();
        }
        self.detail_view
            .update(cx, |d, cx| d.set_large_text(large, cx));
        self.set_notice(
            if large {
                "Reading text: large"
            } else {
                "Reading text: standard"
            },
            cx,
        );
    }

    /// Show or hide the inspector without losing the selection.
    pub(super) fn toggle_inspector(&mut self, cx: &mut Context<Self>) {
        if self.detail_open {
            self.detail_open = false;
            cx.notify();
        } else if let Some(id) = self.selected_id.clone() {
            self.select_memory(id, false, cx);
        } else {
            self.set_notice("Select a memory to inspect it", cx);
        }
    }
}

impl MemOSApp {
    /// A node picked on the graph canvas becomes the selection (so P, C and X
    /// act on it) without opening the full inspector over the graph.
    pub(super) fn inspect_from_graph(&mut self, id: Option<String>, cx: &mut Context<Self>) {
        self.selected_id = id.clone();
        self.load_graph_card_detail(id.clone(), cx);
        let has_selection = id.is_some();
        self.list_view
            .update(cx, |l, cx| l.set_selected(id.clone(), false, cx));
        let write_mode = self.settings.write_mode;
        self.palette.update(cx, |p, cx| {
            p.set_write_context(write_mode, has_selection, cx)
        });
        if self.detail_open {
            match id {
                Some(id) => self.select_memory(id, false, cx),
                None => self.detail_open = false,
            }
        }
        cx.notify();
    }
}

/// Grouped shortcut table; `Mod` is Cmd on macOS and Ctrl elsewhere.
/// A titled group of `(action, keys)` rows.
pub(crate) type ShortcutGroup = (&'static str, Vec<(&'static str, Vec<&'static str>)>);

pub(crate) fn shortcut_groups() -> Vec<ShortcutGroup> {
    let m = if cfg!(target_os = "macos") {
        "⌘"
    } else {
        "Ctrl"
    };
    vec![
        (
            "Move around",
            vec![
                ("Next / previous", vec!["J", "K"]),
                ("First / last", vec!["Home", "End"]),
                ("Open in inspector", vec!["Enter"]),
                ("Show or hide inspector", vec!["I"]),
                ("Close pane, dialog or menu", vec!["Esc"]),
            ],
        ),
        (
            "Go to",
            vec![
                ("List", vec![m, "1"]),
                ("Graph", vec![m, "2"]),
                ("Today", vec![m, "3"]),
                ("Review", vec![m, "4"]),
                ("Command palette", vec![m, "K"]),
            ],
        ),
        (
            "Search",
            vec![
                ("Focus search", vec!["/"]),
                ("Search syntax and recent", vec![m, "/"]),
                ("Remove last scope chip", vec!["⌫"]),
            ],
        ),
        (
            "Work with memories",
            vec![
                ("Capture a memory", vec![m, "N"]),
                ("Save capture", vec![m, "Enter"]),
                ("Context pack", vec!["C"]),
                ("Pin to context pack", vec!["P"]),
                ("Compare with conflict", vec!["X"]),
                ("Export", vec![m, "E"]),
            ],
        ),
        (
            "Review queue",
            vec![
                ("Add or remove from batch", vec!["Space"]),
                ("Clear the batch", vec!["Esc"]),
                ("Open the candidate", vec!["Enter"]),
            ],
        ),
        (
            "Graph",
            vec![
                ("Step through nodes", vec!["←", "→"]),
                ("Focus neighborhood", vec!["F"]),
                ("Zoom in / out", vec!["+", "-"]),
                ("Fit to view", vec!["0"]),
                ("Leave focus", vec!["Esc"]),
            ],
        ),
    ]
}

impl MemOSApp {
    pub(super) fn render_shortcut_sheet(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let entity = cx.entity();
        let groups = shortcut_groups();
        let mut columns = [Vec::new(), Vec::new()];
        for (ix, (title, rows)) in groups.into_iter().enumerate() {
            let group = div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(section_label(title, &theme))
                .children(rows.into_iter().map(|(label, keys)| {
                    div()
                        .h(px(24.))
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(kit::space::S3))
                        .child(
                            div()
                                .text_size(px(kit::text::BASE))
                                .text_color(theme.text_primary)
                                .truncate()
                                .child(label),
                        )
                        .child(
                            div()
                                .flex_shrink_0()
                                .flex()
                                .items_center()
                                .gap(px(4.))
                                .children(keys.into_iter().map(|k| keycap(k, &theme))),
                        )
                }));
            columns[if ix % 2 == 0 { 0 } else { 1 }].push(group.into_any_element());
        }
        let [left, right] = columns;
        ModalShell::new("shortcuts-dialog", "Keyboard shortcuts")
            .subtitle("Single keys work whenever a text field doesn't have focus")
            .width(680.)
            .child(
                div()
                    .w_full()
                    .flex()
                    .gap(px(kit::space::S6))
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .flex()
                            .flex_col()
                            .gap(px(kit::space::S4))
                            .children(left),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .flex()
                            .flex_col()
                            .gap(px(kit::space::S4))
                            .children(right),
                    ),
            )
            .render(
                &theme,
                Rc::new(move |window, cx| {
                    entity.update(cx, |app, cx| {
                        app.show_shortcuts_modal = false;
                        window.focus(&app.focus_handle, cx);
                        cx.notify();
                    })
                }),
            )
    }
}

/// Background load for the graph card's full title and link breakdown.
#[derive(Default)]
pub(super) struct GraphCardState {
    pub generation: crate::ui::request::RequestToken,
    pub task: Option<gpui::Task<()>>,
}

impl MemOSApp {
    fn load_graph_card_detail(&mut self, id: Option<String>, cx: &mut Context<Self>) {
        let request = self.graph_card.generation.advance();
        let Some(id) = id else {
            self.graph_card.task = None;
            self.graph_view
                .update(cx, |g, cx| g.set_inspector_detail(None, cx));
            return;
        };
        let db_path = self.resolved_db.path.clone();
        let shared = self.shared_store.clone();
        self.graph_card.task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move { shared.with_store(&db_path, |s| s.load_node_detail(&id)) })
                .await;
            let _ = this.update(cx, |app, cx| {
                if !app.graph_card.generation.is_current(request) {
                    return;
                }
                let detail = match res {
                    Ok(Some(d)) => {
                        let source = if d.summary.trim().is_empty() {
                            d.content.as_str()
                        } else {
                            d.summary.as_str()
                        };
                        crate::telemetry::register_sensitive_text(&d.content);
                        Some(crate::ui::views::graph::InspectorDetail {
                            memory_id: d.id.clone(),
                            title: crate::core::model::make_single_line_preview(source, 200),
                            relations: crate::ui::views::graph::relation_breakdown(
                                d.edges.iter().map(|e| e.relation.as_str()),
                            ),
                        })
                    }
                    // The card falls back to the short graph label.
                    _ => None,
                };
                app.graph_view
                    .update(cx, |g, cx| g.set_inspector_detail(detail, cx));
            });
        }));
    }
}
