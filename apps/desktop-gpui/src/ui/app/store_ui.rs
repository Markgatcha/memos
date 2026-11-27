//! Store switcher: reopen a recently used store or browse for another one.
//!
//! Switching only changes which file this window reads. Nothing is merged,
//! copied or written; the candidate is probed read-only on a background thread
//! before the window commits to it.

use std::path::{Path, PathBuf};
use std::rc::Rc;

use gpui::{
    AnyElement, Context, InteractiveElement, IntoElement, ParentElement, PathPromptOptions, Role,
    SharedString, StatefulInteractiveElement, Styled, Task, Window, div, prelude::FluentBuilder,
    px,
};

use super::MemOSApp;
use crate::core::db::probe_database;
use crate::core::model::QueryFilter;
use crate::core::settings::{DbPathSource, ResolvedDbPath};
use crate::ui::request::RequestToken;
use crate::ui::views::kit::{
    self, ButtonKind, ModalShell, NoticeKind, button, empty_state, notice, section_label,
};
use crate::ui::views::tabular_nums;

#[derive(Default)]
pub(super) struct StoreSwitchState {
    pub open: bool,
    /// Path being probed, if any.
    pub checking: Option<PathBuf>,
    pub error: Option<String>,
    pub generation: RequestToken,
    pub task: Option<Task<()>>,
}

/// `name.db` and its folder, shortened so long paths stay on one line.
pub(crate) fn store_labels(path: &Path) -> (String, String) {
    let name = path
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let folder = path
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let folder = if folder.chars().count() > 56 {
        let tail: String = folder
            .chars()
            .rev()
            .take(54)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        format!("…{tail}")
    } else {
        folder
    };
    (name, folder)
}

impl MemOSApp {
    /// Header slot above the sidebar: which store this window reads, and the
    /// way to switch it. Same width as the sidebar so search stays aligned
    /// with the content column; icon-only in the compact layout.
    pub(super) fn render_header_store_switch(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let compact = self.compact_layout;
        let (name, folder) = store_labels(&self.resolved_db.path);
        let aria: SharedString = format!("Store {name}. Switch store").into();
        let tip: SharedString = if folder.is_empty() {
            format!("{name} · Switch store…").into()
        } else {
            format!("{name} in {folder} · Switch store…").into()
        };
        div()
            .id("header-store-switch")
            .focusable()
            .role(Role::Button)
            .aria_label(aria)
            .aria_expanded(self.store_switch.open)
            .tooltip(crate::ui::views::tooltip_view(tip, theme))
            .flex_shrink_0()
            .w(px(if compact { 40. } else { 204. }))
            .h(px(kit::CONTROL_H + 4.))
            .px(px(if compact { 0. } else { 8. }))
            .rounded(px(6.))
            .border_1()
            .border_color(gpui::transparent_black())
            .cursor_pointer()
            .hover(move |s| s.bg(theme.bg_hover))
            .active(move |s| s.bg(theme.bg_selected))
            .focus_visible(move |s| s.border_color(theme.accent))
            .flex()
            .items_center()
            .when(compact, |el| el.justify_center())
            .gap(px(8.))
            .on_click(cx.listener(|this, _, window, cx| {
                this.open_store_switcher(window, cx);
            }))
            .child(crate::ui::views::render_ui_icon(
                crate::ui::views::UiIcon::Database,
                14.0,
                theme.text_secondary,
            ))
            .when(!compact, |el| {
                el.child(
                    div()
                        .flex_1()
                        .min_w(px(0.))
                        .text_size(px(kit::text::BASE))
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .text_color(theme.text_primary)
                        .truncate()
                        .child(SharedString::from(name)),
                )
                .child(crate::ui::views::render_ui_icon(
                    crate::ui::views::UiIcon::ChevronDown,
                    11.0,
                    theme.text_muted,
                ))
            })
            .into_any_element()
    }

    pub(super) fn open_store_switcher(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dismiss_popovers(super::PopoverOwner::None, cx);
        self.close_all_modals();
        self.store_switch.open = true;
        self.store_switch.error = None;
        self.store_switch.checking = None;
        window.focus(&self.focus_handle, cx);
        cx.notify();
    }

    pub(super) fn close_store_switcher(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.store_switch.open = false;
        self.store_switch.generation.advance();
        self.store_switch.task = None;
        self.store_switch.checking = None;
        window.focus(&self.focus_handle, cx);
        cx.notify();
    }

    /// Record the store that just loaded so the switcher can offer it later.
    pub(super) fn remember_current_store(&mut self) {
        if self.settings.record_recent_store(&self.resolved_db.path)
            && !self.smoke_exit_after_first_frame
        {
            self.settings.save_async();
        }
    }

    fn browse_for_store(&mut self, cx: &mut Context<Self>) {
        let receiver = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Open a MemOS store".into()),
        });
        self.store_switch.task = Some(cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = receiver.await
                && let Some(path) = paths.into_iter().next()
            {
                let _ = this.update(cx, |app, cx| app.try_switch_store(path, cx));
            }
        }));
    }

    /// Probe `path` read-only off the UI thread, then switch if it is a store.
    pub(super) fn try_switch_store(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        if path == self.resolved_db.path {
            self.store_switch.open = false;
            self.set_notice("That store is already open", cx);
            return;
        }
        let request = self.store_switch.generation.advance();
        self.store_switch.checking = Some(path.clone());
        self.store_switch.error = None;
        cx.notify();
        self.store_switch.task = Some(cx.spawn(async move |this, cx| {
            let probe_path = path.clone();
            let res = cx
                .background_executor()
                .spawn(async move { probe_database(&probe_path) })
                .await;
            let _ = this.update(cx, |app, cx| {
                if !app.store_switch.generation.is_current(request) {
                    return;
                }
                app.store_switch.checking = None;
                match res {
                    Ok(summary) => app.switch_store(summary.path, summary.node_count, cx),
                    Err(msg) => {
                        app.store_switch.error = Some(msg);
                        cx.notify();
                    }
                }
            });
        }));
    }

    fn switch_store(&mut self, path: PathBuf, node_count: usize, cx: &mut Context<Self>) {
        self.store_switch.open = false;
        self.resolved_db = ResolvedDbPath {
            path: path.clone(),
            source: DbPathSource::SavedPreference,
        };
        self.settings.preferred_db_path = Some(path.clone());
        self.settings.record_recent_store(&path);
        if !self.smoke_exit_after_first_frame {
            self.settings.save_async();
        }
        // Per-store state goes; settings, theme and layout stay.
        self.shared_store.invalidate();
        let writer_cmd = self.settings.effective_writer_command();
        self.write_bridge.configure(&writer_cmd, &path);
        self.write_bridge_error = None;
        self.close_detail(cx);
        self.pack.items.clear();
        self.pack.built = None;
        let sort = self.filter.sort;
        self.filter = QueryFilter {
            sort,
            ..Default::default()
        };
        self.search_input.update(cx, |i, cx| i.set_text("", cx));
        self.active_saved_view_id = Some("all".to_string());
        self.sidebar.update(cx, |s, cx| {
            s.set_active_saved_view_id(Some("all".into()), cx)
        });
        self.overview = None;
        self.health_report = None;
        self.active_surface = super::WorkspaceSurface::Memories;
        self.sidebar.update(cx, |s, cx| {
            s.set_active_surface(crate::ui::views::sidebar::SidebarSurface::Memories, cx)
        });
        self.spawn_initial_load(cx);
        self.spawn_brief_and_review_badges(cx);
        let (name, _) = store_labels(&path);
        let noun = if node_count == 1 {
            "memory"
        } else {
            "memories"
        };
        self.set_notice(format!("Opened {name} · {node_count} {noun}"), cx);
    }

    pub(super) fn render_store_switcher(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let entity = cx.entity();
        let current = self.resolved_db.path.clone();

        let row = |ix: usize, path: &PathBuf, is_current: bool| {
            let (name, folder) = store_labels(path);
            let checking = self.store_switch.checking.as_deref() == Some(path.as_path());
            let e = entity.clone();
            let target = path.clone();
            div()
                .id(("store-row", ix))
                .focusable()
                .role(Role::Button)
                .aria_label(SharedString::from(format!("Open {name} in {folder}")))
                .w_full()
                .min_w(px(0.))
                .px(px(kit::space::S2))
                .py(px(6.))
                .rounded(px(6.))
                .border_1()
                .border_color(gpui::transparent_black())
                .when(!is_current, |el| {
                    el.cursor_pointer()
                        .hover(move |s| s.bg(theme.bg_hover))
                        .on_click(move |_, _, cx| {
                            let target = target.clone();
                            e.update(cx, |app, cx| app.try_switch_store(target, cx));
                        })
                })
                .focus_visible(move |s| s.border_color(theme.accent))
                .flex()
                .items_center()
                .gap(px(kit::space::S3))
                .child(
                    div()
                        .flex_1()
                        .min_w(px(0.))
                        .flex()
                        .flex_col()
                        .gap(px(1.))
                        .child(
                            div()
                                .text_size(px(kit::text::BASE))
                                .text_color(theme.text_primary)
                                .truncate()
                                .child(SharedString::from(name)),
                        )
                        .child(
                            div()
                                .text_size(px(kit::text::SM))
                                .text_color(theme.text_muted)
                                .truncate()
                                .child(SharedString::from(folder)),
                        ),
                )
                .child(
                    div()
                        .flex_shrink_0()
                        .text_size(px(kit::text::SM))
                        .text_color(theme.text_muted)
                        .child(if is_current {
                            "Open now"
                        } else if checking {
                            "Checking…"
                        } else {
                            ""
                        }),
                )
        };

        let others: Vec<AnyElement> = self
            .settings
            .recent_stores
            .iter()
            .filter(|p| **p != current)
            .enumerate()
            .map(|(ix, p)| row(ix + 1, p, false).into_any_element())
            .collect();

        let mut shell = ModalShell::new("store-switch-dialog", "Switch store")
            .subtitle("Opens another store in this window. Nothing is merged or copied.")
            .width(520.)
            .child(section_label("Current", &theme))
            .child(row(0, &current, true));
        shell = shell.child(section_label("Recent", &theme));
        if others.is_empty() {
            shell = shell.child(empty_state(
                "No other stores yet",
                "Stores you open with Browse appear here for one-click switching.",
                &theme,
            ));
        } else {
            shell = shell.child(div().flex().flex_col().children(others));
        }
        if let Some(err) = &self.store_switch.error {
            shell = shell.child(notice(NoticeKind::Danger, err.clone(), &theme));
        }
        let e_browse = entity.clone();
        let e_close = entity.clone();
        shell = shell
            .footer_note(
                div()
                    .font_features(tabular_nums())
                    .child("Stores always open read-only."),
            )
            .action(
                button(
                    "store-switch-close",
                    "Cancel",
                    ButtonKind::Secondary,
                    &theme,
                )
                .on_click(move |_, window, cx| {
                    e_close.update(cx, |app, cx| app.close_store_switcher(window, cx))
                }),
            )
            .action(
                button(
                    "store-switch-browse",
                    "Browse…",
                    ButtonKind::Primary,
                    &theme,
                )
                .on_click(move |_, _, cx| e_browse.update(cx, |app, cx| app.browse_for_store(cx))),
            );
        shell.render(
            &theme,
            Rc::new(move |window, cx| {
                entity.update(cx, |app, cx| app.close_store_switcher(window, cx))
            }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_labels_split_name_and_shorten_long_folders() {
        let (name, folder) = store_labels(Path::new("/home/me/.memos/memos.db"));
        assert_eq!(name, "memos.db");
        assert_eq!(folder, "/home/me/.memos");
        let long = format!("/{}/store.db", "deep/".repeat(20));
        let (_, folder) = store_labels(Path::new(&long));
        assert!(folder.starts_with('…'));
        assert_eq!(folder.chars().count(), 55);
    }
}
