//! Window chrome: the root `Render` implementation and window helpers.

use super::*;

pub(super) fn preferred_window_background() -> WindowBackgroundAppearance {
    #[cfg(target_os = "windows")]
    {
        // GPUI handles the Windows 11 build guard and silently stays opaque on
        // older builds. Mica is sampled once by DWM, so it does not add frames.
        WindowBackgroundAppearance::MicaBackdrop
    }
    #[cfg(not(target_os = "windows"))]
    {
        WindowBackgroundAppearance::Opaque
    }
}

pub(super) fn window_bounds_to_setting(wb: WindowBounds) -> WindowBoundsSetting {
    let (rect, maximized) = match wb {
        WindowBounds::Windowed(r) => (r, false),
        WindowBounds::Maximized(r) | WindowBounds::Fullscreen(r) => (r, true),
    };
    WindowBoundsSetting {
        x: rect.origin.x.as_f32(),
        y: rect.origin.y.as_f32(),
        width: rect.size.width.as_f32(),
        height: rect.size.height.as_f32(),
        maximized,
    }
}

impl Render for MemOSApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        telemetry::note_root_render();
        // Read once per frame; the DB watcher's fallback poll backs off when
        // this is false, and the graph stops its drift loop while backgrounded.
        let active = window.is_window_active();
        if active != self.window_active {
            self.window_active = active;
            self.graph_view
                .update(cx, |graph, cx| graph.set_window_active(active, cx));
        }
        let first_render_start = if !self.first_frame_logged {
            Some(Instant::now())
        } else {
            None
        };

        if self.settings.theme == crate::core::settings::ThemeMode::System {
            let sys_theme = ThemePalette::resolve(
                crate::core::settings::ThemeMode::System,
                window.appearance(),
            );
            if sys_theme.is_dark != self.theme.is_dark {
                self.apply_theme_palette(sys_theme, window, cx);
            }
        }

        let theme = self.theme;
        if self.last_synced_titlebar_dark != Some(theme.is_dark) {
            sync_win32_titlebar(window, theme);
            self.last_synced_titlebar_dark = Some(theme.is_dark);
        }
        let viewport = window.viewport_size();
        let viewport_w = viewport.width;
        let viewport_h = viewport.height.as_f32();
        let is_compact = viewport_w < px(1040.);
        let detail_overlay = viewport_w < px(1600.);
        let overlay_w =
            (viewport_w - if is_compact { px(64.) } else { px(212.) }).clamp(px(280.), px(380.));
        if self.compact_layout != is_compact {
            self.compact_layout = is_compact;
            self.sidebar
                .update(cx, |s, cx| s.set_compact(is_compact, cx));
        }
        let empty_store = self.overview.as_ref().is_some_and(|ov| ov.node_count == 0);
        let show_detail = self.detail_open && self.selected_id.is_some() && !empty_store;
        let list_right_inset = if show_detail && detail_overlay {
            overlay_w
        } else {
            px(0.)
        };
        if self.list_view.read(cx).overlay_right_inset() != list_right_inset {
            self.list_view
                .update(cx, |l, cx| l.set_overlay_right_inset(list_right_inset, cx));
        }
        self.brief_view
            .update(cx, |b, cx| b.set_overlay_right_inset(list_right_inset, cx));
        self.review_view
            .update(cx, |r, cx| r.set_overlay_right_inset(list_right_inset, cx));

        let root: AnyElement = if let Some(onboarding) = &self.onboarding {
            div()
                .id("memos-onboarding-host")
                .w_full()
                .h_full()
                .min_w(px(0.))
                .overflow_hidden()
                .bg(theme.bg_app)
                .text_color(theme.text_primary)
                .child(onboarding.clone())
                .into_any_element()
        } else {
            let (mode_label, mode_dot) = if self.settings.write_mode {
                if self.write_in_flight {
                    ("Saving…", theme.accent)
                } else {
                    ("Editing on", theme.success)
                }
            } else {
                ("View only", theme.text_muted)
            };
            let footer_left: SharedString = if let Some(ov) = &self.overview {
                format_memory_count(ov.node_count).into()
            } else {
                "No database".into()
            };
            let footer_count_color = if self.is_celebrating_100() {
                theme.accent
            } else {
                theme.text_muted
            };
            let pin_count = self.pack.pins.len();

            div()
                .id("memos-desktop-root")
                .track_focus(&self.focus_handle)
                .on_key_down(cx.listener(Self::on_root_key_down))
                .on_mouse_move(cx.listener(|this, _, _, _| {
                    this.record_window_activity();
                }))
                .on_action(cx.listener(Self::on_open_palette))
                .on_action(cx.listener(Self::on_focus_search))
                .on_action(cx.listener(Self::on_switch_list))
                .on_action(cx.listener(Self::on_switch_graph))
                .on_action(cx.listener(Self::on_toggle_theme))
                .on_action(cx.listener(|this, _: &QuickCapture, window, cx| {
                    if !this.has_overlay_open(cx) || this.capture.open {
                        this.open_quick_capture(window, cx);
                    }
                }))
                .on_action(cx.listener(|this, _: &OpenTodaySurface, _, cx| {
                    this.open_today_view(cx);
                }))
                .on_action(cx.listener(|this, _: &OpenReviewSurface, _, cx| {
                    this.open_review_view(cx);
                }))
                .on_action(cx.listener(|this, _: &ToggleSearchSyntax, window, cx| {
                    this.toggle_search_help(window, cx);
                }))
                .on_action(cx.listener(|this, _: &ExportMemories, window, cx| {
                    if !this.has_overlay_open(cx) || this.pack.open {
                        this.open_export(window, cx);
                    }
                }))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|this, event: &MouseDownEvent, _, cx| {
                        this.record_window_activity();
                        // Dismiss popovers on the same mouse-down instead of a full-window
                        // backdrop. The backdrop occluded the click, so the first click only
                        // closed the popover and the target control never saw it.
                        //
                        // Keep the header band out of this: its trigger buttons own their
                        // open/close state, and dismissing first made a second click on the
                        // trigger look like it stayed open.
                        if event.position.y >= px(96.) && this.has_any_popover_open(cx) {
                            this.dismiss_popovers(PopoverOwner::None, cx);
                        }
                    }),
                )
                .relative()
                .w_full()
                .h_full()
                .min_w(px(0.))
                .overflow_hidden()
                .bg(theme.bg_app)
                .text_color(theme.text_primary)
                .flex()
                .flex_col()
                .child({
                    let scope_chips = scopes_from_filter(&self.filter);
                    div()
                        .min_h(px(56.))
                        .w_full()
                        .min_w(px(0.))
                        .overflow_hidden()
                        .px(px(16.))
                        .pt(px(12.))
                        .pb(px(if scope_chips.is_empty() { 10. } else { 8. }))
                        .bg(theme.bg_panel)
                        .border_b_1()
                        .border_color(theme.border_subtle)
                        .flex()
                        .items_start()
                        .justify_between()
                        .gap(px(12.))
                        // The slot above the sidebar names the open store and
                        // switches it, so search still lines up with the
                        // content column and the corner is no longer empty.
                        .child(self.render_header_store_switch(cx))
                        .child(
                            div().flex_1().min_w(px(120.)).flex().child(
                                div()
                                    .flex_1()
                                    .max_w(px(560.))
                                    .min_w(px(120.))
                                    .overflow_hidden()
                                    .flex()
                                    .flex_col()
                                    .gap(px(6.))
                                    .child(
                                        div()
                                            .relative()
                                            .w_full()
                                            .min_w(px(0.))
                                            .flex()
                                            .items_center()
                                            .gap(px(6.))
                                            .child(
                                                div()
                                                    .flex_1()
                                                    .min_w(px(0.))
                                                    .child(self.search_input.clone()),
                                            )
                                            .when(!self.filter.query.trim().is_empty(), |el| {
                                                el.child(
                                                    div()
                                                        .id("clear-search-btn")
                                                        .focusable()
                                                        .h(px(28.))
                                                        .px(px(8.))
                                                        .rounded(px(6.))
                                                        .cursor_pointer()
                                                        .bg(theme.bg_elevated)
                                                        .border_1()
                                                        .border_color(theme.border_subtle)
                                                        .hover(move |s| s.bg(theme.bg_selected))
                                                        .flex()
                                                        .items_center()
                                                        .text_size(px(12.))
                                                        .text_color(theme.text_secondary)
                                                        .on_click(cx.listener(|this, _, _, cx| {
                                                            this.search_input
                                                                .update(cx, |i, cx| i.clear(cx));
                                                        }))
                                                        .child("Clear"),
                                                )
                                            })
                                            .child(
                                                kit::button(
                                                    "search-syntax-btn",
                                                    "Syntax",
                                                    kit::ButtonKind::Subtle,
                                                    &theme,
                                                )
                                                .text_size(px(12.))
                                                .aria_expanded(self.search_ui.help_open)
                                                .tooltip(tooltip_view(
                                                    if cfg!(target_os = "macos") {
                                                        "Search scopes and recent searches (⌘ /)"
                                                    } else {
                                                        "Search scopes and recent searches (Ctrl /)"
                                                    },
                                                    theme,
                                                ))
                                                .on_click(cx.listener(|this, _, window, cx| {
                                                    this.toggle_search_help(window, cx);
                                                })),
                                            )
                                            .when(self.filter.query.trim().is_empty(), |el| {
                                                el.child(div().flex_shrink_0().pr(px(2.)).child(
                                                    keycap(
                                                        if cfg!(target_os = "macos") {
                                                            "⌘ K"
                                                        } else {
                                                            "Ctrl K"
                                                        },
                                                        &theme,
                                                    ),
                                                ))
                                            })
                                            .when(self.search_ui.help_open, |el| {
                                                el.child(self.render_search_help(cx))
                                            }),
                                    )
                                    .when(!scope_chips.is_empty(), |col| {
                                        col.child(
                                            div()
                                                .id("search-scope-chips")
                                                .w_full()
                                                .flex()
                                                .flex_wrap()
                                                .items_center()
                                                .gap(px(6.))
                                                .children(scope_chips.into_iter().enumerate().map(
                                                    |(ix, chip)| {
                                                        let kind = chip.kind;
                                                        div()
                                                            .id(("search-scope-chip", ix))
                                                            .focusable()
                                                            .role(Role::Button)
                                                            .aria_label(format!(
                                                                "Remove {}",
                                                                chip.label
                                                            ))
                                                            .h(px(22.))
                                                            .px(px(8.))
                                                            .rounded(px(11.))
                                                            .cursor_pointer()
                                                            .bg(theme.bg_elevated)
                                                            .border_1()
                                                            .border_color(theme.border_subtle)
                                                            .hover(move |s| {
                                                                s.border_color(theme.accent)
                                                            })
                                                            .flex()
                                                            .items_center()
                                                            .gap(px(5.))
                                                            .text_size(px(11.))
                                                            .text_color(theme.text_secondary)
                                                            .child(SharedString::from(chip.label))
                                                            .child(
                                                                div()
                                                                    .text_size(px(11.))
                                                                    .text_color(theme.text_muted)
                                                                    .child("×"),
                                                            )
                                                            .on_click(cx.listener(
                                                                move |this, _, _, cx| {
                                                                    this.remove_search_scope_chip(
                                                                        kind, cx,
                                                                    );
                                                                },
                                                            ))
                                                    },
                                                )),
                                        )
                                    }),
                            ),
                        )
                        .child(
                            div()
                                .flex_shrink_0()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .when(
                                    is_ingest_button_visible(self.settings.write_mode),
                                    |cluster| {
                                        cluster
                                            .child(
                                                kit::icon_button(
                                                    "header-ingest-btn",
                                                    UiIcon::Import,
                                                    "Ingest files or a folder",
                                                    &theme,
                                                )
                                                .tooltip(tooltip_view(
                                                    "Ingest files or a folder",
                                                    theme,
                                                ))
                                                .on_click(cx.listener(|this, _, window, cx| {
                                                    this.open_ingest_modal(window, cx);
                                                })),
                                            )
                                            .child(
                                                kit::button(
                                                    "header-capture-btn",
                                                    "Capture",
                                                    kit::ButtonKind::Secondary,
                                                    &theme,
                                                )
                                                .tooltip(tooltip_view(
                                                    if cfg!(target_os = "macos") {
                                                        "Capture a memory (⌘ N)"
                                                    } else {
                                                        "Capture a memory (Ctrl N)"
                                                    },
                                                    theme,
                                                ))
                                                .on_click(cx.listener(|this, _, window, cx| {
                                                    this.open_quick_capture(window, cx);
                                                })),
                                            )
                                    },
                                )
                                .child(
                                    div()
                                        .id("view-switch-tablist")
                                        .role(Role::TabList)
                                        .p(px(2.))
                                        .rounded(px(6.))
                                        .bg(theme.bg_app)
                                        .border_1()
                                        .border_color(theme.border_subtle)
                                        .flex()
                                        .items_center()
                                        .gap(px(2.))
                                        .child({
                                            let is_list_active = self.active_surface
                                                == WorkspaceSurface::Memories
                                                && self.view_mode == ViewMode::List;
                                            div()
                                                .id("view-switch-list")
                                                .focusable()
                                                .role(Role::Tab)
                                                .aria_label("List view")
                                                .aria_selected(is_list_active)
                                                .h(px(28.))
                                                .px(px(12.))
                                                .rounded(px(5.))
                                                .cursor_pointer()
                                                .flex()
                                                .items_center()
                                                .text_size(px(13.))
                                                .when(is_list_active, |el| {
                                                    el.bg(theme.bg_elevated)
                                                        .text_color(theme.text_primary)
                                                        .font_weight(FontWeight::MEDIUM)
                                                })
                                                .when(!is_list_active, |el| {
                                                    el.text_color(theme.text_muted).hover(|s| {
                                                        s.bg(theme.bg_selected)
                                                            .text_color(theme.text_primary)
                                                    })
                                                })
                                                .focus_visible(move |s| {
                                                    s.border_1().border_color(theme.accent)
                                                })
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.switch_view(ViewMode::List, cx);
                                                }))
                                                .child("List")
                                        })
                                        .child({
                                            let is_graph_active = self.active_surface
                                                == WorkspaceSurface::Memories
                                                && self.view_mode == ViewMode::Graph;
                                            div()
                                                .id("view-switch-graph")
                                                .focusable()
                                                .role(Role::Tab)
                                                .aria_label("Graph view")
                                                .aria_selected(is_graph_active)
                                                .h(px(28.))
                                                .px(px(12.))
                                                .rounded(px(5.))
                                                .cursor_pointer()
                                                .flex()
                                                .items_center()
                                                .text_size(px(13.))
                                                .when(is_graph_active, |el| {
                                                    el.bg(theme.bg_elevated)
                                                        .text_color(theme.text_primary)
                                                        .font_weight(FontWeight::MEDIUM)
                                                })
                                                .when(!is_graph_active, |el| {
                                                    el.text_color(theme.text_muted).hover(|s| {
                                                        s.bg(theme.bg_selected)
                                                            .text_color(theme.text_primary)
                                                    })
                                                })
                                                .focus_visible(move |s| {
                                                    s.border_1().border_color(theme.accent)
                                                })
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.switch_view(ViewMode::Graph, cx);
                                                }))
                                                .child("Graph")
                                        }),
                                )
                                .child(
                                    div()
                                        .relative()
                                        .child({
                                            let overflow_expand = cx.entity().clone();
                                            let overflow_collapse = overflow_expand.clone();
                                            div()
                                                .id("top-overflow-btn")
                                                .focusable()
                                                .role(Role::Button)
                                                .aria_label("More actions")
                                                .aria_expanded(self.show_overflow_menu)
                                                .when(!self.show_overflow_menu, |el| {
                                                    el.tooltip(tooltip_view("More actions", theme))
                                                })
                                                .w(px(32.))
                                                .h(px(32.))
                                                .rounded(px(6.))
                                                .cursor_pointer()
                                                .bg(if self.show_overflow_menu {
                                                    theme.bg_elevated
                                                } else {
                                                    gpui::transparent_black()
                                                })
                                                .border_1()
                                                .border_color(theme.border_subtle)
                                                .hover(move |s| s.bg(theme.bg_elevated))
                                                .focus_visible(move |s| {
                                                    s.border_1().border_color(theme.accent)
                                                })
                                                .flex()
                                                .items_center()
                                                .justify_center()
                                                .text_size(px(14.))
                                                .text_color(theme.text_primary)
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    let next = !this.show_overflow_menu;
                                                    if next {
                                                        this.dismiss_popovers(
                                                            PopoverOwner::Overflow,
                                                            cx,
                                                        );
                                                    }
                                                    this.show_overflow_menu = next;
                                                    cx.notify();
                                                }))
                                                .on_a11y_action(
                                                    AccessibleAction::Expand,
                                                    move |_, _, cx| {
                                                        overflow_expand.update(cx, |this, cx| {
                                                            this.dismiss_popovers(
                                                                PopoverOwner::Overflow,
                                                                cx,
                                                            );
                                                            this.show_overflow_menu = true;
                                                            cx.notify();
                                                        });
                                                    },
                                                )
                                                .on_a11y_action(
                                                    AccessibleAction::Collapse,
                                                    move |_, _, cx| {
                                                        overflow_collapse.update(cx, |this, cx| {
                                                            this.show_overflow_menu = false;
                                                            cx.notify();
                                                        });
                                                    },
                                                )
                                                .child(render_ui_icon(
                                                    UiIcon::Overflow,
                                                    16.0,
                                                    theme.text_primary,
                                                ))
                                        })
                                        .when(self.show_overflow_menu, |wrap| {
                                            wrap.child(
                                                div()
                                                    .absolute()
                                                    .top(px(38.))
                                                    .right(px(0.))
                                                    .child(self.render_overflow_menu(cx)),
                                            )
                                        }),
                                ),
                        )
                })
                .when_some(self.write_bridge_error.clone(), |col, banner| {
                    col.child(self.render_write_error_banner(banner, cx))
                })
                .child(
                    div()
                        .relative()
                        .flex_1()
                        .min_h_0()
                        .min_w(px(0.))
                        .w_full()
                        .overflow_hidden()
                        .flex()
                        .child(self.sidebar.clone())
                        .child(match self.active_surface {
                            WorkspaceSurface::Today => self.brief_view.clone().into_any_element(),
                            WorkspaceSurface::Review => self.review_view.clone().into_any_element(),
                            WorkspaceSurface::Memories => match self.view_mode {
                                ViewMode::List => self.list_view.clone().into_any_element(),
                                ViewMode::Graph => self.graph_view.clone().into_any_element(),
                            },
                        })
                        .when(show_detail && !detail_overlay, |row| {
                            row.child(
                                div()
                                    .w(px(360.))
                                    .h_full()
                                    .flex_shrink_0()
                                    .overflow_hidden()
                                    .child(self.detail_view.clone()),
                            )
                        })
                        .when(show_detail && detail_overlay, |row| {
                            row.child(
                                div()
                                    .id("detail-overlay-pane")
                                    .absolute()
                                    .top(px(0.))
                                    .right(px(0.))
                                    .bottom(px(0.))
                                    .w(overlay_w)
                                    .max_w_full()
                                    .bg(theme.bg_panel)
                                    .border_l_1()
                                    .border_color(theme.border_subtle)
                                    .shadow_lg()
                                    .overflow_hidden()
                                    .occlude()
                                    .on_mouse_down(MouseButton::Left, |_, _, cx| {
                                        cx.stop_propagation();
                                    })
                                    // Do not stop wheel events here: the detail view owns a
                                    // tracked scroll body, and stopping at the overlay prevented
                                    // that body from scrolling while the list also stayed put.
                                    .child(self.detail_view.clone()),
                            )
                        }),
                )
                .child(
                    div()
                        .h(px(28.))
                        .w_full()
                        .min_w(px(0.))
                        .overflow_hidden()
                        .pl(if self.no_fun { px(16.) } else { px(4.) })
                        .pr(px(16.))
                        .bg(theme.bg_panel)
                        .border_t_1()
                        .border_color(theme.border_subtle)
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(12.))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(4.))
                                .min_w(px(0.))
                                .when(!self.no_fun, |row| {
                                    let app_entity = cx.entity().clone();
                                    row.child(
                                        div()
                                            .id("footer-momo-wrap")
                                            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                                                if this.momo_hovered != *hovered {
                                                    this.momo_hovered = *hovered;
                                                    cx.notify();
                                                }
                                            }))
                                            .child(render_momo_button(
                                                "footer-momo",
                                                18.0,
                                                self.health_status,
                                                self.momo_peek_sample.slide_px,
                                                self.momo_peek_sample.eye_open,
                                                theme,
                                                move |_, window, cx| {
                                                    app_entity.update(cx, |this, cx| {
                                                        this.open_health_modal_from_momo(
                                                            window, cx,
                                                        );
                                                    });
                                                },
                                            )),
                                    )
                                })
                                .child(
                                    div()
                                        .id("footer-mode-status")
                                        .role(Role::Status)
                                        .aria_label(SharedString::from(format!(
                                            "{footer_left}, {mode_label}"
                                        )))
                                        .flex()
                                        .items_center()
                                        .gap(px(10.))
                                        .text_size(px(12.))
                                        .font_features(tabular_nums())
                                        .child(
                                            div()
                                                .text_color(footer_count_color)
                                                .truncate()
                                                .child(footer_left),
                                        )
                                        .child(
                                            div()
                                                .flex()
                                                .items_center()
                                                .gap(px(5.))
                                                .text_color(theme.text_secondary)
                                                .child(status_dot(mode_dot))
                                                .child(mode_label),
                                        ),
                                ),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(12.))
                                .min_w(px(0.))
                                .when_some(self.status_notice.clone(), |el, msg| {
                                    el.child(
                                        div()
                                            .id("footer-notice")
                                            .role(Role::Status)
                                            .text_size(px(12.))
                                            .text_color(theme.text_secondary)
                                            .truncate()
                                            .child(SharedString::from(msg)),
                                    )
                                })
                                .when(pin_count > 0, |el| {
                                    el.child(
                                        kit::button(
                                            "footer-pins",
                                            format!("{pin_count} pinned"),
                                            kit::ButtonKind::Subtle,
                                            &theme,
                                        )
                                        .h(px(22.))
                                        .text_size(px(12.))
                                        .tooltip(tooltip_view("Open the context pack (C)", theme))
                                        .on_click(
                                            cx.listener(|this, _, window, cx| {
                                                this.open_context_pack(
                                                    Some(PackSource::Pinned),
                                                    window,
                                                    cx,
                                                );
                                            }),
                                        ),
                                    )
                                }),
                        ),
                )
                .when(self.momo_hovered && !self.has_overlay_open(cx), |el| {
                    el.child(
                        gpui::deferred(
                            div()
                                .id("momo-footer-tooltip")
                                .absolute()
                                .bottom(px(36.))
                                .left(px(12.))
                                .px(px(10.))
                                .py(px(5.))
                                .rounded(px(6.))
                                .bg(theme.bg_elevated)
                                .border_1()
                                .border_color(theme.border_subtle)
                                .shadow_md()
                                .text_size(px(12.))
                                .text_color(theme.text_primary)
                                .child("Momo — memory mote"),
                        )
                        .with_priority(10),
                    )
                })
                .child(self.palette.clone())
                .when(self.show_harnesses_modal, |el| {
                    el.child(self.render_harnesses_modal(cx))
                })
                .when(self.show_settings_modal, |el| {
                    el.child(self.render_settings_modal(window, cx))
                })
                .when(self.show_health_modal, |el| {
                    el.child(self.render_health_center(cx))
                })
                .when(self.show_dream_diff_modal, |el| {
                    el.child(self.render_dream_diff_modal(cx))
                })
                .when(self.show_shortcuts_modal, |el| {
                    el.child(self.render_shortcut_sheet(cx))
                })
                .when(self.pack.open, |el| {
                    el.child(self.render_pack_modal(viewport_h, cx))
                })
                .when(self.compare.open, |el| {
                    el.child(self.render_compare_modal(viewport_h, cx))
                })
                .when(self.capture.open, |el| {
                    el.child(self.render_quick_capture(cx))
                })
                .when(self.store_switch.open, |el| {
                    el.child(self.render_store_switcher(cx))
                })
                .when(self.search_ui.manage_view_id.is_some(), |el| {
                    el.child(self.render_manage_view(cx))
                })
                .when(self.show_save_view_modal, |el| {
                    el.child(self.render_save_view_dialog(cx))
                })
                .when(self.show_composer_modal, |el| {
                    el.child(self.render_composer_dialog(cx))
                })
                .when(self.show_ingest_modal, |el| {
                    el.child(self.render_ingest_dialog(cx))
                })
                .when_some(self.forget_confirm_target.clone(), |el, target| {
                    el.child(self.render_forget_dialog(target, cx))
                })
                .when(self.show_consent_modal, |el| {
                    el.child(self.render_consent_modal(cx))
                })
                .into_any_element()
        };

        if let Some(render_start) = first_render_start {
            self.first_frame_logged = true;
            let render_end = Instant::now();
            self.timeline
                .record_span("first_render", render_start, render_end);
            let tl = self.timeline.clone();
            let this_entity = cx.entity().clone();
            let smoke = self.smoke_exit_after_first_frame;
            window.on_next_frame(move |window, cx| {
                let frame_at = Instant::now();
                tl.record_span("first_frame", render_end, frame_at);
                let ms = tl.elapsed_ms(frame_at);
                if smoke {
                    println!("FIRST_FRAME_MS={ms:.2}");
                }
                let _ = tl.write_report_if_configured();
                this_entity.update(cx, |app, cx| {
                    app.first_frame_done = true;
                    sync_win32_titlebar(window, app.theme);
                    app.last_synced_titlebar_dark = Some(app.theme.is_dark);
                    if app.onboarding.is_none()
                        && app.harnesses.is_empty()
                        && !app.smoke_exit_after_first_frame
                    {
                        app.spawn_harness_detection(cx);
                    }
                    app.maybe_finish_startup_exit(cx);
                    cx.notify();
                });
            });
        }

        root
    }
}
