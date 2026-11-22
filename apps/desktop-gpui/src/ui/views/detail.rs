use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gpui::{
    AnyElement, ClipboardItem, Context, EventEmitter, FontWeight, InteractiveElement, IntoElement,
    MouseButton, ParentElement, Render, Role, ScrollHandle, SharedString,
    StatefulInteractiveElement, Styled, Task, Window, div, point, prelude::FluentBuilder, px,
};

use crate::core::model::{
    EdgeDirection, LinkedEdge, MemoryDetail, format_last_read, format_time_relative_and_absolute,
    format_timestamp_ms,
};
use crate::ui::views::{
    ThemePalette, UiIcon, render_ui_icon, render_vertical_scroll_overlay, status_dot, tabular_nums,
    tooltip_view,
};

#[derive(Clone, Debug)]
pub enum DetailEvent {
    SelectMemory(String),
    RevealInGraph(String),
    PreviewContext,
    EditSelected,
    ForgetSelected,
    Close,
}

pub fn is_sticky_header_visible(scroll_y: f32) -> bool {
    scroll_y >= 56.0
}

pub struct DetailView {
    detail: Option<MemoryDetail>,
    metadata_entries: Arc<Vec<(String, String)>>,
    tags_line: Option<SharedString>,
    entities_line: Option<SharedString>,
    loading: bool,
    error: Option<String>,
    copied_label: Option<&'static str>,
    details_expanded: bool,
    write_mode: bool,
    scroll_handle: ScrollHandle,
    _copy_clear_task: Option<Task<()>>,
    theme: ThemePalette,
}

impl EventEmitter<DetailEvent> for DetailView {}

impl DetailView {
    pub fn new(theme: ThemePalette) -> Self {
        Self {
            detail: None,
            metadata_entries: Arc::new(Vec::new()),
            tags_line: None,
            entities_line: None,
            loading: false,
            error: None,
            copied_label: None,
            details_expanded: false,
            write_mode: false,
            scroll_handle: ScrollHandle::new(),
            _copy_clear_task: None,
            theme,
        }
    }

    pub fn set_write_mode(&mut self, write_mode: bool, cx: &mut Context<Self>) {
        if self.write_mode != write_mode {
            self.write_mode = write_mode;
            cx.notify();
        }
    }

    pub fn set_theme(&mut self, theme: ThemePalette, cx: &mut Context<Self>) {
        self.theme = theme;
        cx.notify();
    }

    pub fn set_loading(&mut self, loading: bool, cx: &mut Context<Self>) {
        self.loading = loading;
        cx.notify();
    }

    pub fn set_detail(&mut self, detail: Option<MemoryDetail>, cx: &mut Context<Self>) {
        let id_changed = self.detail.as_ref().map(|d| &d.id) != detail.as_ref().map(|d| &d.id);
        // Metadata parsing, pretty-printing and token wrapping are expensive
        // and must not run per frame.
        self.metadata_entries = Arc::new(
            detail
                .as_ref()
                .map(|d| format_metadata_entries(&d.metadata_json))
                .unwrap_or_default(),
        );
        self.tags_line = detail.as_ref().and_then(|d| {
            if d.tags.is_empty() {
                None
            } else {
                Some(
                    d.tags
                        .iter()
                        .map(|t| format!("#{t}"))
                        .collect::<Vec<_>>()
                        .join("  ")
                        .into(),
                )
            }
        });
        self.entities_line = detail.as_ref().and_then(|d| {
            if d.entities.is_empty() {
                None
            } else {
                Some(d.entities.join(", ").into())
            }
        });
        self.detail = detail;
        self.loading = false;
        self.error = None;
        self.copied_label = None;
        if id_changed {
            self.scroll_handle.set_offset(point(px(0.), px(0.)));
        }
        cx.notify();
    }

    pub fn detail(&self) -> Option<&MemoryDetail> {
        self.detail.as_ref()
    }

    pub fn set_error(&mut self, err: Option<String>, cx: &mut Context<Self>) {
        self.error = err;
        self.loading = false;
        cx.notify();
    }

    fn flash_copied(&mut self, label: &'static str, cx: &mut Context<Self>) {
        self.copied_label = Some(label);
        cx.notify();
        self._copy_clear_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(1600))
                .await;
            let _ = this.update(cx, |view, cx| {
                view.copied_label = None;
                cx.notify();
            });
        }));
    }

    fn render_meta_row(&self, key: &str, value: String, monospace: bool) -> AnyElement {
        let wrapped = wrap_unbroken_tokens(&value, 32);
        self.render_meta_row_text(key, &wrapped, monospace)
    }

    /// Same as [`Self::render_meta_row`] for values that are already wrapped.
    fn render_meta_row_text(&self, key: &str, wrapped: &str, monospace: bool) -> AnyElement {
        let theme = self.theme;
        let val_el = div()
            .flex_1()
            .min_w(px(0.))
            .overflow_hidden()
            .text_size(px(12.))
            .line_height(px(17.))
            .text_color(theme.text_primary)
            .when(monospace, |el| el.font_family("Consolas"))
            .child(SharedString::from(wrapped.to_string()));

        div()
            .w_full()
            .min_w(px(0.))
            .flex()
            .items_start()
            .gap(px(10.))
            .child(
                div()
                    .w(px(96.))
                    .flex_shrink_0()
                    .truncate()
                    .text_size(px(12.))
                    .line_height(px(17.))
                    .text_color(theme.text_muted)
                    .child(SharedString::from(key.to_string())),
            )
            .child(val_el)
            .into_any_element()
    }

    fn render_time_row(&self, key: &str, value: String) -> AnyElement {
        let theme = self.theme;
        div()
            .w_full()
            .min_w(px(0.))
            .flex()
            .items_start()
            .gap(px(10.))
            .child(
                div()
                    .w(px(96.))
                    .flex_shrink_0()
                    .truncate()
                    .text_size(px(12.))
                    .line_height(px(18.))
                    .text_color(theme.text_muted)
                    .child(SharedString::from(key.to_string())),
            )
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.))
                    .overflow_hidden()
                    .text_size(px(13.))
                    .line_height(px(18.))
                    .font_features(tabular_nums())
                    .text_color(theme.text_primary)
                    .child(SharedString::from(value)),
            )
            .into_any_element()
    }
}

pub fn build_detail_time_rows(detail: &MemoryDetail, now_ms: i64) -> Vec<(&'static str, String)> {
    let mut rows = vec![
        (
            "Created",
            format_time_relative_and_absolute(detail.created_at, now_ms),
        ),
        (
            "Updated",
            format_time_relative_and_absolute(detail.updated_at, now_ms),
        ),
        ("Last read", format_last_read(detail.last_accessed, now_ms)),
        ("Reads", detail.access_count.to_string()),
    ];
    if let Some(ts) = detail.expires_at {
        rows.push(("Expires", format_time_relative_and_absolute(ts, now_ms)));
    }
    if let Some(ts) = detail.valid_from {
        rows.push(("Valid from", format_time_relative_and_absolute(ts, now_ms)));
    }
    if let Some(ts) = detail.valid_to {
        rows.push(("Valid to", format_time_relative_and_absolute(ts, now_ms)));
    }
    rows
}

fn wrap_unbroken_tokens(text: &str, max_run: usize) -> String {
    if max_run < 8 || text.len() <= max_run {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len() + 8);
    for (line_ix, line) in text.split('\n').enumerate() {
        if line_ix > 0 {
            out.push('\n');
        }
        let mut run_len = 0usize;
        for ch in line.chars() {
            if ch.is_whitespace() {
                out.push(ch);
                run_len = 0;
                continue;
            }
            out.push(ch);
            run_len += 1;
            if run_len >= max_run
                || (run_len >= max_run.saturating_sub(8)
                    && matches!(ch, '/' | '\\' | ',' | ':' | ';' | '&' | '=' | '?'))
            {
                out.push('\n');
                run_len = 0;
            }
        }
    }
    out
}

fn format_metadata_entries(raw: &str) -> Vec<(String, String)> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "{}" {
        return Vec::new();
    }
    let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        return vec![("raw".to_string(), wrap_unbroken_tokens(trimmed, 32))];
    };
    let Some(obj) = val.as_object() else {
        let pretty = serde_json::to_string_pretty(&val).unwrap_or_else(|_| trimmed.to_string());
        return vec![("value".to_string(), wrap_unbroken_tokens(&pretty, 32))];
    };
    obj.iter()
        .take(40)
        .map(|(k, v)| {
            let formatted = match v {
                serde_json::Value::Null => "null".to_string(),
                serde_json::Value::Bool(b) => b.to_string(),
                serde_json::Value::Number(n) => n.to_string(),
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Array(arr) => {
                    let all_scalar = arr.iter().all(|item| {
                        matches!(
                            item,
                            serde_json::Value::String(_)
                                | serde_json::Value::Number(_)
                                | serde_json::Value::Bool(_)
                        )
                    });
                    if all_scalar && arr.len() <= 12 {
                        arr.iter()
                            .map(|item| match item {
                                serde_json::Value::String(s) => s.clone(),
                                other => other.to_string(),
                            })
                            .collect::<Vec<_>>()
                            .join(", ")
                    } else {
                        serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string())
                    }
                }
                serde_json::Value::Object(_) => {
                    serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string())
                }
            };
            (k.clone(), wrap_unbroken_tokens(&formatted, 32))
        })
        .collect()
}

fn copy_icon(theme: ThemePalette) -> AnyElement {
    render_ui_icon(UiIcon::Copy, 16.0, theme.text_primary)
}

fn cite_icon(theme: ThemePalette) -> AnyElement {
    render_ui_icon(UiIcon::Citation, 16.0, theme.text_primary)
}

fn eye_icon(theme: ThemePalette) -> AnyElement {
    render_ui_icon(UiIcon::EyeContext, 16.0, theme.text_primary)
}

fn graph_icon(theme: ThemePalette) -> AnyElement {
    render_ui_icon(UiIcon::RevealInGraph, 16.0, theme.text_primary)
}

impl Render for DetailView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let container = div()
            .w_full()
            .min_w(px(0.))
            .h_full()
            .overflow_hidden()
            .bg(theme.bg_panel)
            .border_l_1()
            .border_color(theme.border_subtle)
            .flex()
            .flex_col();

        if let Some(err) = &self.error {
            return container
                .child(
                    div()
                        .h(px(44.))
                        .px(px(16.))
                        .border_b_1()
                        .border_color(theme.border_subtle)
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.danger)
                                .child("Error"),
                        )
                        .child(
                            div()
                                .id("detail-close-err")
                                .focusable()
                                .cursor_pointer()
                                .w(px(28.))
                                .h(px(28.))
                                .rounded(px(6.))
                                .hover(move |s| s.bg(theme.bg_elevated))
                                .focus_visible(move |s| s.border_1().border_color(theme.accent))
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(render_ui_icon(UiIcon::Close, 14.0, theme.text_secondary))
                                .on_click(cx.listener(|_, _, _, cx| {
                                    cx.emit(DetailEvent::Close);
                                })),
                        ),
                )
                .child(
                    div()
                        .p(px(16.))
                        .text_size(px(13.))
                        .text_color(theme.text_muted)
                        .child(err.clone()),
                )
                .into_any_element();
        }

        let Some(detail) = self.detail.clone() else {
            return container
                .child(
                    div()
                        .flex_1()
                        .p(px(20.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_size(px(13.))
                        .text_color(theme.text_muted)
                        .child(if self.loading {
                            "Loading memory…"
                        } else {
                            "Select a memory to inspect"
                        }),
                )
                .into_any_element();
        };

        let content_to_copy = detail.content.clone();
        let citation_to_copy = detail.citation_token.clone();
        let reveal_id = detail.id.clone();

        let header_status: SharedString = if let Some(copied) = self.copied_label {
            copied.into()
        } else {
            detail.node_type.clone().into()
        };
        let header_status_color = if self.copied_label.is_some() {
            theme.success
        } else {
            theme.text_muted
        };

        let contradiction_rows: Vec<AnyElement> = detail
            .contradictions
            .iter()
            .enumerate()
            .map(|(ix, c)| {
                let peer_id = c.peer_id.clone();
                let causal_aria: SharedString = format!(
                    "Open contradicting memory {}: {}",
                    c.peer_short_id, c.status
                )
                .into();
                let header: SharedString = format!("{} · {}", c.status, c.peer_short_id).into();
                let preview: SharedString = c.peer_preview.clone().into();
                div()
                    .id(("detail-contradiction", ix))
                    .focusable()
                    .cursor_pointer()
                    .role(Role::Button)
                    .aria_label(causal_aria)
                    .w_full()
                    .p(px(10.))
                    .rounded(px(6.))
                    .bg(theme.danger_soft)
                    .hover(move |s| s.bg(theme.bg_elevated))
                    .focus_visible(move |s| s.border_1().border_color(theme.accent))
                    .on_click(cx.listener(move |_, _, _, cx| {
                        cx.emit(DetailEvent::SelectMemory(peer_id.clone()));
                    }))
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(
                        div()
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.danger)
                            .child(header),
                    )
                    .child(
                        div()
                            .text_size(px(13.))
                            .line_height(px(18.))
                            .text_color(theme.text_primary)
                            .child(preview),
                    )
                    .into_any_element()
            })
            .collect();

        let edge_rows: Vec<AnyElement> = detail
            .edges
            .iter()
            .enumerate()
            .map(|(ix, edge)| {
                let peer_id = edge.peer_id.clone();
                let arrow = match edge.direction {
                    EdgeDirection::Outgoing => "→",
                    EdgeDirection::Incoming => "←",
                };
                let rel_label: SharedString = if edge.peer_type.is_empty() {
                    format!("{arrow} {}", edge.relation).into()
                } else {
                    format!("{arrow} {} · {}", edge.relation, edge.peer_type).into()
                };
                let preview: SharedString = edge.peer_preview.clone().into();
                div()
                    .id(("detail-edge", ix))
                    .focusable()
                    .cursor_pointer()
                    .w_full()
                    .p(px(10.))
                    .rounded(px(6.))
                    .bg(theme.bg_elevated)
                    .hover(move |s| s.bg(theme.bg_selected))
                    .focus_visible(move |s| s.border_1().border_color(theme.accent))
                    .on_click(cx.listener(move |_, _, _, cx| {
                        cx.emit(DetailEvent::SelectMemory(peer_id.clone()));
                    }))
                    .flex()
                    .flex_col()
                    .gap(px(3.))
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(theme.text_muted)
                            .child(rel_label),
                    )
                    .child(
                        div()
                            .text_size(px(13.))
                            .line_height(px(18.))
                            .text_color(theme.text_primary)
                            .truncate()
                            .child(preview),
                    )
                    .into_any_element()
            })
            .collect();

        let metadata_entries = self.metadata_entries.clone();
        let tags_line: Option<SharedString> = self.tags_line.clone();
        let entities_line: Option<SharedString> = self.entities_line.clone();
        let sticky_scroll_y = (-self.scroll_handle.offset().y.as_f32()).max(0.0);
        let show_sticky_header = is_sticky_header_visible(sticky_scroll_y);
        let sticky_short_id: SharedString = detail.short_id.clone().into();
        let sticky_type: SharedString = detail.node_type.clone().into();
        let sticky_type_color = theme.type_color(&detail.node_type);
        let sticky_content_copy = content_to_copy.clone();
        let sticky_citation_copy = citation_to_copy.clone();

        container
            .child(
                div()
                    .h(px(44.))
                    .px(px(16.))
                    .border_b_1()
                    .border_color(theme.border_subtle)
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(header_status_color)
                            .truncate()
                            .child(header_status),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(4.))
                            .flex_shrink_0()
                            .when(self.write_mode, |row| {
                                row.child(
                                    div()
                                        .id("btn-edit-memory")
                                        .focusable()
                                        .role(Role::Button)
                                        .aria_label("Edit memory")
                                        .tooltip(tooltip_view(
                                            "Edit (creates a new superseding version)",
                                            theme,
                                        ))
                                        .cursor_pointer()
                                        .h(px(26.))
                                        .px(px(8.))
                                        .rounded(px(6.))
                                        .bg(theme.bg_elevated)
                                        .border_1()
                                        .border_color(theme.border_subtle)
                                        .hover(move |s| s.bg(theme.bg_selected))
                                        .focus_visible(move |s| {
                                            s.border_1().border_color(theme.accent)
                                        })
                                        .flex()
                                        .items_center()
                                        .gap(px(5.))
                                        .text_size(px(12.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(theme.text_primary)
                                        .child(render_ui_icon(
                                            UiIcon::Edit,
                                            13.0,
                                            theme.text_secondary,
                                        ))
                                        .child("Edit")
                                        .on_click(cx.listener(|_, _, _, cx| {
                                            cx.emit(DetailEvent::EditSelected);
                                        })),
                                )
                                .child(
                                    div()
                                        .id("btn-forget-memory")
                                        .focusable()
                                        .role(Role::Button)
                                        .aria_label("Forget memory")
                                        .tooltip(tooltip_view("Forget memory", theme))
                                        .cursor_pointer()
                                        .h(px(26.))
                                        .px(px(8.))
                                        .rounded(px(6.))
                                        .bg(theme.bg_elevated)
                                        .border_1()
                                        .border_color(theme.border_subtle)
                                        .hover(move |s| s.bg(theme.danger_soft))
                                        .focus_visible(move |s| {
                                            s.border_1().border_color(theme.accent)
                                        })
                                        .flex()
                                        .items_center()
                                        .gap(px(5.))
                                        .text_size(px(12.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(theme.danger)
                                        .child(render_ui_icon(UiIcon::Forget, 13.0, theme.danger))
                                        .child("Forget")
                                        .on_click(cx.listener(|_, _, _, cx| {
                                            cx.emit(DetailEvent::ForgetSelected);
                                        })),
                                )
                            })
                            .child(
                                div()
                                    .id("btn-context-preview")
                                    .focusable()
                                    .role(Role::Button)
                                    .aria_label("What the AI sees")
                                    .tooltip(tooltip_view("What the AI sees", theme))
                                    .cursor_pointer()
                                    .w(px(28.))
                                    .h(px(28.))
                                    .rounded(px(6.))
                                    .hover(move |s| s.bg(theme.bg_elevated))
                                    .focus_visible(move |s| s.border_1().border_color(theme.accent))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .on_click(cx.listener(|_, _, _, cx| {
                                        cx.emit(DetailEvent::PreviewContext);
                                    }))
                                    .child(eye_icon(theme)),
                            )
                            .child(
                                div()
                                    .id("btn-copy-content")
                                    .focusable()
                                    .role(Role::Button)
                                    .aria_label("Copy content")
                                    .tooltip(tooltip_view("Copy content", theme))
                                    .cursor_pointer()
                                    .w(px(28.))
                                    .h(px(28.))
                                    .rounded(px(6.))
                                    .hover(move |s| s.bg(theme.bg_elevated))
                                    .focus_visible(move |s| s.border_1().border_color(theme.accent))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        cx.write_to_clipboard(ClipboardItem::new_string(
                                            content_to_copy.clone(),
                                        ));
                                        this.flash_copied("Copied content", cx);
                                    }))
                                    .child(copy_icon(theme)),
                            )
                            .child(
                                div()
                                    .id("btn-copy-citation")
                                    .focusable()
                                    .cursor_pointer()
                                    .role(Role::Button)
                                    .aria_label("Copy citation")
                                    .tooltip(tooltip_view("Copy citation", theme))
                                    .w(px(28.))
                                    .h(px(28.))
                                    .rounded(px(6.))
                                    .hover(move |s| s.bg(theme.bg_elevated))
                                    .focus_visible(move |s| s.border_1().border_color(theme.accent))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        cx.write_to_clipboard(ClipboardItem::new_string(
                                            citation_to_copy.clone(),
                                        ));
                                        this.flash_copied("Copied citation", cx);
                                    }))
                                    .child(cite_icon(theme)),
                            )
                            .child(
                                div()
                                    .id("btn-reveal-graph")
                                    .focusable()
                                    .cursor_pointer()
                                    .role(Role::Button)
                                    .aria_label("Reveal in graph")
                                    .tooltip(tooltip_view("Reveal in graph", theme))
                                    .w(px(28.))
                                    .h(px(28.))
                                    .rounded(px(6.))
                                    .hover(move |s| s.bg(theme.bg_elevated))
                                    .focus_visible(move |s| s.border_1().border_color(theme.accent))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .on_click(cx.listener(move |_, _, _, cx| {
                                        cx.emit(DetailEvent::RevealInGraph(reveal_id.clone()));
                                    }))
                                    .child(graph_icon(theme)),
                            )
                            .child(
                                div()
                                    .id("btn-close-detail")
                                    .focusable()
                                    .cursor_pointer()
                                    .role(Role::Button)
                                    .aria_label("Close details")
                                    .tooltip(tooltip_view("Close details (Esc)", theme))
                                    .w(px(28.))
                                    .h(px(28.))
                                    .rounded(px(6.))
                                    .hover(move |s| s.bg(theme.bg_elevated))
                                    .focus_visible(move |s| s.border_1().border_color(theme.accent))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .child(render_ui_icon(
                                        UiIcon::Close,
                                        14.0,
                                        theme.text_secondary,
                                    ))
                                    .on_click(cx.listener(|_, _, _, cx| {
                                        cx.emit(DetailEvent::Close);
                                    })),
                            ),
                    ),
            )
            .child({
                let scroll_handle = self.scroll_handle.clone();
                div()
                    .relative()
                    .w_full()
                    .flex_1()
                    .min_w(px(0.))
                    .min_h(px(0.))
                    .child(
                        div()
                            .id("detail-scroll")
                            .track_scroll(&self.scroll_handle)
                            .on_scroll(cx.listener(|_, _, _, cx| cx.notify()))
                            .w_full()
                            .h_full()
                            .min_w(px(0.))
                            .min_h(px(0.))
                            .overflow_y_scroll()
                            .overflow_x_hidden()
                            .px(px(16.))
                            .py(px(16.))
                            .when(show_sticky_header, |el| el.pt(px(52.)))
                            .flex()
                            .flex_col()
                            .gap(px(16.))
                            .when(detail.quarantined, |el| {
                                let reason = detail
                                    .quarantine_reason
                                    .clone()
                                    .unwrap_or_else(|| "Flagged as quarantined".to_string());
                                el.child(
                                    div()
                                        .w_full()
                                        .min_w(px(0.))
                                        .p(px(10.))
                                        .rounded(px(6.))
                                        .bg(theme.warning_soft)
                                        .flex()
                                        .flex_col()
                                        .gap(px(2.))
                                        .child(
                                            div()
                                                .text_size(px(12.))
                                                .font_weight(FontWeight::MEDIUM)
                                                .text_color(theme.warning)
                                                .child("Quarantined"),
                                        )
                                        .child(
                                            div()
                                                .w_full()
                                                .min_w(px(0.))
                                                .text_size(px(13.))
                                                .line_height(px(18.))
                                                .text_color(theme.text_primary)
                                                .child(SharedString::from(wrap_unbroken_tokens(
                                                    &reason, 38,
                                                ))),
                                        ),
                                )
                            })
                            .when(
                                !detail.summary.trim().is_empty()
                                    && detail.summary.trim() != detail.content.trim()
                                    && !detail.content.trim().is_empty(),
                                |el| {
                                    el.child(
                                        div()
                                            .w_full()
                                            .min_w(px(0.))
                                            .text_size(px(13.))
                                            .line_height(px(18.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text_secondary)
                                            .child(SharedString::from(wrap_unbroken_tokens(
                                                &detail.summary,
                                                38,
                                            ))),
                                    )
                                },
                            )
                            .child({
                                let body_raw = if !detail.content.trim().is_empty() {
                                    detail.content.as_str()
                                } else if !detail.summary.trim().is_empty() {
                                    detail.summary.as_str()
                                } else {
                                    "(No memory content recorded)"
                                };
                                let is_empty_body = detail.content.trim().is_empty()
                                    && detail.summary.trim().is_empty();
                                div()
                                    .id("detail-content-body")
                                    .w_full()
                                    .min_w(px(0.))
                                    .text_size(px(15.))
                                    .line_height(px(22.))
                                    .text_color(if is_empty_body {
                                        theme.text_muted
                                    } else {
                                        theme.text_primary
                                    })
                                    .child(SharedString::from(wrap_unbroken_tokens(body_raw, 40)))
                            })
                            .when_some(tags_line, |el, tags| {
                                el.child(
                                    div()
                                        .text_size(px(12.))
                                        .line_height(px(17.))
                                        .text_color(theme.text_muted)
                                        .child(tags),
                                )
                            })
                            .when_some(entities_line, |el, entities| {
                                el.child(
                                    div()
                                        .flex()
                                        .flex_col()
                                        .gap(px(4.))
                                        .child(
                                            div()
                                                .text_size(px(12.))
                                                .font_weight(FontWeight::MEDIUM)
                                                .text_color(theme.text_muted)
                                                .child("Entities"),
                                        )
                                        .child(
                                            div()
                                                .text_size(px(13.))
                                                .line_height(px(18.))
                                                .text_color(theme.text_secondary)
                                                .child(entities),
                                        ),
                                )
                            })
                            .child(self.render_receipts_section(&detail, cx))
                            .when(!contradiction_rows.is_empty(), |el| {
                                el.child(
                                    div()
                                        .flex()
                                        .flex_col()
                                        .gap(px(8.))
                                        .child(
                                            div()
                                                .text_size(px(12.))
                                                .font_weight(FontWeight::MEDIUM)
                                                .text_color(theme.text_muted)
                                                .child(format!(
                                                    "Contradictions ({})",
                                                    contradiction_rows.len()
                                                )),
                                        )
                                        .children(contradiction_rows),
                                )
                            })
                            .when(!edge_rows.is_empty(), |el| {
                                el.child(
                                    div()
                                        .flex()
                                        .flex_col()
                                        .gap(px(8.))
                                        .child(
                                            div()
                                                .text_size(px(12.))
                                                .font_weight(FontWeight::MEDIUM)
                                                .text_color(theme.text_muted)
                                                .child(format!(
                                                    "Connections ({})",
                                                    edge_rows.len()
                                                )),
                                        )
                                        .children(edge_rows),
                                )
                            })
                            .child(
                                div()
                                    .border_t_1()
                                    .border_color(theme.border_subtle)
                                    .pt(px(12.))
                                    .flex()
                                    .flex_col()
                                    .gap(px(10.))
                                    .child(
                                        div()
                                            .id("btn-toggle-details")
                                            .focusable()
                                            .cursor_pointer()
                                            .role(Role::Button)
                                            .aria_label("Toggle technical details")
                                            .aria_expanded(self.details_expanded)
                                            .h(px(28.))
                                            .rounded(px(6.))
                                            .hover(move |s| s.bg(theme.bg_elevated))
                                            .focus_visible(move |s| {
                                                s.border_1().border_color(theme.accent)
                                            })
                                            .px(px(4.))
                                            .flex()
                                            .items_center()
                                            .justify_between()
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.details_expanded = !this.details_expanded;
                                                cx.notify();
                                            }))
                                            .child(
                                                div()
                                                    .text_size(px(13.))
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(theme.text_primary)
                                                    .child("Details"),
                                            )
                                            .child(render_ui_icon(
                                                if self.details_expanded {
                                                    UiIcon::ChevronDown
                                                } else {
                                                    UiIcon::ChevronRight
                                                },
                                                12.0,
                                                theme.text_muted,
                                            )),
                                    )
                                    .when(self.details_expanded, |col| {
                                        col.child(
                                            div()
                                                .flex()
                                                .flex_col()
                                                .gap(px(6.))
                                                .child(self.render_meta_row(
                                                    "ID",
                                                    detail.id.clone(),
                                                    true,
                                                ))
                                                .child(self.render_meta_row(
                                                    "Citation",
                                                    detail.citation_token.clone(),
                                                    true,
                                                ))
                                                .child(self.render_meta_row(
                                                    "Namespace",
                                                    detail.namespace.clone(),
                                                    false,
                                                ))
                                                .child(self.render_meta_row(
                                                    "Provenance",
                                                    detail.provenance.clone(),
                                                    false,
                                                ))
                                                .child(self.render_meta_row(
                                                    "Importance",
                                                    format!("{:.2}", detail.importance),
                                                    false,
                                                ))
                                                .child(self.render_meta_row(
                                                    "Trust",
                                                    format!("{:.2}", detail.trust_score),
                                                    false,
                                                ))
                                                .when_some(detail.confidence, |el, c| {
                                                    el.child(self.render_meta_row(
                                                        "Confidence",
                                                        format!("{c:.2}"),
                                                        false,
                                                    ))
                                                })
                                                .child(self.render_meta_row(
                                                    "Pool",
                                                    detail.pool.clone(),
                                                    false,
                                                ))
                                                .when(!detail.harness.is_empty(), |el| {
                                                    el.child(self.render_meta_row(
                                                        "Harness",
                                                        detail.harness.clone(),
                                                        false,
                                                    ))
                                                })
                                                .child(self.render_meta_row(
                                                    "Source",
                                                    detail.source.clone(),
                                                    false,
                                                ))
                                                .child({
                                                    let now_ms = SystemTime::now()
                                                        .duration_since(UNIX_EPOCH)
                                                        .map(|d| d.as_millis() as i64)
                                                        .unwrap_or(0);
                                                    let time_rows =
                                                        build_detail_time_rows(&detail, now_ms);
                                                    div()
                                                        .w_full()
                                                        .min_w(px(0.))
                                                        .mt(px(4.))
                                                        .p(px(10.))
                                                        .rounded(px(6.))
                                                        .bg(theme.bg_sunken)
                                                        .border_1()
                                                        .border_color(theme.border_subtle)
                                                        .flex()
                                                        .flex_col()
                                                        .gap(px(6.))
                                                        .child(
                                                            div()
                                                                .text_size(px(11.))
                                                                .font_weight(FontWeight::MEDIUM)
                                                                .text_color(theme.text_muted)
                                                                .child("Time"),
                                                        )
                                                        .children(time_rows.into_iter().map(
                                                            |(k, v)| self.render_time_row(k, v),
                                                        ))
                                                })
                                                .when(!metadata_entries.is_empty(), |el| {
                                                    el.child(
                                                        div()
                                                            .w_full()
                                                            .min_w(px(0.))
                                                            .mt(px(4.))
                                                            .p(px(10.))
                                                            .rounded(px(6.))
                                                            .bg(theme.bg_sunken)
                                                            .border_1()
                                                            .border_color(theme.border_subtle)
                                                            .flex()
                                                            .flex_col()
                                                            .gap(px(6.))
                                                            .child(
                                                                div()
                                                                    .text_size(px(11.))
                                                                    .font_weight(FontWeight::MEDIUM)
                                                                    .text_color(theme.text_muted)
                                                                    .child("Metadata"),
                                                            )
                                                            .children(
                                                                metadata_entries.iter().map(
                                                                    |(k, v)| {
                                                                        self.render_meta_row_text(
                                                                            k, v, true,
                                                                        )
                                                                    },
                                                                ),
                                                            ),
                                                    )
                                                }),
                                        )
                                    }),
                            ),
                    )
                    .child(render_vertical_scroll_overlay(
                        scroll_handle,
                        theme.bg_panel,
                        theme,
                    ))
                    .when(show_sticky_header, |wrapper| {
                        wrapper.child(
                            div()
                                .id("detail-sticky-header")
                                .absolute()
                                .top(px(0.))
                                .left(px(0.))
                                .right(px(0.))
                                .h(px(40.))
                                .px(px(16.))
                                .bg(theme.bg_panel)
                                .border_b_1()
                                .border_color(theme.border)
                                .cursor_pointer()
                                .tooltip(tooltip_view("Click to scroll to top", theme))
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.scroll_handle.set_offset(point(px(0.), px(0.)));
                                    cx.notify();
                                }))
                                .flex()
                                .items_center()
                                .justify_between()
                                .gap(px(8.))
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w(px(0.))
                                        .flex()
                                        .items_center()
                                        .gap(px(8.))
                                        .child(
                                            div()
                                                .px(px(6.))
                                                .py(px(2.))
                                                .rounded(px(4.))
                                                .bg(theme.bg_elevated)
                                                .border_1()
                                                .border_color(theme.border_subtle)
                                                .flex()
                                                .items_center()
                                                .gap(px(5.))
                                                .flex_shrink_0()
                                                .child(status_dot(sticky_type_color))
                                                .child(
                                                    div()
                                                        .text_size(px(11.))
                                                        .text_color(theme.text_secondary)
                                                        .child(sticky_type),
                                                ),
                                        )
                                        .child(
                                            div()
                                                .font_family("Consolas")
                                                .text_size(px(12.))
                                                .font_weight(FontWeight::MEDIUM)
                                                .text_color(theme.text_primary)
                                                .truncate()
                                                .child(sticky_short_id),
                                        ),
                                )
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(4.))
                                        .flex_shrink_0()
                                        .child(
                                            div()
                                                .id("sticky-copy-content")
                                                .focusable()
                                                .role(Role::Button)
                                                .aria_label("Copy content")
                                                .tooltip(tooltip_view("Copy content", theme))
                                                .cursor_pointer()
                                                .w(px(26.))
                                                .h(px(26.))
                                                .rounded(px(5.))
                                                .hover(move |s| s.bg(theme.bg_elevated))
                                                .flex()
                                                .items_center()
                                                .justify_center()
                                                .on_mouse_down(MouseButton::Left, |_, _, cx| {
                                                    cx.stop_propagation();
                                                })
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    cx.stop_propagation();
                                                    cx.write_to_clipboard(
                                                        ClipboardItem::new_string(
                                                            sticky_content_copy.clone(),
                                                        ),
                                                    );
                                                    this.flash_copied("Copied content", cx);
                                                }))
                                                .child(copy_icon(theme)),
                                        )
                                        .child(
                                            div()
                                                .id("sticky-copy-citation")
                                                .focusable()
                                                .role(Role::Button)
                                                .aria_label("Copy citation")
                                                .tooltip(tooltip_view("Copy citation", theme))
                                                .cursor_pointer()
                                                .w(px(26.))
                                                .h(px(26.))
                                                .rounded(px(5.))
                                                .hover(move |s| s.bg(theme.bg_elevated))
                                                .flex()
                                                .items_center()
                                                .justify_center()
                                                .on_mouse_down(MouseButton::Left, |_, _, cx| {
                                                    cx.stop_propagation();
                                                })
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    cx.stop_propagation();
                                                    cx.write_to_clipboard(
                                                        ClipboardItem::new_string(
                                                            sticky_citation_copy.clone(),
                                                        ),
                                                    );
                                                    this.flash_copied("Copied citation", cx);
                                                }))
                                                .child(cite_icon(theme)),
                                        )
                                        .child(
                                            div()
                                                .px(px(6.))
                                                .py(px(2.))
                                                .rounded(px(4.))
                                                .bg(theme.bg_elevated)
                                                .flex()
                                                .items_center()
                                                .gap(px(4.))
                                                .text_size(px(11.))
                                                .text_color(theme.text_muted)
                                                .child(render_ui_icon(
                                                    UiIcon::ArrowUp,
                                                    11.0,
                                                    theme.text_muted,
                                                ))
                                                .child("Top"),
                                        ),
                                ),
                        )
                    })
            })
            .into_any_element()
    }
}

impl DetailView {
    fn render_receipts_section(&self, detail: &MemoryDetail, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let causal = causal_edges(&detail.edges);
        let has_receipts = !detail.receipts.is_empty();

        let mut origin_parts = Vec::new();
        if !detail.provenance.is_empty() {
            origin_parts.push(detail.provenance.clone());
        }
        if !detail.source.is_empty() && detail.source != detail.provenance {
            origin_parts.push(detail.source.clone());
        }
        if !detail.harness.is_empty() && detail.harness != "unknown" {
            origin_parts.push(detail.harness.clone());
        }
        if !detail.pool.is_empty() {
            origin_parts.push(format!("pool {}", detail.pool));
        }
        let origin_line = if origin_parts.is_empty() {
            "unknown origin".to_string()
        } else {
            origin_parts.join(" · ")
        };

        let trust_pct = (detail.trust_score * 100.0).round().clamp(0.0, 100.0) as i32;
        let mut signal_parts = vec![format!("Trusted {trust_pct}%")];
        if detail.access_count == 1 {
            signal_parts.push("read once".to_string());
        } else if detail.access_count > 1 {
            signal_parts.push(format!("read {} times", detail.access_count));
        }
        let signal_line = signal_parts.join(" · ");

        div()
            .id("detail-receipts")
            .w_full()
            .min_w(px(0.))
            .p(px(12.))
            .rounded(px(8.))
            .bg(theme.bg_sunken)
            .border_1()
            .border_color(theme.border_subtle)
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .child(status_dot(if has_receipts {
                                theme.success
                            } else {
                                theme.text_muted
                            }))
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.text_primary)
                                    .child("Receipts & provenance"),
                            ),
                    )
                    .child(div().text_size(px(11.)).text_color(theme.text_muted).child(
                        if has_receipts {
                            let n = detail.receipts.len();
                            if n == 1 {
                                "1 receipt".to_string()
                            } else {
                                format!("{n} receipts")
                            }
                        } else {
                            "No history yet".to_string()
                        },
                    )),
            )
            .child(
                div()
                    .text_size(px(12.))
                    .line_height(px(17.))
                    .text_color(theme.text_secondary)
                    .child(SharedString::from(origin_line)),
            )
            .child(
                div()
                    .text_size(px(12.))
                    .line_height(px(17.))
                    .text_color(theme.text_muted)
                    .child(SharedString::from(signal_line)),
            )
            .when(!causal.is_empty(), |col| {
                col.child(
                    div()
                        .pt(px(2.))
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .child(
                            div()
                                .text_size(px(11.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.text_muted)
                                .child("Causal lineage"),
                        )
                        .children(causal.into_iter().enumerate().map(|(ix, edge)| {
                            let peer_id = edge.peer_id.clone();
                            let arrow = match edge.direction {
                                EdgeDirection::Outgoing => "->",
                                EdgeDirection::Incoming => "<-",
                            };
                            let causal_aria: SharedString = format!(
                                "{} {} {} ({})",
                                edge.relation, arrow, edge.peer_preview, edge.peer_short_id
                            )
                            .into();
                            div()
                                .id(("receipt-causal-link", ix))
                                .focusable()
                                .cursor_pointer()
                                .role(Role::Button)
                                .aria_label(causal_aria)
                                .px(px(6.))
                                .py(px(4.))
                                .rounded(px(6.))
                                .hover(move |s| s.bg(theme.bg_hover))
                                .flex()
                                .items_center()
                                .justify_between()
                                .gap(px(8.))
                                .on_click(cx.listener(move |_, _, _, cx| {
                                    cx.emit(DetailEvent::SelectMemory(peer_id.clone()));
                                }))
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .text_color(theme.text_secondary)
                                        .truncate()
                                        .child(SharedString::from(format!(
                                            "{} {} {}",
                                            edge.relation, arrow, edge.peer_preview
                                        ))),
                                )
                                .child(
                                    div()
                                        .font_family("Consolas")
                                        .text_size(px(11.))
                                        .text_color(theme.text_muted)
                                        .flex_shrink_0()
                                        .child(SharedString::from(format!(
                                            "#{}",
                                            edge.peer_short_id
                                        ))),
                                )
                        })),
                )
            })
            .when(has_receipts, |col| {
                let extra = detail.receipts.len().saturating_sub(3);
                col.child(
                    div()
                        .pt(px(2.))
                        .border_t_1()
                        .border_color(theme.border_subtle)
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .children(detail.receipts.iter().take(3).map(|r| {
                            let hash = short_receipt_hash(if !r.entry_hash.is_empty() {
                                &r.entry_hash
                            } else {
                                &r.node_hash
                            });
                            div()
                                .flex()
                                .items_center()
                                .justify_between()
                                .gap(px(8.))
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .text_color(theme.text_secondary)
                                        .truncate()
                                        .child(SharedString::from(format!(
                                            "#{} {} · {}",
                                            r.seq,
                                            r.op,
                                            format_timestamp_ms(r.ts)
                                        ))),
                                )
                                .child(
                                    div()
                                        .font_family("Consolas")
                                        .text_size(px(11.))
                                        .text_color(theme.text_muted)
                                        .flex_shrink_0()
                                        .child(SharedString::from(hash)),
                                )
                        }))
                        .when(extra > 0, |c| {
                            c.child(
                                div().text_size(px(11.)).text_color(theme.text_muted).child(
                                    SharedString::from(format!("+{extra} earlier receipts")),
                                ),
                            )
                        }),
                )
            })
            .when(!has_receipts, |col| {
                col.child(
                    div()
                        .text_size(px(11.))
                        .text_color(theme.text_muted)
                        .child("No tamper-log receipts recorded for this memory."),
                )
            })
            .into_any_element()
    }
}

fn short_receipt_hash(hash: &str) -> String {
    let trimmed = hash.trim();
    if trimmed.is_empty() {
        return "—".to_string();
    }
    let short: String = trimmed.chars().take(8).collect();
    short
}

fn causal_edges(edges: &[LinkedEdge]) -> Vec<&LinkedEdge> {
    edges
        .iter()
        .filter(|e| {
            let rel = e.relation.to_ascii_lowercase();
            matches!(
                rel.as_str(),
                "derived_from"
                    | "supersedes"
                    | "contradicts"
                    | "caused_by"
                    | "merged_from"
                    | "consolidated_from"
                    | "promoted_from"
            )
        })
        .take(4)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_json_metadata_entries_and_wraps_long_tokens() {
        let raw = r#"{"source":"cli","tags":["rust","gpui"],"url":"https://example.com/very/long/path/that/would/otherwise/overflow/horizontally"}"#;
        let entries = format_metadata_entries(raw);
        assert_eq!(entries.len(), 3);
        let url_entry = entries.iter().find(|(k, _)| k == "url").unwrap();
        assert!(
            url_entry.1.contains('\n'),
            "expected wrapped long url: {}",
            url_entry.1
        );
        let tags_entry = entries.iter().find(|(k, _)| k == "tags").unwrap();
        assert_eq!(tags_entry.1, "rust, gpui");
    }

    #[test]
    fn receipt_helpers_extract_causal_edges_and_short_hashes() {
        assert_eq!(short_receipt_hash("abcdef123456"), "abcdef12");
        assert_eq!(short_receipt_hash("  "), "—");

        let mk = |rel: &str| LinkedEdge {
            id: rel.to_string(),
            direction: EdgeDirection::Outgoing,
            relation: rel.to_string(),
            weight: 1.0,
            peer_id: "p1".to_string(),
            peer_short_id: "p1".to_string(),
            peer_preview: "Peer".to_string(),
            peer_type: "fact".to_string(),
            created_at: 100,
            valid_from: None,
            valid_to: None,
        };
        let edges = vec![mk("related_to"), mk("derived_from"), mk("supersedes")];
        let causal = causal_edges(&edges);
        assert_eq!(causal.len(), 2);
        assert_eq!(causal[0].relation, "derived_from");
        assert_eq!(causal[1].relation, "supersedes");
    }

    #[test]
    fn sticky_header_threshold_activates_at_56px_scroll() {
        assert!(!is_sticky_header_visible(0.0));
        assert!(!is_sticky_header_visible(55.9));
        assert!(is_sticky_header_visible(56.0));
        assert!(is_sticky_header_visible(240.0));
    }

    #[test]
    fn detail_time_rows_show_never_recalled_and_relative_plus_absolute() {
        let now_ms = 1_700_010_000_000_i64;
        let base_detail = MemoryDetail {
            id: "mem-1".to_string(),
            short_id: "mem-1".to_string(),
            citation_token: "[mem:mem-1]".to_string(),
            content: "Body".to_string(),
            summary: String::new(),
            node_type: "fact".to_string(),
            namespace: "default".to_string(),
            provenance: "user".to_string(),
            source: "user_input".to_string(),
            pool: "semantic".to_string(),
            harness: String::new(),
            importance: 0.8,
            trust_score: 1.0,
            confidence: None,
            evidence_count: None,
            created_at: now_ms - 7_200_000,
            updated_at: now_ms - 120_000,
            access_count: 0,
            last_accessed: 0,
            valid_from: None,
            valid_to: None,
            expires_at: None,
            quarantined: false,
            quarantined_at: None,
            quarantine_reason: None,
            tags: Vec::new(),
            entities: Vec::new(),
            metadata_json: "{}".to_string(),
            edges: Vec::new(),
            contradictions: Vec::new(),
            receipts: Vec::new(),
        };

        let unaccessed_rows = build_detail_time_rows(&base_detail, now_ms);
        assert_eq!(unaccessed_rows[0].0, "Created");
        assert!(unaccessed_rows[0].1.starts_with("2h ago · 2023-11-"));
        assert_eq!(unaccessed_rows[1].0, "Updated");
        assert!(unaccessed_rows[1].1.starts_with("2m ago · 2023-11-"));
        assert_eq!(
            unaccessed_rows[2],
            ("Last read", "Never recalled".to_string())
        );
        assert_eq!(unaccessed_rows[3], ("Reads", "0".to_string()));
        assert_eq!(unaccessed_rows.len(), 4);

        let mut recalled = base_detail;
        recalled.access_count = 4;
        recalled.last_accessed = now_ms - 300_000;
        recalled.expires_at = Some((now_ms + 172_800_000) / 1000);
        recalled.valid_from = Some(now_ms - 3_600_000);
        recalled.valid_to = Some(now_ms + 86_400_000);
        let recalled_rows = build_detail_time_rows(&recalled, now_ms);
        assert_eq!(recalled_rows[2].0, "Last read");
        assert!(
            recalled_rows[2].1.starts_with("5m ago · 2023-11-"),
            "unexpected last read format: {}",
            recalled_rows[2].1
        );
        assert_eq!(recalled_rows[3], ("Reads", "4".to_string()));
        assert!(
            recalled_rows
                .iter()
                .any(|(k, v)| *k == "Expires" && v.starts_with("in 2d · "))
        );
        assert!(
            recalled_rows
                .iter()
                .any(|(k, v)| *k == "Valid from" && v.starts_with("1h ago · "))
        );
        assert!(
            recalled_rows
                .iter()
                .any(|(k, v)| *k == "Valid to" && v.starts_with("in 1d · "))
        );
    }
}
