//! Opening and closing dialogs, and the consent, overflow and Dream diff surfaces.

use super::*;

pub(super) fn filter_dream_diff_entries(
    entries: &[DreamDiffEntry],
    filter: Option<DreamDiffKind>,
) -> Vec<&DreamDiffEntry> {
    entries
        .iter()
        .filter(|entry| filter.is_none_or(|kind| entry.kind == kind))
        .collect()
}

impl MemOSApp {
    pub(super) fn close_all_modals(&mut self) {
        if self.show_settings_modal {
            self.flush_dirty_settings();
        }
        self.show_harnesses_modal = false;
        self.pending_connect_id = None;
        self.show_settings_modal = false;
        self.show_health_modal = false;
        self.show_dream_diff_modal = false;
        self.show_shortcuts_modal = false;
        self.pack.open = false;
        self.compare.open = false;
        self.capture.open = false;
        self.store_switch.open = false;
        self.search_ui.manage_view_id = None;
        self.search_ui.help_open = false;
        self.show_save_view_modal = false;
        self.show_composer_modal = false;
        self.forget_confirm_target = None;
        self.show_ingest_modal = false;
        self.show_consent_modal = false;
    }

    pub(super) fn open_harnesses_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.close_all_modals();
        self.show_harnesses_modal = true;
        if self.harnesses.is_empty() {
            self.spawn_harness_detection(cx);
        }
        self.spawn_harness_detail(self.selected_harness_ix, cx);
        window.focus(&self.focus_handle, cx);
        cx.notify();
    }

    pub(super) fn open_settings_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.close_all_modals();
        let writer_cmd = self.settings.effective_writer_command().to_string();
        if self.writer_cmd_input.read(cx).text() != writer_cmd {
            self.writer_cmd_input
                .update(cx, |v, cx| v.set_text(writer_cmd, cx));
        }
        self.show_settings_modal = true;
        window.focus(&self.focus_handle, cx);
        cx.notify();
    }

    pub(super) fn open_health_modal_from_momo(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open_health_modal(self.health_status.default_panel_filter(), window, cx);
    }

    pub(super) fn open_health_modal(
        &mut self,
        filter: HealthPanelFilter,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.close_all_modals();
        self.health_filter = filter;
        self.show_health_modal = true;
        self._peek_anim_task = None;
        self.momo_peek_sample = PeekSample::default();
        window.focus(&self.focus_handle, cx);
        cx.notify();
    }

    pub(super) fn open_dream_diff_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.close_all_modals();
        self.show_dream_diff_modal = true;
        self.dream_diff_loading = true;
        window.focus(&self.focus_handle, cx);
        cx.notify();

        let db_path = self.resolved_db.path.clone();
        let shared = self.shared_store.clone();
        self._dream_diff_task = Some(cx.spawn(async move |this, cx| {
            let loaded = cx
                .background_executor()
                .spawn(
                    async move { shared.with_store(&db_path, |store| store.load_dream_diff(120)) },
                )
                .await;
            let _ = this.update(cx, |app, cx| {
                app.dream_diff_loading = false;
                match loaded {
                    Ok(entries) => {
                        app.dream_diff_entries = entries;
                    }
                    Err(err) => {
                        app.dream_diff_entries.clear();
                        app.set_notice(sanitize_db_error(&err, &app.resolved_db.path), cx);
                    }
                }
                cx.notify();
            });
        }));
    }

    pub(super) fn open_shortcuts_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.close_all_modals();
        self.show_shortcuts_modal = true;
        window.focus(&self.focus_handle, cx);
        cx.notify();
    }

    pub(super) fn open_save_view_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.close_all_modals();
        let suggested = self.settings.suggested_view_name(&self.filter);
        self.save_view_input
            .update(cx, |input, cx| input.set_text(suggested, cx));
        self.show_save_view_modal = true;
        let handle = self.save_view_input.focus_handle(cx);
        window.focus(&handle, cx);
        cx.notify();
    }

    pub(super) fn confirm_save_view(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let raw = self.save_view_input.read(cx).text().to_string();
        let view = self
            .settings
            .add_custom_saved_view(&raw, self.filter.clone());
        let saved_id = view.id.clone();
        let saved_name = view.name.clone();
        self.active_saved_view_id = Some(saved_id.clone());
        self.settings.last_saved_view_id = Some(saved_id.clone());
        self.settings.last_sort = self.filter.sort;
        self.settings.save_async();
        let updated_views = self.settings.saved_views.clone();
        self.sidebar.update(cx, |s, cx| {
            s.set_saved_views(updated_views, cx);
            s.set_active_saved_view_id(Some(saved_id), cx);
        });
        self.sync_active_view_name_to_list(cx);
        self.show_save_view_modal = false;
        window.focus(&self.focus_handle, cx);
        self.set_notice(format!("Saved view \"{saved_name}\""), cx);
    }

    pub(super) fn delete_saved_view(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(existing_name) = self
            .settings
            .saved_views
            .iter()
            .find(|v| v.id == id && !v.built_in)
            .map(|v| v.name.clone())
        else {
            return;
        };
        let was_active = self.active_saved_view_id.as_deref() == Some(id);
        if self.settings.remove_custom_saved_view(id) {
            self.settings.save_async();
            let updated_views = self.settings.saved_views.clone();
            let next_active = self.settings.last_saved_view_id.clone();
            self.active_saved_view_id = next_active.clone();
            self.sidebar.update(cx, |s, cx| {
                s.set_saved_views(updated_views, cx);
                s.set_active_saved_view_id(next_active, cx);
            });
            if was_active {
                self.clear_filters(cx);
            } else {
                self.sync_active_view_name_to_list(cx);
            }
            self.set_notice(format!("Deleted saved view \"{existing_name}\""), cx);
        }
    }

    pub(super) fn render_consent_modal(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let has_dsn = telemetry::resolve_dsn().is_some();
        div()
            .id("consent-backdrop")
            .absolute()
            .inset_0()
            .bg(rgba(0x00000099))
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .id("consent-dialog")
                    .role(Role::Dialog)
                    .aria_label("Crash reporting consent")
                    .w(px(480.))
                    .p(px(24.))
                    .rounded(px(10.))
                    .bg(theme.bg_panel)
                    .border_1()
                    .border_color(theme.border_subtle)
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(
                                div()
                                    .text_size(px(19.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme.text_primary)
                                    .child("Crash reporting"),
                            )
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.))
                                    .child(status_dot(theme.success))
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .text_color(theme.text_muted)
                                            .child("Off by default"),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(13.))
                            .line_height(px(18.))
                            .text_color(theme.text_secondary)
                            .child("Local rotating logs and offline crash reports always work without a network connection."),
                    )
                    .child(
                        div()
                            .p(px(12.))
                            .rounded(px(6.))
                            .bg(theme.bg_app)
                            .border_1()
                            .border_color(theme.border_subtle)
                            .text_size(px(12.))
                            .line_height(px(17.))
                            .text_color(theme.text_muted)
                            .child(if has_dsn {
                                "If you opt in, Sentry sends panic diagnostics containing only app version, OS, error kind, and a random install ID. Memory content, search queries, and paths are stripped."
                            } else {
                                "No Sentry DSN is configured in this build, so crash reports remain strictly local on your machine."
                            }),
                    )
                    .child(
                        div()
                            .flex()
                            .justify_end()
                            .gap(px(8.))
                            .pt(px(4.))
                            .child(
                                div()
                                    .id("consent-decline")
                                    .focusable()
                                    .role(Role::Button)
                                    .aria_label("Keep crash reports off")
                                    .h(px(34.))
                                    .px(px(14.))
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .bg(theme.bg_elevated)
                                    .border_1()
                                    .border_color(theme.border_subtle)
                                    .hover(move |s| s.bg(theme.bg_selected))
                                    .flex()
                                    .items_center()
                                    .text_size(px(13.))
                                    .text_color(theme.text_primary)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.set_crash_consent(false, cx);
                                    }))
                                    .child("Keep off"),
                            )
                            .child(
                                div()
                                    .id("consent-accept")
                                    .focusable()
                                    .role(Role::Button)
                                    .aria_label("Enable scrubbed crash reports")
                                    .h(px(34.))
                                    .px(px(14.))
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .bg(theme.accent)
                                    .flex()
                                    .items_center()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.primary_btn_fg)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.set_crash_consent(true, cx);
                                    }))
                                    .child("Enable scrubbed reports"),
                            ),
                    ),
            )
            .into_any_element()
    }

    pub(super) fn render_overflow_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let theme_label = if theme.is_dark {
            "Light theme"
        } else {
            "Dark theme"
        };

        gpui::deferred(
            div()
                .id("overflow-menu-popover")
                .w(px(210.))
                .rounded(px(14.))
                .bg(theme.glass_floating)
                .border_1()
                .border_color(theme.glass_border)
                .shadow_lg()
                .p(px(6.))
                .flex()
                .flex_col()
                .gap(px(2.))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(
                    div()
                        .id("menu-toggle-theme")
                        .focusable()
                        .cursor_pointer()
                        .role(Role::Button)
                        .aria_label(theme_label)
                        .h(px(32.))
                        .px(px(10.))
                        .rounded(px(6.))
                        .hover(move |s| s.bg(theme.bg_elevated))
                        .flex()
                        .items_center()
                        .justify_between()
                        .text_size(px(13.))
                        .text_color(theme.text_primary)
                        .child(theme_label)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.show_overflow_menu = false;
                            this.toggle_theme(window, cx);
                        })),
                )
                .child(
                    div()
                        .id("menu-commands")
                        .focusable()
                        .cursor_pointer()
                        .role(Role::Button)
                        .aria_label("Commands")
                        .h(px(32.))
                        .px(px(10.))
                        .rounded(px(6.))
                        .hover(move |s| s.bg(theme.bg_elevated))
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .text_size(px(13.))
                                .text_color(theme.text_primary)
                                .child("Commands"),
                        )
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(theme.text_muted)
                                .child("Ctrl+K"),
                        )
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.show_overflow_menu = false;
                            this.open_palette(window, cx);
                        })),
                )
                .child(
                    div()
                        .id("menu-tools")
                        .focusable()
                        .cursor_pointer()
                        .role(Role::Button)
                        .aria_label("Tools")
                        .h(px(32.))
                        .px(px(10.))
                        .rounded(px(6.))
                        .hover(move |s| s.bg(theme.bg_elevated))
                        .flex()
                        .items_center()
                        .text_size(px(13.))
                        .text_color(theme.text_primary)
                        .child("Tools")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.open_harnesses_modal(window, cx);
                        })),
                )
                .child(
                    div()
                        .id("menu-health")
                        .focusable()
                        .cursor_pointer()
                        .role(Role::Button)
                        .aria_label("Store health")
                        .h(px(32.))
                        .px(px(10.))
                        .rounded(px(6.))
                        .hover(move |s| s.bg(theme.bg_elevated))
                        .flex()
                        .items_center()
                        .text_size(px(13.))
                        .text_color(theme.text_primary)
                        .child("Store health")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.open_health_modal(HealthPanelFilter::All, window, cx);
                        })),
                )
                .child(
                    div()
                        .id("menu-settings")
                        .focusable()
                        .cursor_pointer()
                        .role(Role::Button)
                        .aria_label("Settings")
                        .h(px(32.))
                        .px(px(10.))
                        .rounded(px(6.))
                        .hover(move |s| s.bg(theme.bg_elevated))
                        .flex()
                        .items_center()
                        .text_size(px(13.))
                        .text_color(theme.text_primary)
                        .child("Settings")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.open_settings_modal(window, cx);
                        })),
                )
                .child(
                    div()
                        .id("menu-dream-diff")
                        .focusable()
                        .role(Role::Button)
                        .aria_label("Dream diff")
                        .h(px(32.))
                        .px(px(10.))
                        .rounded(px(6.))
                        .cursor_pointer()
                        .hover(move |s| s.bg(theme.bg_hover))
                        .focus_visible(move |s| s.border_1().border_color(theme.accent))
                        .flex()
                        .items_center()
                        .justify_between()
                        .text_size(px(13.))
                        .text_color(theme.text_primary)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.show_overflow_menu = false;
                            this.open_dream_diff_modal(window, cx);
                        }))
                        .child("Dream diff"),
                )
                .child(div().my(px(4.)).h(px(1.)).bg(theme.border_subtle))
                .child(
                    div()
                        .id("menu-shortcuts")
                        .focusable()
                        .cursor_pointer()
                        .role(Role::Button)
                        .aria_label("Keyboard shortcuts")
                        .h(px(32.))
                        .px(px(10.))
                        .rounded(px(6.))
                        .hover(move |s| s.bg(theme.bg_hover))
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .text_size(px(13.))
                                .text_color(theme.text_primary)
                                .child("Keyboard shortcuts"),
                        )
                        .child(keycap("?", &theme))
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.open_shortcuts_modal(window, cx);
                        })),
                )
                .child(
                    div()
                        .id("menu-copy-diagnostics")
                        .focusable()
                        .cursor_pointer()
                        .role(Role::Button)
                        .aria_label("Copy diagnostics")
                        .h(px(32.))
                        .px(px(10.))
                        .rounded(px(6.))
                        .hover(move |s| s.bg(theme.bg_elevated))
                        .flex()
                        .items_center()
                        .text_size(px(13.))
                        .text_color(theme.text_secondary)
                        .child("Copy diagnostics")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.show_overflow_menu = false;
                            this.copy_diagnostics(cx);
                        })),
                ),
        )
        .with_priority(15)
        .into_any_element()
    }

    pub(super) fn render_dream_diff_modal(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let filter = self.dream_diff_filter;
        let filtered = filter_dream_diff_entries(&self.dream_diff_entries, filter);
        let filter_options: [Option<DreamDiffKind>; 6] = [
            None,
            Some(DreamDiffKind::Promoted),
            Some(DreamDiffKind::Merged),
            Some(DreamDiffKind::Decayed),
            Some(DreamDiffKind::Contradiction),
            Some(DreamDiffKind::Updated),
        ];

        let pills = filter_options.into_iter().enumerate().map(|(ix, kind)| {
            let active = filter == kind;
            let count = filter_dream_diff_entries(&self.dream_diff_entries, kind).len();
            let label = match kind {
                None => format!("All ({count})"),
                Some(k) => format!("{} ({count})", k.label()),
            };
            div()
                .id(("dream-diff-filter", ix))
                .focusable()
                .role(Role::Button)
                .cursor_pointer()
                .h(px(28.))
                .px(px(10.))
                .rounded(px(6.))
                .bg(if active {
                    theme.bg_selected
                } else {
                    theme.bg_elevated
                })
                .border_1()
                .border_color(if active {
                    theme.border_strong
                } else {
                    theme.border_subtle
                })
                .hover(move |s| s.bg(theme.bg_hover))
                .focus_visible(move |s| s.border_1().border_color(theme.accent))
                .flex()
                .items_center()
                .text_size(px(12.))
                .font_weight(if active {
                    FontWeight::MEDIUM
                } else {
                    FontWeight::NORMAL
                })
                .text_color(if active {
                    theme.text_primary
                } else {
                    theme.text_secondary
                })
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.dream_diff_filter = kind;
                    cx.notify();
                }))
                .child(label)
        });

        let feed_content: AnyElement =
            if self.dream_diff_loading && self.dream_diff_entries.is_empty() {
                div()
                    .py(px(28.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(13.))
                    .text_color(theme.text_muted)
                    .child("Loading memory timeline...")
                    .into_any_element()
            } else if filtered.is_empty() {
                div()
                    .py(px(28.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(13.))
                    .text_color(theme.text_muted)
                    .child("No lifecycle or consolidation events recorded for this filter.")
                    .into_any_element()
            } else {
                div()
                    .id("dream-diff-list")
                    .flex_1()
                    .min_h(px(0.))
                    .max_h(px(420.))
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .children(filtered.into_iter().enumerate().map(|(ix, entry)| {
                        let dot = match entry.kind {
                            DreamDiffKind::Promoted | DreamDiffKind::Merged => theme.success,
                            DreamDiffKind::Decayed => theme.warning,
                            DreamDiffKind::Contradiction => theme.danger,
                            DreamDiffKind::Updated => theme.text_muted,
                        };
                        let node_id = entry.node_id.clone();
                        let ts_str = format_timestamp_ms(entry.timestamp);
                        div()
                            .id(("dream-diff-row", ix))
                            .focusable()
                            .role(Role::Button)
                            .aria_label(format!(
                                "{}: {} ({})",
                                entry.kind.label(),
                                entry.summary,
                                entry.short_id
                            ))
                            .w_full()
                            .p(px(10.))
                            .rounded(px(8.))
                            .cursor_pointer()
                            .bg(theme.bg_sunken)
                            .border_1()
                            .border_color(theme.border_subtle)
                            .hover(move |s| s.bg(theme.bg_hover))
                            .focus_visible(move |s| s.border_1().border_color(theme.accent))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.show_dream_diff_modal = false;
                                this.select_memory(node_id.clone(), true, cx);
                            }))
                            .flex()
                            .flex_col()
                            .gap(px(4.))
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
                                            .gap(px(8.))
                                            .child(status_dot(dot))
                                            .child(
                                                div()
                                                    .text_size(px(12.))
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(theme.text_primary)
                                                    .child(entry.kind.label()),
                                            )
                                            .child(
                                                div()
                                                    .px(px(6.))
                                                    .py(px(1.))
                                                    .rounded(px(4.))
                                                    .bg(theme.bg_elevated)
                                                    .font_family(crate::ui::views::kit::MONO_FONT)
                                                    .text_size(px(11.))
                                                    .text_color(theme.text_secondary)
                                                    .child(format!("[mem:{}]", entry.short_id)),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .text_color(theme.text_muted)
                                            .child(ts_str),
                                    ),
                            )
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .text_color(theme.text_primary)
                                    .truncate()
                                    .child(entry.summary.clone()),
                            )
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(theme.text_muted)
                                    .truncate()
                                    .child(entry.detail.clone()),
                            )
                    }))
                    .into_any_element()
            };

        div()
            .id("dream-diff-modal-backdrop")
            .absolute()
            .inset_0()
            .bg(theme.glass_scrim)
            .flex()
            .items_center()
            .justify_center()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    this.show_dream_diff_modal = false;
                    cx.notify();
                }),
            )
            .child(
                div()
                    .id("dream-diff-dialog")
                    .role(Role::Dialog)
                    .aria_label("Dream Diff timeline")
                    .w(px(640.))
                    .max_w(gpui::relative(0.92))
                    .max_h(gpui::relative(0.86))
                    .p(px(24.))
                    .rounded(px(16.))
                    .bg(theme.glass_panel)
                    .border_1()
                    .border_color(theme.glass_border)
                    .shadow_lg()
                    .flex()
                    .flex_col()
                    .gap(px(14.))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .flex()
                            .items_start()
                            .justify_between()
                            .gap(px(12.))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(4.))
                                    .child(
                                        div()
                                            .text_size(px(19.))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(theme.text_primary)
                                            .child("Dream Diff"),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .text_color(theme.text_muted)
                                            .child("Read-only timeline of promotions, merges, decay, and contradictions."),
                                    ),
                            )
                            .child(
                                div()
                                    .id("close-dream-diff-modal")
                                    .focusable()
                                    .role(Role::Button)
                                    .aria_label("Close Dream Diff")
                                    .w(px(28.))
                                    .h(px(28.))
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .hover(move |s| s.bg(theme.bg_hover))
                                    .focus_visible(move |s| s.border_1().border_color(theme.accent))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.show_dream_diff_modal = false;
                                        window.focus(&this.focus_handle, cx);
                                        cx.notify();
                                    }))
                                    .child(render_ui_icon(
                                        UiIcon::Close,
                                        14.0,
                                        theme.text_secondary,
                                    )),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap(px(6.))
                            .children(pills),
                    )
                    .child(feed_content),
            )
            .into_any_element()
    }
}
