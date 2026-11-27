//! The Settings dialog.

use super::*;

impl MemOSApp {
    pub(super) fn render_settings_modal(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let dialog_h = (window.viewport_size().height.as_f32() * 0.88).max(420.0);
        let crash_on = self.settings.crash_reporting_enabled();
        let write_mode = self.settings.write_mode && self.writer_preflight.compatible;
        let preflight = self.writer_preflight.clone();
        let themes = [
            (ThemeMode::System, "System"),
            (ThemeMode::Light, "Light"),
            (ThemeMode::Dark, "Dark"),
        ];
        let default_views = [(ViewMode::List, "List"), (ViewMode::Graph, "Graph")];
        let densities = [
            (RowDensity::Comfortable, "Comfortable"),
            (RowDensity::Compact, "Compact"),
        ];

        div()
            .id("settings-backdrop")
            .absolute()
            .inset_0()
            .bg(theme.glass_scrim)
            .px(px(24.))
            .py(px(20.))
            .flex()
            .items_center()
            .justify_center()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    this.show_settings_modal = false;
                    this.flush_dirty_settings();
                    window.focus(&this.focus_handle, cx);
                    cx.notify();
                }),
            )
            .child(
                div()
                    .id("settings-dialog")
                    .role(Role::Dialog)
                    .aria_label("Settings")
                    .w(px(520.))
                    .max_w(gpui::relative(0.92))
                    .h(px(dialog_h))
                    .max_h(gpui::relative(0.92))
                    .rounded(px(12.))
                    .bg(theme.glass_panel)
                    .border_1()
                    .border_color(theme.glass_border)
                    .shadow_lg()
                    .overflow_hidden()
                    .flex()
                    .flex_col()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| {
                        cx.stop_propagation();
                    })
                    .child(
                        div()
                            .h(px(52.))
                            .px(px(20.))
                            .border_b_1()
                            .border_color(theme.border_subtle)
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(
                                div()
                                    .text_size(px(16.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme.text_primary)
                                    .child("Settings"),
                            )
                            .child(
                                div()
                                    .id("close-settings-modal")
                                    .focusable()
                                    .role(Role::Button)
                                    .aria_label("Close settings")
                                    .w(px(28.))
                                    .h(px(28.))
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .hover(move |s| s.bg(theme.bg_elevated))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.show_settings_modal = false;
                                        this.flush_dirty_settings();
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
                            .id("settings-scroll-wrap")
                            .relative()
                            .flex_1()
                            .w_full()
                            .min_w(px(0.))
                            .min_h_0()
                            .child(
                                div()
                                    .id("settings-scroll-body")
                                    .w_full()
                                    .min_w(px(0.))
                                    .h_full()
                                    .overflow_y_scroll()
                                    .overflow_x_hidden()
                                    .track_scroll(&self.settings_scroll)
                                    .p(px(20.))
                            .flex()
                            .flex_col()
                            .gap(px(16.))
                            .child(kit::field(
                                "Appearance",
                                None,
                                kit::segmented(
                                    "settings-theme",
                                    "Appearance",
                                    themes
                                        .into_iter()
                                        .map(|(mode, label)| {
                                            let e = cx.entity();
                                            kit::Segment::new(
                                                label,
                                                self.settings.theme == mode,
                                                move |_, window, cx| {
                                                    e.update(cx, |this, cx| {
                                                        this.settings.theme = mode;
                                                        this.settings.save_async();
                                                        let resolved = ThemePalette::resolve(
                                                            mode,
                                                            window.appearance(),
                                                        );
                                                        this.apply_theme_palette(resolved, window, cx);
                                                    })
                                                },
                                            )
                                        })
                                        .collect(),
                                    &theme,
                                ),
                                &theme,
                            ))
                            .child(kit::field(
                                "Default view",
                                Some("used when the app starts".into()),
                                kit::segmented(
                                    "settings-default-view",
                                    "Default view",
                                    default_views
                                        .into_iter()
                                        .map(|(vm, label)| {
                                            let e = cx.entity();
                                            kit::Segment::new(
                                                label,
                                                self.settings.default_view == vm,
                                                move |_, _, cx| {
                                                    e.update(cx, |this, cx| {
                                                        this.settings.default_view = vm;
                                                        this.settings.save_async();
                                                        cx.notify();
                                                    })
                                                },
                                            )
                                        })
                                        .collect(),
                                    &theme,
                                ),
                                &theme,
                            ))
                            .child(kit::field(
                                "Row density",
                                None,
                                kit::segmented(
                                    "settings-density",
                                    "Row density",
                                    densities
                                        .into_iter()
                                        .map(|(density, label)| {
                                            let e = cx.entity();
                                            kit::Segment::new(
                                                label,
                                                self.settings.row_density == density,
                                                move |_, _, cx| {
                                                    e.update(cx, |this, cx| this.set_row_density(density, cx))
                                                },
                                            )
                                        })
                                        .collect(),
                                    &theme,
                                ),
                                &theme,
                            ))
                            .child(kit::field(
                                "Reading size",
                                Some("inspector and comparison text".into()),
                                {
                                    let e_std = cx.entity();
                                    let e_lg = cx.entity();
                                    let large = self.settings.large_reading_text;
                                    kit::segmented(
                                        "settings-reading-size",
                                        "Reading size",
                                        vec![
                                            kit::Segment::new("Standard", !large, move |_, _, cx| {
                                                e_std.update(cx, |app, cx| {
                                                    if app.settings.large_reading_text {
                                                        app.toggle_reading_size(cx);
                                                    }
                                                })
                                            }),
                                            kit::Segment::new("Large", large, move |_, _, cx| {
                                                e_lg.update(cx, |app, cx| {
                                                    if !app.settings.large_reading_text {
                                                        app.toggle_reading_size(cx);
                                                    }
                                                })
                                            }),
                                        ],
                                        &theme,
                                    )
                                },
                                &theme,
                            ))
                            .child(
                                div()
                                    .border_t_1()
                                    .border_color(theme.border_subtle)
                                    .pt(px(16.))
                                    .flex()
                                    .flex_col()
                                    .gap(px(12.))
                                    .child(
                                        kit::switch_row(
                                            "settings-write-mode-toggle",
                                            "Let your AI save changes",
                                            "Approve, edit, forget, and add memories. Every change is logged and can be traced back.",
                                            write_mode,
                                            &theme,
                                        )
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.set_write_mode(!write_mode, cx);
                                        })),
                                    )
                                    .when_some(preflight.human_message(), |col, msg| {
                                        col.child(
                                            div()
                                                .id("settings-write-preflight-warning")
                                                .role(Role::Status)
                                                .aria_label(msg.clone())
                                                .p(px(10.))
                                                .rounded(px(6.))
                                                .bg(theme.bg_sunken)
                                                .border_1()
                                                .border_color(theme.warning)
                                                .flex()
                                                .items_start()
                                                .gap(px(8.))
                                                .child(
                                                    div().pt(px(2.)).flex_shrink_0().child(
                                                        render_ui_icon(
                                                            UiIcon::Warning,
                                                            14.0,
                                                            theme.warning,
                                                        ),
                                                    ),
                                                )
                                                .child(
                                                    div()
                                                        .flex_1()
                                                        .min_w(px(0.))
                                                        .text_size(px(12.))
                                                        .line_height(px(17.))
                                                        .text_color(theme.text_secondary)
                                                        .child(SharedString::from(msg)),
                                                ),
                                        )
                                    })
                                    .child(
                                        div()
                                            .flex()
                                            .flex_col()
                                            .gap(px(8.))
                                            .child(
                                                div()
                                                    .text_size(px(12.))
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(theme.text_secondary)
                                                    .child("Writer command"),
                                            )
                                            .child(self.writer_cmd_input.clone())
                                            .child(
                                                div()
                                                    .flex()
                                                    .flex_wrap()
                                                    .items_center()
                                                    .justify_start()
                                                    .gap(px(8.))
                                                    .child(
                                                        div()
                                                            .id("settings-writer-test")
                                                            .focusable()
                                                            .role(Role::Button)
                                                            .aria_label("Test writer connection")
                                                            .h(px(28.))
                                                            .px(px(10.))
                                                            .rounded(px(6.))
                                                            .cursor_pointer()
                                                            .bg(theme.bg_elevated)
                                                            .border_1()
                                                            .border_color(theme.border_subtle)
                                                            .hover(move |s| s.bg(theme.bg_selected))
                                                            .flex()
                                                            .items_center()
                                                            .text_size(px(12.))
                                                            .text_color(theme.text_primary)
                                                            .on_click(cx.listener(|this, _, _, cx| {
                                                                this.run_writer_ping(cx);
                                                            }))
                                                            .child(if self.writer_testing {
                                                                "Testing…"
                                                            } else {
                                                                "Test connection"
                                                            }),
                                                    )
                                                    .when_some(detect_local_writer(), |row, local| {
                                                        let local_cmd = local.command.clone();
                                                        let already_active = self
                                                            .settings
                                                            .effective_writer_command()
                                                            == local_cmd;
                                                        row.child(
                                                            div()
                                                                .id("settings-writer-use-local")
                                                                .focusable()
                                                                .role(Role::Button)
                                                                .aria_label("Use local CLI")
                                                                .tooltip(tooltip_view(
                                                                    SharedString::from(format!(
                                                                        "Switch to local writer: {}",
                                                                        local.command
                                                                    )),
                                                                    theme,
                                                                ))
                                                                .h(px(28.))
                                                                .px(px(10.))
                                                                .rounded(px(6.))
                                                                .cursor_pointer()
                                                                .bg(if already_active {
                                                                    theme.bg_selected
                                                                } else {
                                                                    theme.bg_elevated
                                                                })
                                                                .border_1()
                                                                .border_color(if already_active {
                                                                    theme.accent
                                                                } else {
                                                                    theme.border_subtle
                                                                })
                                                                .hover(move |s| s.bg(theme.bg_selected))
                                                                .flex()
                                                                .items_center()
                                                                .text_size(px(12.))
                                                                .text_color(theme.text_primary)
                                                                .on_click(cx.listener(
                                                                    move |this, _, _, cx| {
                                                                        this.use_local_writer_command(
                                                                            local_cmd.clone(),
                                                                            cx,
                                                                        );
                                                                    },
                                                                ))
                                                                .child("Use local CLI"),
                                                        )
                                                    })
                                                    .child(
                                                        div()
                                                            .id("settings-writer-reset")
                                                            .focusable()
                                                            .role(Role::Button)
                                                            .aria_label("Reset writer command to default")
                                                            .h(px(28.))
                                                            .px(px(10.))
                                                            .rounded(px(6.))
                                                            .cursor_pointer()
                                                            .bg(gpui::transparent_black())
                                                            .border_1()
                                                            .border_color(theme.border_subtle)
                                                            .hover(move |s| s.bg(theme.bg_elevated))
                                                            .flex()
                                                            .items_center()
                                                            .text_size(px(12.))
                                                            .text_color(theme.text_secondary)
                                                            .on_click(cx.listener(|this, _, _, cx| {
                                                                this.reset_writer_command(cx);
                                                            }))
                                                            .child("Reset to default"),
                                                    )
                                                    .child(
                                                        div()
                                                            .text_size(px(11.))
                                                            .text_color(theme.text_muted)
                                                            .child(format!("Fallback: {DEFAULT_WRITER_COMMAND}")),
                                                    ),
                                            )
                                            .when_some(
                                                self.writer_test_status.clone(),
                                                |col, status| {
                                                    let (dot_color, text_color, msg) = match status {
                                                        Ok(info) => (
                                                            theme.success,
                                                            theme.success,
                                                            info.format_settings_status(),
                                                        ),
                                                        Err(err) => {
                                                            (theme.danger, theme.danger, err)
                                                        }
                                                    };
                                                    col.child(
                                                        div()
                                                            .id("settings-writer-status")
                                                            .role(Role::Status)
                                                            .aria_label(msg.clone())
                                                            .px(px(8.))
                                                            .py(px(6.))
                                                            .rounded(px(6.))
                                                            .bg(theme.bg_sunken)
                                                            .border_1()
                                                            .border_color(theme.border_subtle)
                                                            .flex()
                                                            .items_center()
                                                            .gap(px(6.))
                                                            .child(status_dot(dot_color))
                                                            .child(
                                                                div()
                                                                    .flex_1()
                                                                    .min_w(px(0.))
                                                                    .text_size(px(12.))
                                                                    .text_color(text_color)
                                                                    .child(SharedString::from(msg)),
                                                            ),
                                                    )
                                                },
                                            ),
                                    ),
                            )
                            .child(
                                div()
                                    .border_t_1()
                                    .border_color(theme.border_subtle)
                                    .pt(px(16.))
                                    .child(
                                        kit::switch_row(
                                            "settings-privacy-toggle",
                                            "Crash reporting",
                                            "Sends scrubbed panic reports only; memory text stays local.",
                                            crash_on,
                                            &theme,
                                        )
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.set_crash_consent(!crash_on, cx);
                                        })),
                                    ),
                            )
                            .child(
                                div()
                                    .border_t_1()
                                    .border_color(theme.border_subtle)
                                    .pt(px(16.))
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
                                                    .text_size(px(13.))
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(theme.text_primary)
                                                    .child("Memory store"),
                                            )
                                            .child(
                                                div()
                                                    .text_size(px(11.))
                                                    .text_color(theme.text_muted)
                                                    .child(self.resolved_db.source.label()),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .text_color(theme.text_secondary)
                                            .truncate()
                                            .child(self.resolved_db.path.display().to_string()),
                                    )
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .justify_start()
                                            .gap(px(8.))
                                            .child(
                                                kit::button(
                                                    "settings-switch-store",
                                                    "Switch store…",
                                                    kit::ButtonKind::Secondary,
                                                    &theme,
                                                )
                                                .on_click(cx.listener(|this, _, window, cx| {
                                                    this.flush_dirty_settings();
                                                    this.open_store_switcher(window, cx);
                                                })),
                                            )
                                            .child(
                                                kit::button(
                                                    "settings-reveal-db",
                                                    "Reveal",
                                                    kit::ButtonKind::Subtle,
                                                    &theme,
                                                )
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.reveal_database_file(cx);
                                                })),
                                            )
                                            .child(
                                                kit::button(
                                                    "settings-copy-db-path",
                                                    "Copy path",
                                                    kit::ButtonKind::Subtle,
                                                    &theme,
                                                )
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.copy_database_path(cx);
                                                })),
                                            )
                                            .child(if self.store_optimize_in_flight {
                                                kit::button_disabled(
                                                    "settings-optimize-store",
                                                    "Optimizing…",
                                                    "already running",
                                                    &theme,
                                                )
                                            } else {
                                                kit::button(
                                                    "settings-optimize-store",
                                                    "Optimize store",
                                                    kit::ButtonKind::Secondary,
                                                    &theme,
                                                )
                                                .aria_label("Optimize store indexes")
                                                .tooltip(tooltip_view(
                                                    SharedString::from(
                                                        "Adds missing read-path indexes. Safe and repeatable.",
                                                    ),
                                                    theme,
                                                ))
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.optimize_store(cx);
                                                }))
                                            }),
                                    ),
                            )
                            .child(
                                div()
                                    .border_t_1()
                                    .border_color(theme.border_subtle)
                                    .pt(px(16.))
                                    .flex()
                                    .flex_col()
                                    .gap(px(8.))
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text_primary)
                                            .child("Diagnostics"),
                                    )
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .justify_start()
                                            .gap(px(8.))
                                            .child(
                                                div()
                                                    .id("settings-open-logs")
                                                    .focusable()
                                                    .h(px(28.))
                                                    .px(px(10.))
                                                    .rounded(px(6.))
                                                    .cursor_pointer()
                                                    .bg(theme.bg_elevated)
                                                    .border_1()
                                                    .border_color(theme.border_subtle)
                                                    .hover(move |s| s.bg(theme.bg_selected))
                                                    .flex()
                                                    .items_center()
                                                    .text_size(px(12.))
                                                    .text_color(theme.text_primary)
                                                    .on_click(cx.listener(|this, _, _, cx| {
                                                        this.open_logs_folder(cx);
                                                    }))
                                                    .child("Open logs folder"),
                                            )
                                            .child(
                                                div()
                                                    .id("settings-copy-diag")
                                                    .focusable()
                                                    .h(px(28.))
                                                    .px(px(10.))
                                                    .rounded(px(6.))
                                                    .cursor_pointer()
                                                    .bg(gpui::transparent_black())
                                                    .border_1()
                                                    .border_color(theme.border_subtle)
                                                    .hover(move |s| s.bg(theme.bg_elevated))
                                                    .flex()
                                                    .items_center()
                                                    .text_size(px(12.))
                                                    .text_color(theme.text_secondary)
                                                    .on_click(cx.listener(|this, _, _, cx| {
                                                        this.copy_diagnostics(cx);
                                                    }))
                                                    .child("Copy diagnostics"),
                                            ),
                                    ),
                            ),
                        )
                        .child(render_vertical_scroll_overlay(
                            self.settings_scroll.clone(),
                            theme.bg_panel,
                            theme,
                        ))
                    )
                    .child(
                        div()
                            .id("settings-about-footer")
                            .px(px(24.))
                            .py(px(12.))
                            .bg(theme.bg_sunken)
                            .border_t_1()
                            .border_color(theme.border_subtle)
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .justify_between()
                            .gap(px(12.))
                            .text_size(px(12.))
                            .text_color(theme.text_muted)
                            .font_features(tabular_nums())
                            .child(format!(
                                "v{} · Built {}",
                                telemetry::APP_VERSION,
                                APP_BUILD_DATE
                            ))
                            .child({
                                let active_ping = self.active_writer_ping();
                                let footer_mode =
                                    PingResult::settings_footer_mode(write_mode, active_ping.as_ref());
                                div()
                                    .id("settings-footer-mode")
                                    .role(Role::Status)
                                    .aria_label(footer_mode.clone())
                                    .child(SharedString::from(footer_mode))
                            }),
                    ),
            )
            .into_any_element()
    }
}
