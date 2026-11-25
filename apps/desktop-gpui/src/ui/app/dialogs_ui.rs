//! Form dialogs on the shared kit: the full memory editor, Ingest, Forget and
//! Save view. Behavior is unchanged from the hand-built versions they replace;
//! layout, button order, validation placement and copy are now consistent.

use std::path::PathBuf;
use std::rc::Rc;

use gpui::{
    AnyElement, Context, Entity, ParentElement, SharedString, StatefulInteractiveElement, Styled,
    Subscription, Task, Window, div, px,
};

use super::MemOSApp;
use crate::core::write_bridge::{IngestResult, parse_extensions_csv};
use crate::ui::request::RequestToken;
use crate::ui::views::kit::{
    self, ButtonKind, ModalShell, NoticeKind, Segment, button, button_disabled, checkbox, field,
    notice, segmented,
};
use crate::ui::views::{InputEvent, TextInput, tabular_nums};

/// What the Ingest path points at, checked off the UI thread.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PathKind {
    File,
    Folder,
    Missing,
}

#[derive(Default)]
pub(super) struct IngestUiState {
    pub path_kind: Option<PathKind>,
    pub generation: RequestToken,
    pub task: Option<Task<()>>,
}

impl IngestUiState {
    pub fn subscribe(
        input: &Entity<TextInput>,
        window: &mut Window,
        cx: &mut Context<MemOSApp>,
    ) -> Subscription {
        cx.subscribe_in(input, window, |this, _, event, _window, cx| {
            if let InputEvent::Changed(text) = event {
                this.check_ingest_path(text.clone(), cx);
            }
        })
    }
}

/// One sentence describing exactly what Ingest will do before it starts.
pub(crate) fn describe_ingest_plan(
    kind: Option<PathKind>,
    recursive: bool,
    extensions: &[String],
    namespace: &str,
    chunk_chars: Option<usize>,
) -> String {
    let ns = if namespace.trim().is_empty() {
        "default"
    } else {
        namespace.trim()
    };
    let exts = if extensions.is_empty() {
        "supported".to_string()
    } else {
        extensions.join(", ")
    };
    let what = match kind {
        Some(PathKind::File) => "Reads this file".to_string(),
        Some(PathKind::Folder) if recursive => {
            format!("Reads {exts} files in this folder and its subfolders")
        }
        Some(PathKind::Folder) => format!("Reads {exts} files in this folder (not subfolders)"),
        Some(PathKind::Missing) | None => return String::new(),
    };
    let it = if kind == Some(PathKind::File) {
        "it"
    } else {
        "them"
    };
    let chunks = match chunk_chars {
        Some(n) => format!(", splits {it} into chunks of about {n} characters"),
        None => format!(", splits {it} into the writer's default chunk size"),
    };
    format!(
        "{what}{chunks}, and stores the chunks in \u{201c}{ns}\u{201d}. Unchanged files are skipped."
    )
}

fn ingest_result_line(r: &IngestResult) -> String {
    let mut parts = Vec::new();
    for (n, label) in [
        (r.added, "added"),
        (r.updated, "updated"),
        (r.unchanged, "unchanged"),
        (r.removed, "removed"),
        (r.skipped, "skipped"),
    ] {
        if n > 0 {
            parts.push(format!("{n} {label}"));
        }
    }
    if parts.is_empty() {
        parts.push("No files changed".to_string());
    }
    format!("{} · {} chunks", parts.join(" · "), r.chunks)
}

impl MemOSApp {
    fn check_ingest_path(&mut self, raw: String, cx: &mut Context<Self>) {
        let request = self.ingest_ui.generation.advance();
        let trimmed = raw.trim().to_string();
        if trimmed.is_empty() {
            self.ingest_ui.path_kind = None;
            cx.notify();
            return;
        }
        self.ingest_ui.task = Some(cx.spawn(async move |this, cx| {
            let path = PathBuf::from(trimmed);
            let kind = cx
                .background_executor()
                .spawn(async move {
                    match std::fs::metadata(&path) {
                        Ok(m) if m.is_dir() => PathKind::Folder,
                        Ok(_) => PathKind::File,
                        Err(_) => PathKind::Missing,
                    }
                })
                .await;
            let _ = this.update(cx, |app, cx| {
                if app.ingest_ui.generation.is_current(request) {
                    app.ingest_ui.path_kind = Some(kind);
                    cx.notify();
                }
            });
        }));
    }

    fn close_ingest(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.show_ingest_modal = false;
        window.focus(&self.focus_handle, cx);
        cx.notify();
    }

    pub(super) fn render_ingest_dialog(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let entity = cx.entity();
        let ns = self
            .ingest_namespace_input
            .read(cx)
            .text()
            .trim()
            .to_string();
        let exts = parse_extensions_csv(self.ingest_extensions_input.read(cx).text());
        let chunk = super::parse_ingest_chunk_chars(self.ingest_chunk_input.read(cx).text())
            .ok()
            .flatten();
        let kind = self.ingest_ui.path_kind;
        let plan = describe_ingest_plan(kind, self.ingest_recursive, &exts, &ns, chunk);
        let path_hint: Option<SharedString> = match kind {
            Some(PathKind::File) => Some("File".into()),
            Some(PathKind::Folder) => Some("Folder".into()),
            Some(PathKind::Missing) => Some("Nothing at this path".into()),
            None => None,
        };

        let presets = ["documents", "default"]
            .into_iter()
            .map(|preset| {
                let e = entity.clone();
                Segment::new(preset, ns == preset, move |_, _, cx| {
                    e.update(cx, |app, cx| {
                        app.ingest_namespace_input
                            .update(cx, |i, cx| i.set_text(preset, cx));
                        cx.notify();
                    })
                })
            })
            .collect();

        let e_browse = entity.clone();
        let mut shell = ModalShell::new("ingest-dialog", "Ingest files")
            .subtitle("Chunks documents and stores them through the MemOS writer")
            .width(560.)
            .child(field(
                "File or folder",
                path_hint,
                div()
                    .w_full()
                    .flex()
                    .items_center()
                    .gap(px(kit::space::S2))
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .child(self.ingest_path_input.clone()),
                    )
                    .child(
                        button("ingest-browse", "Browse…", ButtonKind::Secondary, &theme).on_click(
                            move |_, _, cx| {
                                e_browse.update(cx, |app, cx| app.browse_ingest_path(cx))
                            },
                        ),
                    ),
                &theme,
            ))
            .child(field(
                "Namespace",
                None,
                div()
                    .w_full()
                    .flex()
                    .items_center()
                    .gap(px(kit::space::S2))
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .child(self.ingest_namespace_input.clone()),
                    )
                    .child(segmented(
                        "ingest-ns-preset",
                        "Namespace presets",
                        presets,
                        &theme,
                    )),
                &theme,
            ))
            .child(
                div()
                    .w_full()
                    .flex()
                    .gap(px(kit::space::S3))
                    .child(div().flex_1().min_w(px(0.)).child(field(
                        "Extensions",
                        Some("comma-separated".into()),
                        self.ingest_extensions_input.clone(),
                        &theme,
                    )))
                    .child(div().w(px(160.)).child(field(
                        "Chunk size",
                        Some("characters".into()),
                        self.ingest_chunk_input.clone(),
                        &theme,
                    ))),
            )
            .child({
                let e = entity.clone();
                checkbox(
                    "ingest-recursive",
                    self.ingest_recursive,
                    "Include subfolders",
                    &theme,
                )
                .on_click(move |_, _, cx| {
                    e.update(cx, |app, cx| {
                        app.ingest_recursive = !app.ingest_recursive;
                        cx.notify();
                    })
                })
            });

        if !plan.is_empty() && self.ingest_result.is_none() && !self.ingest_in_flight {
            shell = shell.child(notice(NoticeKind::Info, plan, &theme));
        }
        if self.ingest_in_flight {
            shell = shell.child(notice(
                NoticeKind::Info,
                "Ingesting… large folders can take up to a minute. You can keep browsing.",
                &theme,
            ));
        }
        if let Some(r) = &self.ingest_result {
            shell = shell.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(
                        div()
                            .text_size(px(kit::text::BASE))
                            .font_weight(gpui::FontWeight::MEDIUM)
                            .text_color(theme.text_primary)
                            .child("Done"),
                    )
                    .child(
                        div()
                            .text_size(px(kit::text::SM))
                            .font_features(tabular_nums())
                            .text_color(theme.text_secondary)
                            .child(SharedString::from(ingest_result_line(r))),
                    ),
            );
            if r.errors > 0 {
                shell = shell.child(notice(
                    NoticeKind::Warning,
                    format!(
                        "{} file{} could not be read. The writer's log has the details.",
                        r.errors,
                        if r.errors == 1 { "" } else { "s" }
                    ),
                    &theme,
                ));
            }
        }
        if let Some(err) = &self.ingest_error {
            shell = shell.child(notice(NoticeKind::Danger, err.clone(), &theme));
        }

        let e_close = entity.clone();
        shell = shell.action(
            button(
                "ingest-cancel",
                if self.ingest_result.is_some() {
                    "Close"
                } else {
                    "Cancel"
                },
                ButtonKind::Secondary,
                &theme,
            )
            .on_click(move |_, window, cx| {
                e_close.update(cx, |app, cx| app.close_ingest(window, cx))
            }),
        );
        if self.ingest_result.is_some() {
            let e_show = entity.clone();
            let ns_target = if ns.is_empty() {
                "default".to_string()
            } else {
                ns.clone()
            };
            shell = shell.action(
                button("ingest-show", "Show ingested", ButtonKind::Primary, &theme).on_click(
                    move |_, window, cx| {
                        let ns_target = ns_target.clone();
                        e_show.update(cx, |app, cx| {
                            app.close_ingest(window, cx);
                            app.apply_health_fix_filter(
                                crate::core::model::QueryFilter {
                                    namespace: Some(ns_target),
                                    ..Default::default()
                                },
                                cx,
                            );
                        })
                    },
                ),
            );
        } else if self.ingest_in_flight {
            shell = shell.action(button_disabled(
                "ingest-submit",
                "Ingesting…",
                "an ingest is running",
                &theme,
            ));
        } else if kind == Some(PathKind::Missing) {
            shell = shell.action(button_disabled(
                "ingest-submit",
                "Ingest",
                "the path does not exist",
                &theme,
            ));
        } else {
            let e_go = entity.clone();
            shell = shell.action(
                button("ingest-submit", "Ingest", ButtonKind::Primary, &theme).on_click(
                    move |_, window, cx| e_go.update(cx, |app, cx| app.submit_ingest(window, cx)),
                ),
            );
        }
        shell.render(
            &theme,
            Rc::new(move |window, cx| entity.update(cx, |app, cx| app.close_ingest(window, cx))),
        )
    }

    fn close_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.show_composer_modal = false;
        window.focus(&self.focus_handle, cx);
        cx.notify();
    }

    pub(super) fn render_composer_dialog(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let entity = cx.entity();
        let is_edit = self.composer_editing_id.is_some();

        let mut types = vec!["fact", "preference", "decision", "procedure", "note"];
        let custom = (!types.contains(&self.composer_type.as_str())
            && !self.composer_type.trim().is_empty())
        .then(|| self.composer_type.clone());
        if custom.is_some() {
            types.push("custom");
        }
        let type_segments = types
            .into_iter()
            .map(|t| {
                let e = entity.clone();
                let active = if t == "custom" {
                    custom.is_some()
                } else {
                    self.composer_type == t
                };
                let label = if t == "custom" {
                    custom.clone().unwrap_or_default()
                } else {
                    t.to_string()
                };
                Segment::new(label, active, move |_, _, cx| {
                    if t != "custom" {
                        e.update(cx, |app, cx| {
                            app.composer_type = t.to_string();
                            cx.notify();
                        })
                    }
                })
            })
            .collect();
        let pool_segments = ["event", "note", "procedure"]
            .into_iter()
            .map(|p| {
                let e = entity.clone();
                Segment::new(p, self.composer_pool == p, move |_, _, cx| {
                    e.update(cx, |app, cx| {
                        app.composer_pool = p.to_string();
                        cx.notify();
                    })
                })
            })
            .collect();

        let mut shell = ModalShell::new(
            "composer-dialog",
            if is_edit { "Edit memory" } else { "New memory" },
        )
        .subtitle(if is_edit {
            "Saves a new version that supersedes this one; history is kept"
        } else {
            "Saved through the MemOS writer, with provenance and history"
        })
        .width(600.)
        .child(field(
            "Content",
            Some("required".into()),
            self.composer_content_input.clone(),
            &theme,
        ))
        .child(field(
            "Type",
            None,
            segmented("composer-type", "Memory type", type_segments, &theme),
            &theme,
        ))
        .child(field(
            "Pool",
            None,
            segmented("composer-pool", "Memory pool", pool_segments, &theme),
            &theme,
        ))
        .child(field(
            "Tags",
            Some("comma-separated".into()),
            self.composer_tags_input.clone(),
            &theme,
        ))
        .child(
            div()
                .w_full()
                .flex()
                .gap(px(kit::space::S3))
                .child(div().flex_1().min_w(px(0.)).child(field(
                    "Namespace",
                    None,
                    self.composer_namespace_input.clone(),
                    &theme,
                )))
                .child(div().flex_1().min_w(px(0.)).child(field(
                    "Context",
                    Some("optional".into()),
                    self.composer_context_input.clone(),
                    &theme,
                ))),
        );
        if let Some(err) = &self.composer_validation_error {
            shell = shell.child(notice(NoticeKind::Danger, err.clone(), &theme));
        }
        let hint = if cfg!(target_os = "macos") {
            "⌘ Enter to save"
        } else {
            "Ctrl Enter to save"
        };
        shell = shell.footer_note(div().child(hint));
        let e_cancel = entity.clone();
        shell = shell.action(
            button("composer-cancel", "Cancel", ButtonKind::Secondary, &theme).on_click(
                move |_, window, cx| e_cancel.update(cx, |app, cx| app.close_composer(window, cx)),
            ),
        );
        if self.write_in_flight {
            shell = shell.action(button_disabled(
                "composer-save",
                "Saving…",
                "a save is in progress",
                &theme,
            ));
        } else {
            let e_save = entity.clone();
            shell = shell.action(
                button(
                    "composer-save",
                    if is_edit {
                        "Save new version"
                    } else {
                        "Save memory"
                    },
                    ButtonKind::Primary,
                    &theme,
                )
                .on_click(move |_, window, cx| {
                    e_save.update(cx, |app, cx| app.submit_composer(window, cx))
                }),
            );
        }
        shell.render(
            &theme,
            Rc::new(move |window, cx| entity.update(cx, |app, cx| app.close_composer(window, cx))),
        )
    }

    fn cancel_forget(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.forget_confirm_target = None;
        window.focus(&self.focus_handle, cx);
        cx.notify();
    }

    pub(super) fn render_forget_dialog(
        &self,
        target: super::ForgetTarget,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let entity = cx.entity();
        let e_cancel = entity.clone();
        let e_confirm = entity.clone();
        ModalShell::new("forget-dialog", "Forget this memory?")
            .subtitle(format!("[mem:{}]", target.short_id))
            .width(480.)
            .child(
                div()
                    .text_size(px(kit::text::READ))
                    .line_height(px(20.))
                    .text_color(theme.text_primary)
                    .child(SharedString::from(target.preview.clone())),
            )
            .child(notice(
                NoticeKind::Danger,
                "Agents stop recalling it. The writer records the change, but the desktop app cannot bring it back.",
                &theme,
            ))
            .action(
                button("forget-cancel", "Keep it", ButtonKind::Secondary, &theme).on_click(
                    move |_, window, cx| e_cancel.update(cx, |app, cx| app.cancel_forget(window, cx)),
                ),
            )
            .action(if self.write_in_flight {
                button_disabled("forget-confirm", "Forget", "a save is in progress", &theme)
            } else {
                button("forget-confirm", "Forget", ButtonKind::Danger, &theme).on_click(
                    move |_, window, cx| e_confirm.update(cx, |app, cx| app.confirm_forget(window, cx)),
                )
            })
            .render(
                &theme,
                Rc::new(move |window, cx| entity.update(cx, |app, cx| app.cancel_forget(window, cx))),
            )
    }

    fn close_save_view(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.show_save_view_modal = false;
        window.focus(&self.focus_handle, cx);
        cx.notify();
    }

    pub(super) fn render_save_view_dialog(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let entity = cx.entity();
        let desc = crate::core::model::describe_filter_target(&self.filter);
        let desc = desc
            .strip_prefix("Current view · ")
            .unwrap_or(&desc)
            .to_string();
        let e_cancel = entity.clone();
        let e_save = entity.clone();
        ModalShell::new("save-view-dialog", "Save view")
            .subtitle("Keeps this search, filter and sort in the sidebar")
            .width(440.)
            .child(field("Name", None, self.save_view_input.clone(), &theme))
            .child(kit::kv_row("Filters", desc, &theme))
            .action(
                button("save-view-cancel", "Cancel", ButtonKind::Secondary, &theme).on_click(
                    move |_, window, cx| {
                        e_cancel.update(cx, |app, cx| app.close_save_view(window, cx))
                    },
                ),
            )
            .action(
                button(
                    "save-view-confirm",
                    "Save view",
                    ButtonKind::Primary,
                    &theme,
                )
                .on_click(move |_, window, cx| {
                    e_save.update(cx, |app, cx| app.confirm_save_view(window, cx))
                }),
            )
            .render(
                &theme,
                Rc::new(move |window, cx| {
                    entity.update(cx, |app, cx| app.close_save_view(window, cx))
                }),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ingest_plan_reads_like_a_sentence() {
        let exts = vec!["md".to_string(), "txt".to_string()];
        assert_eq!(
            describe_ingest_plan(Some(PathKind::Folder), true, &exts, "documents", Some(1200)),
            "Reads md, txt files in this folder and its subfolders, splits them into chunks of about 1200 characters, and stores the chunks in \u{201c}documents\u{201d}. Unchanged files are skipped."
        );
        assert!(
            describe_ingest_plan(Some(PathKind::File), false, &exts, "", None)
                .starts_with("Reads this file, splits it into the writer's default chunk size, and stores the chunks in \u{201c}default\u{201d}")
        );
        assert_eq!(
            describe_ingest_plan(Some(PathKind::Missing), true, &exts, "x", None),
            ""
        );
        assert_eq!(describe_ingest_plan(None, true, &exts, "x", None), "");
    }

    #[test]
    fn ingest_results_skip_zero_counts() {
        let r = IngestResult {
            added: 3,
            updated: 0,
            unchanged: 10,
            removed: 0,
            skipped: 1,
            errors: 0,
            chunks: 42,
        };
        assert_eq!(
            ingest_result_line(&r),
            "3 added · 10 unchanged · 1 skipped · 42 chunks"
        );
        assert_eq!(
            ingest_result_line(&IngestResult::default()),
            "No files changed · 0 chunks"
        );
    }
}
