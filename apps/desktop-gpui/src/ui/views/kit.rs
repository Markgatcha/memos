//! Small shared building blocks for the desktop workbench.
//!
//! These exist because the same button, dialog and label styling was being
//! hand-rolled in dozens of places with slightly different heights, radii and
//! focus treatments. New surfaces use these; older surfaces migrate as they are
//! touched. Keep the set small: a primitive earns its place only when it is
//! repeated.

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, Div, ElementId, FontWeight, InteractiveElement, IntoElement,
    MouseButton, ParentElement, Role, SharedString, Stateful, StatefulInteractiveElement, Styled,
    Window, div, prelude::FluentBuilder, px,
};

use crate::ui::views::{ThemePalette, UiIcon, render_ui_icon, tabular_nums};

/// Type scale (px). Base UI text is 13; metadata 12; small labels 11.
pub mod text {
    pub const XS: f32 = 11.0;
    pub const SM: f32 = 12.0;
    pub const BASE: f32 = 13.0;
    pub const READ: f32 = 14.0;
    pub const TITLE: f32 = 20.0;
    pub const DIALOG_TITLE: f32 = 16.0;
}

/// 4 px spacing scale.
pub mod space {
    pub const S1: f32 = 4.0;
    pub const S2: f32 = 8.0;
    pub const S3: f32 = 12.0;
    pub const S4: f32 = 16.0;
    pub const S5: f32 = 20.0;
    pub const S6: f32 = 24.0;
}

/// Monospace family for ids, hashes and payload previews. "Consolas" only
/// exists on Windows; use each platform's stock monospace face.
#[cfg(target_os = "windows")]
pub const MONO_FONT: &str = "Consolas";
#[cfg(target_os = "macos")]
pub const MONO_FONT: &str = "Menlo";
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub const MONO_FONT: &str = "DejaVu Sans Mono";

/// Standard control height for buttons and segmented controls.
pub const CONTROL_H: f32 = 28.0;
pub const CONTROL_RADIUS: f32 = 6.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ButtonKind {
    /// The one action a surface exists for. At most one per dialog.
    Primary,
    /// Bordered neutral action.
    Secondary,
    /// Borderless; for toolbars and low-emphasis actions.
    Subtle,
    /// Destructive. Text-colored, never a filled red block.
    Danger,
}

/// Text button. Attach `.on_click(...)` at the call site.
pub fn button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    kind: ButtonKind,
    theme: &ThemePalette,
) -> Stateful<Div> {
    let label: SharedString = label.into();
    let theme = *theme;
    let base = div()
        .id(id)
        .focusable()
        .role(Role::Button)
        .aria_label(label.clone())
        .h(px(CONTROL_H))
        .px(px(10.))
        .flex_shrink_0()
        .rounded(px(CONTROL_RADIUS))
        .border_1()
        .cursor_pointer()
        .flex()
        .items_center()
        .justify_center()
        .gap(px(6.))
        .text_size(px(text::BASE))
        .whitespace_nowrap();
    let styled = match kind {
        ButtonKind::Primary => base
            .bg(theme.accent)
            .border_color(theme.accent)
            .text_color(theme.primary_btn_fg)
            .font_weight(FontWeight::MEDIUM)
            .hover(|s| s.opacity(0.9))
            .focus_visible(move |s| s.border_color(theme.text_primary)),
        ButtonKind::Secondary => base
            .bg(theme.bg_elevated)
            .border_color(theme.border)
            .text_color(theme.text_primary)
            .hover(move |s| s.bg(theme.bg_selected))
            .focus_visible(move |s| s.border_color(theme.accent)),
        ButtonKind::Subtle => base
            .border_color(gpui::transparent_black())
            .text_color(theme.text_secondary)
            .hover(move |s| s.bg(theme.bg_hover).text_color(theme.text_primary))
            .focus_visible(move |s| s.border_color(theme.accent)),
        ButtonKind::Danger => base
            .border_color(theme.border)
            .text_color(theme.danger)
            .hover(move |s| s.bg(theme.danger_soft))
            .focus_visible(move |s| s.border_color(theme.danger)),
    };
    styled.child(label)
}

/// Button that cannot be pressed right now. Keeps its label readable and says
/// why through the accessible label instead of silently doing nothing.
pub fn button_disabled(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    reason: &str,
    theme: &ThemePalette,
) -> Stateful<Div> {
    let label: SharedString = label.into();
    div()
        .id(id)
        .role(Role::Button)
        .aria_label(SharedString::from(format!(
            "{label} (unavailable: {reason})"
        )))
        .h(px(CONTROL_H))
        .px(px(10.))
        .flex_shrink_0()
        .rounded(px(CONTROL_RADIUS))
        .border_1()
        .border_color(theme.border_subtle)
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(text::BASE))
        .text_color(theme.text_muted)
        .whitespace_nowrap()
        .child(label)
}

/// Square icon-only button. `aria` doubles as the tooltip text at call sites.
pub fn icon_button(
    id: impl Into<ElementId>,
    icon: UiIcon,
    aria: impl Into<SharedString>,
    theme: &ThemePalette,
) -> Stateful<Div> {
    let theme = *theme;
    div()
        .id(id)
        .focusable()
        .role(Role::Button)
        .aria_label(aria.into())
        .w(px(CONTROL_H))
        .h(px(CONTROL_H))
        .flex_shrink_0()
        .rounded(px(CONTROL_RADIUS))
        .border_1()
        .border_color(gpui::transparent_black())
        .cursor_pointer()
        .flex()
        .items_center()
        .justify_center()
        .hover(move |s| s.bg(theme.bg_hover))
        .focus_visible(move |s| s.border_color(theme.accent))
        .child(render_ui_icon(icon, 14.0, theme.text_secondary))
}

/// Boxed click handler, as stored by controls that own several callbacks.
pub type ClickHandler = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// One option in a [`segmented`] control.
pub struct Segment {
    pub label: SharedString,
    pub active: bool,
    pub on_click: ClickHandler,
}

impl Segment {
    pub fn new(
        label: impl Into<SharedString>,
        active: bool,
        on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            label: label.into(),
            active,
            on_click: Box::new(on_click),
        }
    }
}

/// Compact segmented control (tabs within a dialog or toolbar).
pub fn segmented(
    id_prefix: &'static str,
    aria: impl Into<SharedString>,
    segments: Vec<Segment>,
    theme: &ThemePalette,
) -> AnyElement {
    let theme = *theme;
    div()
        .id(id_prefix)
        .role(Role::TabList)
        .aria_label(aria.into())
        .flex_shrink_0()
        .p(px(2.))
        .rounded(px(CONTROL_RADIUS + 1.0))
        .bg(theme.bg_sunken)
        .border_1()
        .border_color(theme.border_subtle)
        .flex()
        .items_center()
        .gap(px(2.))
        .children(segments.into_iter().enumerate().map(|(ix, seg)| {
            let active = seg.active;
            let on_click = seg.on_click;
            div()
                .id((id_prefix, ix))
                .focusable()
                .role(Role::Tab)
                .aria_label(seg.label.clone())
                .aria_selected(active)
                .h(px(CONTROL_H - 6.0))
                .px(px(9.))
                .rounded(px(CONTROL_RADIUS - 1.0))
                .border_1()
                .border_color(gpui::transparent_black())
                .cursor_pointer()
                .flex()
                .items_center()
                .text_size(px(text::SM))
                .whitespace_nowrap()
                .when(active, |el| {
                    el.bg(theme.bg_elevated)
                        .text_color(theme.text_primary)
                        .font_weight(FontWeight::MEDIUM)
                })
                .when(!active, |el| {
                    el.text_color(theme.text_muted)
                        .hover(move |s| s.text_color(theme.text_primary))
                })
                .focus_visible(move |s| s.border_color(theme.accent))
                .on_click(move |e, w, cx| on_click(e, w, cx))
                .child(seg.label)
        }))
        .into_any_element()
}

/// Sentence-case label above a group of controls or rows.
pub fn section_label(label: impl Into<SharedString>, theme: &ThemePalette) -> Div {
    div()
        .text_size(px(text::SM))
        .line_height(px(16.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(theme.text_muted)
        .child(label.into())
}

/// Key/value metadata row with aligned tabular values.
pub fn kv_row(
    key: impl Into<SharedString>,
    value: impl Into<SharedString>,
    theme: &ThemePalette,
) -> Div {
    div()
        .w_full()
        .min_w(px(0.))
        .flex()
        .items_baseline()
        .gap(px(space::S3))
        .child(
            div()
                .w(px(96.))
                .flex_shrink_0()
                .text_size(px(text::SM))
                .text_color(theme.text_muted)
                .child(key.into()),
        )
        .child(
            div()
                .flex_1()
                .min_w(px(0.))
                .text_size(px(text::SM))
                .font_features(tabular_nums())
                .text_color(theme.text_primary)
                .truncate()
                .child(value.into()),
        )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoticeKind {
    Info,
    Warning,
    Danger,
}

/// Inline notice: a hairline-left callout, not a filled banner.
pub fn notice(kind: NoticeKind, body: impl Into<SharedString>, theme: &ThemePalette) -> Div {
    let bar = match kind {
        NoticeKind::Info => theme.border_strong,
        NoticeKind::Warning => theme.accent,
        NoticeKind::Danger => theme.danger,
    };
    div()
        .w_full()
        .min_w(px(0.))
        .pl(px(10.))
        .py(px(2.))
        .border_l_2()
        .border_color(bar)
        .text_size(px(text::SM))
        .line_height(px(17.))
        .text_color(theme.text_secondary)
        .child(body.into())
}

/// Quiet empty state: one sentence of what happened, one of what to do next.
pub fn empty_state(
    title: impl Into<SharedString>,
    hint: impl Into<SharedString>,
    theme: &ThemePalette,
) -> Div {
    div()
        .w_full()
        .py(px(space::S6))
        .flex()
        .flex_col()
        .items_center()
        .gap(px(4.))
        .child(
            div()
                .text_size(px(text::BASE))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.text_primary)
                .child(title.into()),
        )
        .child(
            div()
                .max_w(px(360.))
                .text_size(px(text::SM))
                .line_height(px(17.))
                .text_color(theme.text_muted)
                .text_center()
                .child(hint.into()),
        )
}

/// Small text marker with a leading dot. State is carried by the word, the
/// dot only reinforces it, so color is never the sole signal.
pub fn state_marker(label: impl Into<SharedString>, color: gpui::Hsla) -> Div {
    div()
        .flex_shrink_0()
        .flex()
        .items_center()
        .gap(px(4.))
        .text_size(px(text::XS))
        .text_color(color)
        .child(
            div()
                .w(px(5.))
                .h(px(5.))
                .rounded_full()
                .bg(color)
                .flex_shrink_0(),
        )
        .child(label.into())
}

pub type DismissFn = Rc<dyn Fn(&mut Window, &mut App) + 'static>;

/// Shared dialog frame: scrim, glass panel, title row with close button,
/// scrollable body, and a footer whose right side holds the actions in
/// secondary-then-primary order.
pub struct ModalShell {
    pub id: &'static str,
    pub title: SharedString,
    pub subtitle: Option<SharedString>,
    pub width: f32,
    pub body: Vec<AnyElement>,
    pub footer_note: Option<AnyElement>,
    pub actions: Vec<AnyElement>,
    pub header_extra: Option<AnyElement>,
}

impl ModalShell {
    pub fn new(id: &'static str, title: impl Into<SharedString>) -> Self {
        Self {
            id,
            title: title.into(),
            subtitle: None,
            width: 560.0,
            body: Vec::new(),
            footer_note: None,
            actions: Vec::new(),
            header_extra: None,
        }
    }

    pub fn subtitle(mut self, subtitle: impl Into<SharedString>) -> Self {
        self.subtitle = Some(subtitle.into());
        self
    }

    pub fn width(mut self, width: f32) -> Self {
        self.width = width;
        self
    }

    pub fn child(mut self, el: impl IntoElement) -> Self {
        self.body.push(el.into_any_element());
        self
    }

    pub fn footer_note(mut self, el: impl IntoElement) -> Self {
        self.footer_note = Some(el.into_any_element());
        self
    }

    pub fn action(mut self, el: impl IntoElement) -> Self {
        self.actions.push(el.into_any_element());
        self
    }

    pub fn header_extra(mut self, el: impl IntoElement) -> Self {
        self.header_extra = Some(el.into_any_element());
        self
    }

    pub fn render(self, theme: &ThemePalette, on_dismiss: DismissFn) -> AnyElement {
        let theme = *theme;
        let dismiss_backdrop = on_dismiss.clone();
        let dismiss_close = on_dismiss;
        let has_footer = self.footer_note.is_some() || !self.actions.is_empty();
        div()
            .id(SharedString::from(format!("{}-backdrop", self.id)))
            .absolute()
            .inset_0()
            .bg(theme.glass_scrim)
            .px(px(space::S6))
            .py(px(space::S5))
            .flex()
            .items_center()
            .justify_center()
            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                dismiss_backdrop(window, cx);
            })
            .on_scroll(|_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .id(self.id)
                    .role(Role::Dialog)
                    .aria_label(self.title.clone())
                    .w(px(self.width))
                    .max_w(gpui::relative(0.94))
                    .max_h(gpui::relative(0.92))
                    .rounded(px(12.))
                    .bg(theme.glass_panel)
                    .border_1()
                    .border_color(theme.glass_border)
                    .shadow_lg()
                    .relative()
                    .overflow_hidden()
                    .flex()
                    .flex_col()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .absolute()
                            .top(px(0.))
                            .left(px(12.))
                            .right(px(12.))
                            .h(px(1.))
                            .bg(theme.glass_highlight),
                    )
                    .child(
                        div()
                            .flex_shrink_0()
                            .px(px(space::S5))
                            .pt(px(space::S4))
                            .pb(px(space::S3))
                            .flex()
                            .items_start()
                            .justify_between()
                            .gap(px(space::S3))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w(px(0.))
                                    .flex()
                                    .flex_col()
                                    .gap(px(2.))
                                    .child(
                                        div()
                                            .text_size(px(text::DIALOG_TITLE))
                                            .line_height(px(22.))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(theme.text_primary)
                                            .child(self.title.clone()),
                                    )
                                    .when_some(self.subtitle, |col, sub| {
                                        col.child(
                                            div()
                                                .text_size(px(text::SM))
                                                .line_height(px(16.))
                                                .text_color(theme.text_muted)
                                                .truncate()
                                                .child(sub),
                                        )
                                    }),
                            )
                            .when_some(self.header_extra, |row, el| row.child(el))
                            .child(
                                icon_button(
                                    SharedString::from(format!("{}-close", self.id)),
                                    UiIcon::Close,
                                    SharedString::from(format!("Close {}", self.title)),
                                    &theme,
                                )
                                .on_click(move |_, window, cx| dismiss_close(window, cx)),
                            ),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!("{}-body", self.id)))
                            .flex_1()
                            .min_h(px(0.))
                            .overflow_y_scroll()
                            .px(px(space::S5))
                            .pb(px(if has_footer { space::S3 } else { space::S5 }))
                            .flex()
                            .flex_col()
                            .gap(px(space::S3))
                            .children(self.body),
                    )
                    .when(has_footer, |dialog| {
                        dialog.child(
                            div()
                                .flex_shrink_0()
                                .px(px(space::S5))
                                .py(px(space::S3))
                                .border_t_1()
                                .border_color(theme.border_subtle)
                                .flex()
                                .items_center()
                                .justify_between()
                                .gap(px(space::S3))
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w(px(0.))
                                        .flex()
                                        .items_center()
                                        .text_size(px(text::SM))
                                        .text_color(theme.text_muted)
                                        .font_features(tabular_nums())
                                        .truncate()
                                        .children(self.footer_note),
                                )
                                .child(
                                    div()
                                        .flex_shrink_0()
                                        .flex()
                                        .items_center()
                                        .gap(px(space::S2))
                                        .children(self.actions),
                                ),
                        )
                    }),
            )
            .into_any_element()
    }
}
