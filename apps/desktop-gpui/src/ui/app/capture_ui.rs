//! Quick capture: one field, saved through the MCP writer. Directives such as
//! `#tag`, `ns:` and `type:` fill the structured fields; the full composer is
//! one click away for everything else.

use std::rc::Rc;

use gpui::{
    AnyElement, AppContext, Context, Entity, Focusable, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, Subscription, Window, div, prelude::FluentBuilder, px,
};

use super::{MemOSApp, WriteRetryAction};
use crate::core::capture::{CaptureDraft, parse_capture};
use crate::core::write_bridge::StoreInput;
use crate::ui::views::kit::{
    self, ButtonKind, ModalShell, NoticeKind, button, button_disabled, notice,
};
use crate::ui::views::{InputEvent, TextInput, ThemePalette, keycap};

pub(super) struct CaptureState {
    pub open: bool,
    pub input: Entity<TextInput>,
    pub draft: CaptureDraft,
    pub error: Option<String>,
}

impl CaptureState {
    pub fn new(
        theme: ThemePalette,
        window: &mut Window,
        cx: &mut Context<MemOSApp>,
    ) -> (Self, Subscription) {
        let input = cx.new(|cx| {
            TextInput::new_multiline(
                cx,
                "What should your agents remember?  #tag  ns:work  type:decision",
                theme,
            )
        });
        let sub = cx.subscribe_in(&input, window, |this, _, event, window, cx| match event {
            InputEvent::Changed(text) => {
                this.capture.draft = parse_capture(text);
                this.capture.error = None;
                cx.notify();
            }
            InputEvent::Submit(_) => this.submit_quick_capture(window, cx),
            InputEvent::Cancel => this.close_quick_capture(window, cx),
            InputEvent::MoveUp | InputEvent::MoveDown | InputEvent::BackspaceWhenEmpty => {}
        });
        (
            Self {
                open: false,
                input,
                draft: CaptureDraft::default(),
                error: None,
            },
            sub,
        )
    }
}

impl MemOSApp {
    pub(super) fn open_quick_capture(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.capture.open {
            window.focus(&self.capture.input.focus_handle(cx), cx);
            return;
        }
        if !self.settings.write_mode {
            self.explain_write_mode(window, cx);
            return;
        }
        self.dismiss_popovers(super::PopoverOwner::None, cx);
        self.close_all_modals();
        self.capture.open = true;
        self.capture.error = None;
        self.capture.input.update(cx, |i, cx| i.clear(cx));
        self.capture.draft = CaptureDraft::default();
        let focus = self.capture.input.focus_handle(cx);
        window.focus(&focus, cx);
        cx.notify();
    }

    /// Read-only stand-in for write commands: say why, then open Settings.
    pub(super) fn explain_write_mode(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_settings_modal(window, cx);
        let msg = if self.writer_preflight.compatible || self.overview.is_none() {
            "Editing is off. Turn on write mode here to capture memories"
        } else {
            "This store needs a migration before it can be edited"
        };
        self.set_notice(msg, cx);
    }

    pub(super) fn close_quick_capture(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.capture.open = false;
        window.focus(&self.focus_handle, cx);
        cx.notify();
    }

    /// Namespace and type the capture will use once defaults are applied.
    fn capture_effective_fields(&self) -> (String, String) {
        let ns = self
            .capture
            .draft
            .namespace
            .clone()
            .or_else(|| self.filter.namespace.clone())
            .unwrap_or_else(|| "default".to_string());
        let ty = self
            .capture
            .draft
            .node_type
            .clone()
            .or_else(|| self.filter.node_type.clone())
            .unwrap_or_else(|| "fact".to_string());
        (ns, ty)
    }

    pub(super) fn submit_quick_capture(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.capture.open {
            return;
        }
        if self.write_in_flight {
            self.capture.error =
                Some("Still saving the previous memory. Try again in a moment.".into());
            cx.notify();
            return;
        }
        if !self.settings.write_mode {
            self.capture.open = false;
            self.explain_write_mode(window, cx);
            return;
        }
        let draft = parse_capture(self.capture.input.read(cx).text());
        if let Some(err) = draft.validation_error() {
            self.capture.error = Some(err.to_string());
            cx.notify();
            return;
        }
        self.capture.draft = draft.clone();
        let (namespace, node_type) = self.capture_effective_fields();
        let input = StoreInput {
            content: draft.content,
            node_type: Some(node_type),
            tags: draft.tags,
            namespace: if namespace == "default" {
                None
            } else {
                Some(namespace)
            },
            pool: Some("event".to_string()),
            context: None,
        };
        self.capture.open = false;
        window.focus(&self.focus_handle, cx);
        self.execute_write_action(WriteRetryAction::Store { input }, cx);
    }

    /// Move the draft into the full composer for fields quick capture hides.
    fn expand_capture_to_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let draft = parse_capture(self.capture.input.read(cx).text());
        let (namespace, node_type) = {
            self.capture.draft = draft.clone();
            self.capture_effective_fields()
        };
        self.capture.open = false;
        self.open_new_memory_composer(window, cx);
        self.composer_type = node_type;
        let tags = draft.tags.join(", ");
        let ns = if namespace == "default" {
            String::new()
        } else {
            namespace
        };
        self.composer_content_input
            .update(cx, |i, cx| i.set_text(draft.content, cx));
        self.composer_tags_input
            .update(cx, |i, cx| i.set_text(tags, cx));
        self.composer_namespace_input
            .update(cx, |i, cx| i.set_text(ns, cx));
        cx.notify();
    }

    pub(super) fn render_quick_capture(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let entity = cx.entity();
        let (namespace, node_type) = self.capture_effective_fields();
        let known_tags: Vec<&str> = self
            .overview
            .as_ref()
            .map(|o| o.tags.iter().map(|t| t.name.as_str()).collect())
            .unwrap_or_default();

        let field = |label: &'static str, value: String, hint: Option<&'static str>| {
            div()
                .flex()
                .items_baseline()
                .gap(px(6.))
                .child(
                    div()
                        .text_size(px(kit::text::SM))
                        .text_color(theme.text_muted)
                        .child(label),
                )
                .child(
                    div()
                        .text_size(px(kit::text::SM))
                        .text_color(theme.text_primary)
                        .child(SharedString::from(value)),
                )
                .when_some(hint, |el, h| {
                    el.child(
                        div()
                            .text_size(px(kit::text::XS))
                            .text_color(theme.text_muted)
                            .child(h),
                    )
                })
        };

        let type_hint = if self.capture.draft.node_type.is_some() {
            None
        } else {
            Some("default")
        };
        let ns_hint = if self.capture.draft.namespace.is_some() {
            None
        } else if self.filter.namespace.is_some() {
            Some("from current filter")
        } else {
            Some("default")
        };

        let tags_el = if self.capture.draft.tags.is_empty() {
            field("Tags", "none".to_string(), None).into_any_element()
        } else {
            div()
                .flex()
                .flex_wrap()
                .items_baseline()
                .gap(px(6.))
                .child(
                    div()
                        .text_size(px(kit::text::SM))
                        .text_color(theme.text_muted)
                        .child("Tags"),
                )
                .children(self.capture.draft.tags.iter().map(|t| {
                    let is_new = !known_tags.iter().any(|k| k.eq_ignore_ascii_case(t));
                    div()
                        .flex()
                        .items_baseline()
                        .gap(px(3.))
                        .child(
                            div()
                                .text_size(px(kit::text::SM))
                                .text_color(theme.text_primary)
                                .child(SharedString::from(format!("#{t}"))),
                        )
                        .when(is_new, |el| {
                            el.child(
                                div()
                                    .text_size(px(kit::text::XS))
                                    .text_color(theme.text_muted)
                                    .child("new"),
                            )
                        })
                }))
                .into_any_element()
        };

        let mut shell = ModalShell::new("quick-capture-dialog", "Capture memory")
            .subtitle("Saved through the MemOS writer, with provenance and history intact")
            .width(560.)
            .child(div().w_full().child(self.capture.input.clone()))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_x(px(kit::space::S4))
                    .gap_y(px(kit::space::S1))
                    .child(field("Type", node_type, type_hint))
                    .child(field("Namespace", namespace, ns_hint))
                    .child(tags_el),
            );
        if let Some(err) = &self.capture.error {
            shell = shell.child(notice(NoticeKind::Danger, err.clone(), &theme));
        }
        let submit_hint = if cfg!(target_os = "macos") {
            "⌘ Enter"
        } else {
            "Ctrl Enter"
        };
        shell = shell.footer_note(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .child(keycap(submit_hint, &theme))
                .child("to save"),
        );
        let more_entity = entity.clone();
        shell = shell.action(
            button(
                "capture-more-fields",
                "More fields…",
                ButtonKind::Subtle,
                &theme,
            )
            .on_click(move |_, window, cx| {
                more_entity.update(cx, |app, cx| app.expand_capture_to_composer(window, cx));
            }),
        );
        if self.write_in_flight {
            shell = shell.action(button_disabled(
                "capture-save",
                "Saving…",
                "a save is in progress",
                &theme,
            ));
        } else {
            let save_entity = entity.clone();
            shell = shell.action(
                button("capture-save", "Save", ButtonKind::Primary, &theme).on_click(
                    move |_, window, cx| {
                        save_entity.update(cx, |app, cx| app.submit_quick_capture(window, cx));
                    },
                ),
            );
        }
        shell.render(
            &theme,
            Rc::new(move |window, cx| {
                entity.update(cx, |app, cx| app.close_quick_capture(window, cx));
            }),
        )
    }
}
