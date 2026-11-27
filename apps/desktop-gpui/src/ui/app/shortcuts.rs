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
        if let Some(id) = id {
            let inspector_was_open = self.detail_open;
            self.select_memory(id, false, cx);
            self.detail_open = inspector_was_open;
        } else {
            self.close_detail(cx);
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
            ],
        ),
        (
            "Graph",
            vec![
                ("Step through nodes", vec!["←", "→"]),
                ("Focus neighborhood", vec!["F"]),
                ("Zoom in / out", vec!["+", "-"]),
                ("Fit to view", vec!["0"]),
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
