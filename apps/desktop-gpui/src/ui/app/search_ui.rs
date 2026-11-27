//! Search workflow: the scope syntax reference with one-click completions,
//! recent searches, and the saved-view manager (rename, refilter, delete).

use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::{
    AnyElement, AppContext, Context, Entity, Focusable, InteractiveElement, IntoElement,
    MouseButton, ParentElement, Role, SharedString, StatefulInteractiveElement, Styled,
    Subscription, Window, div, prelude::FluentBuilder, px,
};

use super::MemOSApp;
use crate::core::model::{
    SearchScopeKind, describe_filter_target, remove_search_scope, scopes_from_filter,
};
use crate::ui::views::kit::{
    self, ButtonKind, ModalShell, NoticeKind, button, notice, section_label,
};
use crate::ui::views::{InputEvent, TextInput, ThemePalette};

/// One row of the syntax reference.
pub(crate) struct ScopeHelp {
    /// Text inserted into the search box.
    pub insert: &'static str,
    /// Example shown to the user.
    pub example: &'static str,
    pub meaning: &'static str,
    /// Which overview facet offers completions, if any.
    pub facet: Option<SearchScopeKind>,
}

pub(crate) const SCOPE_HELP: &[ScopeHelp] = &[
    ScopeHelp {
        insert: "type:",
        example: "type:decision",
        meaning: "Memory type",
        facet: Some(SearchScopeKind::NodeType),
    },
    ScopeHelp {
        insert: "tag:",
        example: "tag:auth",
        meaning: "Has this tag",
        facet: Some(SearchScopeKind::Tag),
    },
    ScopeHelp {
        insert: "ns:",
        example: "ns:work",
        meaning: "In this namespace",
        facet: Some(SearchScopeKind::Namespace),
    },
    ScopeHelp {
        insert: "provenance:",
        example: "provenance:verified",
        meaning: "Where it came from",
        facet: Some(SearchScopeKind::Provenance),
    },
    ScopeHelp {
        insert: "has:contradiction ",
        example: "has:contradiction",
        meaning: "Conflicts with another memory",
        facet: None,
    },
    ScopeHelp {
        insert: "is:stale ",
        example: "is:stale",
        meaning: "Not updated in 90 days",
        facet: None,
    },
    ScopeHelp {
        insert: "is:quarantined ",
        example: "is:quarantined",
        meaning: "Flagged or waiting for review",
        facet: None,
    },
    ScopeHelp {
        insert: "after:",
        example: "after:2026-11-01",
        meaning: "Created on or after a date (UTC)",
        facet: None,
    },
    ScopeHelp {
        insert: "trust:<",
        example: "trust:<0.5",
        meaning: "Trust below a threshold, 0 to 1",
        facet: None,
    },
];

/// Append `token` to the search text with exactly one separating space.
pub(crate) fn append_search_token(current: &str, token: &str) -> String {
    let trimmed = current.trim_end();
    if let Some((scope, _)) = token.split_once(':') {
        let prefix = format!("{scope}:");
        if let Some(before) = trimmed.strip_suffix(&prefix)
            && (before.is_empty() || before.ends_with(char::is_whitespace))
        {
            return format!("{before}{token}");
        }
    }
    if trimmed.is_empty() {
        token.to_string()
    } else {
        format!("{trimmed} {token}")
    }
}

pub(super) struct SearchUiState {
    pub help_open: bool,
    pub help_closed_at: Option<Instant>,
    pub manage_view_id: Option<String>,
    pub manage_input: Entity<TextInput>,
    /// First click on Delete arms it; the second deletes.
    pub confirm_delete: bool,
}

impl SearchUiState {
    pub fn new(
        theme: ThemePalette,
        window: &mut Window,
        cx: &mut Context<MemOSApp>,
    ) -> (Self, Subscription) {
        let manage_input = cx.new(|cx| TextInput::new(cx, "View name", theme));
        let sub = cx.subscribe_in(
            &manage_input,
            window,
            |this, _, event, window, cx| match event {
                InputEvent::Submit(_) => this.rename_managed_view(window, cx),
                InputEvent::Cancel => this.close_manage_view(window, cx),
                _ => {}
            },
        );
        (
            Self {
                help_open: false,
                help_closed_at: None,
                manage_view_id: None,
                manage_input,
                confirm_delete: false,
            },
            sub,
        )
    }
}

impl MemOSApp {
    pub(super) fn toggle_search_help(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.search_ui.help_open {
            self.close_search_help(cx);
            return;
        }
        // The click that closed the popover via mouse-down-outside must not
        // immediately reopen it when it lands on the toggle.
        if self
            .search_ui
            .help_closed_at
            .is_some_and(|t| t.elapsed() < Duration::from_millis(250))
        {
            return;
        }
        self.dismiss_popovers(super::PopoverOwner::None, cx);
        self.search_ui.help_open = true;
        let focus = self.search_input.focus_handle(cx);
        window.focus(&focus, cx);
        cx.notify();
    }

    pub(super) fn close_search_help(&mut self, cx: &mut Context<Self>) {
        if self.search_ui.help_open {
            self.search_ui.help_open = false;
            self.search_ui.help_closed_at = Some(Instant::now());
            cx.notify();
        }
    }

    /// Insert a scope token (or a full `scope:value`) into the search box.
    fn insert_search_token(&mut self, token: &str, window: &mut Window, cx: &mut Context<Self>) {
        let current = self.search_input.read(cx).text().to_string();
        let next = append_search_token(&current, token);
        self.search_input
            .update(cx, |i, cx| i.set_text(next.clone(), cx));
        // `set_text` is silent; run the normal change path so complete
        // scopes become chips right away.
        self.on_search_changed(next, cx);
        let focus = self.search_input.focus_handle(cx);
        window.focus(&focus, cx);
        if token.ends_with(' ') {
            self.close_search_help(cx);
        }
    }

    /// The search as typed: scope chips first, then free text.
    pub(super) fn current_search_expression(&self) -> String {
        let mut parts: Vec<String> = scopes_from_filter(&self.filter)
            .into_iter()
            .map(|c| c.label)
            .collect();
        let q = self.filter.query.trim();
        if !q.is_empty() {
            parts.push(q.to_string());
        }
        parts.join(" ")
    }

    /// Remember the active search once the user commits to it.
    pub(super) fn record_recent_search(&mut self) {
        let expr = self.current_search_expression();
        if self.settings.record_recent_search(&expr) && !self.smoke_exit_after_first_frame {
            self.settings.save_async();
        }
    }

    fn apply_recent_search(&mut self, expr: String, window: &mut Window, cx: &mut Context<Self>) {
        for kind in [
            SearchScopeKind::NodeType,
            SearchScopeKind::Tag,
            SearchScopeKind::Namespace,
            SearchScopeKind::Provenance,
            SearchScopeKind::HasContradiction,
            SearchScopeKind::IsStale,
            SearchScopeKind::AfterDate,
            SearchScopeKind::MaxTrust,
            SearchScopeKind::IsQuarantined,
        ] {
            remove_search_scope(&mut self.filter, kind);
        }
        let text = format!("{expr} ");
        self.search_input
            .update(cx, |i, cx| i.set_text(text.clone(), cx));
        self.on_search_changed(text, cx);
        self.close_search_help(cx);
        let focus = self.search_input.focus_handle(cx);
        window.focus(&focus, cx);
    }

    fn clear_recent_searches(&mut self, cx: &mut Context<Self>) {
        self.settings.recent_searches.clear();
        self.settings.save_async();
        cx.notify();
    }

    fn facet_values(&self, kind: SearchScopeKind) -> Vec<String> {
        let Some(ov) = self.overview.as_ref() else {
            return Vec::new();
        };
        let list = match kind {
            SearchScopeKind::NodeType => &ov.types,
            SearchScopeKind::Tag => &ov.tags,
            SearchScopeKind::Namespace => &ov.namespaces,
            SearchScopeKind::Provenance => &ov.provenances,
            _ => return Vec::new(),
        };
        list.iter()
            .filter(|f| !f.name.contains(char::is_whitespace))
            .take(4)
            .map(|f| f.name.clone())
            .collect()
    }

    pub(super) fn render_search_help(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let entity = cx.entity();

        let recent: Vec<AnyElement> = self
            .settings
            .recent_searches
            .iter()
            .take(5)
            .enumerate()
            .map(|(ix, expr)| {
                let e = entity.clone();
                let value = expr.clone();
                div()
                    .id(("search-recent", ix))
                    .focusable()
                    .role(Role::Button)
                    .aria_label(SharedString::from(format!("Search again: {expr}")))
                    .h(px(26.))
                    .px(px(8.))
                    .rounded(px(5.))
                    .cursor_pointer()
                    .flex()
                    .items_center()
                    .hover(move |s| s.bg(theme.bg_hover))
                    .focus_visible(move |s| s.bg(theme.bg_hover))
                    .text_size(px(kit::text::SM))
                    .text_color(theme.text_primary)
                    .truncate()
                    .on_click(move |_, window, cx| {
                        e.update(cx, |app, cx| {
                            app.apply_recent_search(value.clone(), window, cx)
                        });
                    })
                    .child(SharedString::from(expr.clone()))
                    .into_any_element()
            })
            .collect();

        let scope_rows = SCOPE_HELP.iter().enumerate().map(|(ix, help)| {
            let e = entity.clone();
            let insert = help.insert;
            let completions = help.facet.map(|k| self.facet_values(k)).unwrap_or_default();
            div()
                .w_full()
                .min_w(px(0.))
                .flex()
                .items_center()
                .gap(px(kit::space::S2))
                .child(
                    div()
                        .id(("search-scope-help", ix))
                        .focusable()
                        .role(Role::Button)
                        .aria_label(SharedString::from(format!(
                            "Insert {}: {}",
                            help.example, help.meaning
                        )))
                        .w(px(150.))
                        .flex_shrink_0()
                        .h(px(24.))
                        .px(px(6.))
                        .rounded(px(5.))
                        .cursor_pointer()
                        .flex()
                        .items_center()
                        .font_family(kit::MONO_FONT)
                        .text_size(px(kit::text::SM))
                        .text_color(theme.text_primary)
                        .hover(move |s| s.bg(theme.bg_hover))
                        .focus_visible(move |s| s.bg(theme.bg_hover))
                        .on_click(move |_, window, cx| {
                            e.update(cx, |app, cx| app.insert_search_token(insert, window, cx));
                        })
                        .child(help.example),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w(px(0.))
                        .text_size(px(kit::text::SM))
                        .text_color(theme.text_muted)
                        .truncate()
                        .child(help.meaning),
                )
                .children(completions.into_iter().enumerate().map(|(cix, value)| {
                    let e = entity.clone();
                    let token = format!("{insert}{value} ");
                    div()
                        .id(SharedString::from(format!("search-complete-{ix}-{cix}")))
                        .focusable()
                        .role(Role::Button)
                        .aria_label(SharedString::from(format!("Filter by {}", token.trim())))
                        .flex_shrink_0()
                        .max_w(px(96.))
                        .h(px(22.))
                        .px(px(6.))
                        .rounded(px(5.))
                        .cursor_pointer()
                        .border_1()
                        .border_color(theme.border_subtle)
                        .flex()
                        .items_center()
                        .text_size(px(kit::text::XS))
                        .text_color(theme.text_secondary)
                        .hover(move |s| s.border_color(theme.border_strong))
                        .focus_visible(move |s| s.border_color(theme.accent))
                        .truncate()
                        .on_click(move |_, window, cx| {
                            e.update(cx, |app, cx| app.insert_search_token(&token, window, cx));
                        })
                        .child(SharedString::from(value))
                }))
        });

        let close_entity = entity.clone();
        gpui::deferred(
            div()
                .id("search-help-popover")
                .role(Role::Dialog)
                .aria_label("Search syntax")
                .absolute()
                .top(px(38.))
                .left(px(0.))
                .w(px(560.))
                .max_w(px(560.))
                .p(px(kit::space::S3))
                .rounded(px(10.))
                .bg(theme.glass_floating)
                .border_1()
                .border_color(theme.glass_border)
                .shadow_lg()
                .flex()
                .flex_col()
                .gap(px(kit::space::S2))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_mouse_down_out(move |_, _, cx| {
                    close_entity.update(cx, |app, cx| app.close_search_help(cx));
                })
                .when(!recent.is_empty(), |col| {
                    let e = entity.clone();
                    col.child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(section_label("Recent", &theme))
                            .child(
                                button("search-recent-clear", "Clear", ButtonKind::Subtle, &theme)
                                    .h(px(22.))
                                    .text_size(px(kit::text::XS))
                                    .on_click(move |_, _, cx| {
                                        e.update(cx, |app, cx| app.clear_recent_searches(cx));
                                    }),
                            ),
                    )
                    .child(div().flex().flex_col().children(recent))
                    .child(div().h(px(1.)).bg(theme.border_subtle))
                })
                .child(section_label("Scopes", &theme))
                .child(div().flex().flex_col().gap(px(2.)).children(scope_rows))
                .child(
                    div()
                        .pt(px(kit::space::S1))
                        .text_size(px(kit::text::XS))
                        .line_height(px(15.))
                        .text_color(theme.text_muted)
                        .child(
                            "Scopes turn into chips once followed by a space or Enter. Backspace in an empty box removes the last chip. Words that aren't scopes search memory text.",
                        ),
                ),
        )
        .with_priority(20)
        .into_any_element()
    }

    // ---- Saved view management ----------------------------------------

    pub(super) fn open_manage_view(
        &mut self,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(view) = self
            .settings
            .saved_views
            .iter()
            .find(|v| v.id == id && !v.built_in)
            .cloned()
        else {
            self.set_notice("Built-in views can't be changed", cx);
            return;
        };
        self.dismiss_popovers(super::PopoverOwner::None, cx);
        self.close_all_modals();
        self.search_ui.manage_view_id = Some(view.id);
        self.search_ui.confirm_delete = false;
        self.search_ui
            .manage_input
            .update(cx, |i, cx| i.set_text(view.name, cx));
        let focus = self.search_ui.manage_input.focus_handle(cx);
        window.focus(&focus, cx);
        cx.notify();
    }

    pub(super) fn close_manage_view(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.search_ui.manage_view_id = None;
        window.focus(&self.focus_handle, cx);
        cx.notify();
    }

    fn after_saved_views_changed(&mut self, cx: &mut Context<Self>) {
        self.settings.save_async();
        let views = self.settings.saved_views.clone();
        self.sidebar
            .update(cx, |s, cx| s.set_saved_views(views, cx));
        self.sync_active_view_name_to_list(cx);
    }

    fn rename_managed_view(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.search_ui.manage_view_id.clone() else {
            return;
        };
        let raw = self.search_ui.manage_input.read(cx).text().to_string();
        if let Some(name) = self.settings.rename_custom_saved_view(&id, &raw) {
            self.after_saved_views_changed(cx);
            self.close_manage_view(window, cx);
            self.set_notice(format!("Saved view renamed to \"{name}\""), cx);
        }
    }

    fn refilter_managed_view(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.search_ui.manage_view_id.clone() else {
            return;
        };
        let raw = self.search_ui.manage_input.read(cx).text().to_string();
        let name = self.settings.rename_custom_saved_view(&id, &raw);
        if self
            .settings
            .update_custom_saved_view_filter(&id, self.filter.clone())
        {
            self.active_saved_view_id = Some(id.clone());
            self.settings.last_saved_view_id = Some(id.clone());
            self.sidebar
                .update(cx, |s, cx| s.set_active_saved_view_id(Some(id), cx));
            self.after_saved_views_changed(cx);
            self.close_manage_view(window, cx);
            self.set_notice(
                format!(
                    "\"{}\" now uses the current filters",
                    name.unwrap_or_default()
                ),
                cx,
            );
        }
    }

    fn delete_managed_view(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.search_ui.confirm_delete {
            self.search_ui.confirm_delete = true;
            cx.notify();
            return;
        }
        if let Some(id) = self.search_ui.manage_view_id.clone() {
            self.close_manage_view(window, cx);
            self.delete_saved_view(&id, cx);
        }
    }

    pub(super) fn render_manage_view(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let entity = cx.entity();
        let Some(view) = self
            .search_ui
            .manage_view_id
            .as_deref()
            .and_then(|id| self.settings.saved_views.iter().find(|v| v.id == id))
        else {
            return div().into_any_element();
        };
        let saved_desc = describe_filter_target(&view.filter);
        let saved_desc = saved_desc
            .strip_prefix("Current view · ")
            .unwrap_or(&saved_desc)
            .to_string();
        let current_desc = describe_filter_target(&self.filter);
        let current_desc = current_desc
            .strip_prefix("Current view · ")
            .unwrap_or(&current_desc)
            .to_string();
        let same_filter = view.filter == self.filter;

        let mut shell = ModalShell::new("manage-view-dialog", "Edit saved view")
            .width(480.)
            .child(section_label("Name", &theme))
            .child(div().w_full().child(self.search_ui.manage_input.clone()))
            .child(kit::kv_row("Saved filters", saved_desc, &theme))
            .child(kit::kv_row("Current", current_desc, &theme));
        if same_filter {
            shell = shell.child(notice(
                NoticeKind::Info,
                "The current filters already match this view.",
                &theme,
            ));
        }
        let e_del = entity.clone();
        let e_ref = entity.clone();
        let e_save = entity.clone();
        shell = shell
            .footer_note(
                button(
                    "manage-view-delete",
                    if self.search_ui.confirm_delete {
                        "Click again to delete"
                    } else {
                        "Delete view"
                    },
                    ButtonKind::Danger,
                    &theme,
                )
                .on_click(move |_, window, cx| {
                    e_del.update(cx, |app, cx| app.delete_managed_view(window, cx));
                }),
            )
            .action(
                button(
                    "manage-view-refilter",
                    "Use current filters",
                    ButtonKind::Secondary,
                    &theme,
                )
                .on_click(move |_, window, cx| {
                    e_ref.update(cx, |app, cx| app.refilter_managed_view(window, cx));
                }),
            )
            .action(
                button("manage-view-save", "Save name", ButtonKind::Primary, &theme).on_click(
                    move |_, window, cx| {
                        e_save.update(cx, |app, cx| app.rename_managed_view(window, cx));
                    },
                ),
            );
        shell.render(
            &theme,
            Rc::new(move |window, cx| {
                entity.update(cx, |app, cx| app.close_manage_view(window, cx));
            }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_append_with_single_space() {
        assert_eq!(append_search_token("", "tag:"), "tag:");
        assert_eq!(append_search_token("oauth tag:", "tag:auth "), "oauth tag:auth ");
        assert_eq!(append_search_token("hashtag:", "tag:auth "), "hashtag: tag:auth ");
        assert_eq!(append_search_token("oauth  ", "tag:"), "oauth tag:");
        assert_eq!(append_search_token("oauth", "is:stale "), "oauth is:stale ");
    }

    #[test]
    fn every_documented_scope_parses_from_its_example() {
        for help in SCOPE_HELP {
            let mut filter = crate::core::model::QueryFilter::default();
            let parsed = crate::core::model::extract_search_scopes(
                help.example,
                &mut filter,
                1_800_000_000_000,
                true,
            );
            assert!(parsed.applied_any, "{} should parse", help.example);
        }
    }
}
