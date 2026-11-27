//! The Tools (harness connections) dialog and its background detection.

use super::*;

impl MemOSApp {
    pub(super) fn spawn_harness_detection(&mut self, cx: &mut Context<Self>) {
        self._harness_task = Some(cx.spawn(async move |this, cx| {
            let detected = cx
                .background_executor()
                .spawn(async move { harness::detect_all() })
                .await;

            let _ = this.update(cx, |app, cx| {
                let installed = detected.iter().filter(|h| h.installed).count();
                let total = detected.len();
                tracing::info!(
                    installed_harnesses = installed,
                    total_harnesses = total,
                    "read-only harness detection finished"
                );
                app.harnesses = detected;
                app.sidebar
                    .update(cx, |s, cx| s.set_harness_summary(installed, total, cx));
                if app.show_harnesses_modal && app.harness_inspector.is_none() {
                    app.spawn_harness_detail(app.selected_harness_ix, cx);
                }
                cx.notify();
            });
        }));
    }

    pub(super) fn spawn_harness_detail(&mut self, ix: usize, cx: &mut Context<Self>) {
        self.selected_harness_ix = ix;
        self.pending_connect_id = None;
        self._harness_detail_task = Some(cx.spawn(async move |this, cx| {
            let details = cx
                .background_executor()
                .spawn(async move {
                    let adapters = harness::all_adapters();
                    adapters.get(ix).map(|adapter| HarnessInspectorData {
                        detection: adapter.detect(),
                        servers: adapter.mcp_servers(),
                        plan: adapter.plan_memos_install(),
                        reveal_path: adapter.reveal_target_path(),
                    })
                })
                .await;

            let _ = this.update(cx, |app, cx| {
                // The initial inspector request can finish after the user has
                // already selected another harness; never let a stale result
                // overwrite the current row.
                if app.selected_harness_ix == ix {
                    app.harness_inspector = details;
                    cx.notify();
                }
            });
        }));
    }

    pub(super) fn render_harnesses_modal(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let installed_count = self.harnesses.iter().filter(|d| d.installed).count();
        let total_harnesses = self.harnesses.len();
        let opencode_v2_installed = self
            .harnesses
            .iter()
            .any(|h| h.id == "opencode" && h.installed);
        let opencode_v1_installed = self
            .harnesses
            .iter()
            .any(|h| h.id == "opencode-v1" && h.installed);
        let harness_rows: Vec<AnyElement> = self
            .harnesses
            .iter()
            .enumerate()
            .map(|(ix, det)| {
                let selected = ix == self.selected_harness_ix;
                let dot_color = if det.memos_configured {
                    theme.success
                } else if det.installed {
                    theme.text_secondary
                } else {
                    theme.border
                };
                let is_legacy_sibling = !det.installed
                    && ((det.id == "opencode-v1" && opencode_v2_installed)
                        || (det.id == "opencode" && opencode_v1_installed));
                let base_sub = if let Some(ver) = det.version.as_deref() {
                    ver.to_string()
                } else if det.memos_configured {
                    "Connected".to_string()
                } else if det.installed {
                    "Installed".to_string()
                } else if is_legacy_sibling {
                    "Not detected · legacy".to_string()
                } else {
                    "Not found".to_string()
                };
                let subtitle = if det.print_only {
                    format!("{base_sub} · Print-only")
                } else {
                    base_sub
                };
                div()
                    .id(("harness-row", ix))
                    .focusable()
                    .role(Role::ListItem)
                    .aria_label(if det.display_name.contains(det.id) {
                        format!("{} · {}", det.display_name, subtitle)
                    } else {
                        format!("{} ({}) · {}", det.display_name, det.id, subtitle)
                    })
                    .aria_selected(selected)
                    .w_full()
                    .h(px(48.))
                    .px(px(10.))
                    .rounded(px(6.))
                    .cursor_pointer()
                    .bg(if selected {
                        theme.bg_selected
                    } else {
                        gpui::transparent_black()
                    })
                    .hover(move |s| s.bg(theme.bg_elevated))
                    .focus_visible(move |s| s.border_1().border_color(theme.accent))
                    // Select on press, not release. The first click after the modal
                    // opens was only painting hover; the inspector caught up on the
                    // second click. Press-to-select makes the row and inspector agree
                    // immediately.
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _, _, cx| {
                            this.spawn_harness_detail(ix, cx);
                        }),
                    )
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .w(px(2.))
                            .h(px(22.))
                            .rounded(px(1.))
                            .flex_shrink_0()
                            .bg(if selected {
                                theme.accent
                            } else {
                                gpui::transparent_black()
                            }),
                    )
                    .child(status_dot(dot_color))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(1.))
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .font_weight(if selected {
                                        FontWeight::MEDIUM
                                    } else {
                                        FontWeight::NORMAL
                                    })
                                    .text_color(theme.text_primary)
                                    .truncate()
                                    .child(det.display_name),
                            )
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(theme.text_muted)
                                    .truncate()
                                    .child(SharedString::from(subtitle)),
                            ),
                    )
                    .into_any_element()
            })
            .collect();

        let inspector_pane: AnyElement = if let Some(info) = &self.harness_inspector {
            let harness_id = info.detection.id;
            let harness_display = info.detection.display_name;
            let stdio_snippet = info.plan.stdio_snippet.clone();
            let target_cfg_text = info.plan.target_config_path.display().to_string();
            let backup_cfg_text = info.plan.backup_path.display().to_string();
            let diff_preview_text = info.plan.diff_preview.clone();
            let connect_pending = self.pending_connect_id == Some(harness_id);
            let reveal_target = info.reveal_path.clone();
            let db_path_for_launch = self.resolved_db.path.clone();
            let config_summary = info
                .detection
                .config_paths
                .first()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| {
                    format!("{} (not created)", info.plan.target_config_path.display())
                });
            let status_color = if info.detection.memos_configured {
                theme.success
            } else if info.detection.installed {
                theme.text_secondary
            } else {
                theme.text_muted
            };
            let inspector_is_legacy = !info.detection.installed
                && ((info.detection.id == "opencode-v1" && opencode_v2_installed)
                    || (info.detection.id == "opencode" && opencode_v1_installed));
            let status_text = if info.detection.memos_configured {
                "MemOS MCP connected"
            } else if info.detection.installed {
                "Installed · Ready to connect"
            } else if inspector_is_legacy {
                "Legacy · not detected (other OpenCode major installed)"
            } else {
                "Not detected on this machine"
            };
            let servers_list: Vec<AnyElement> = info
                .servers
                .iter()
                .map(|srv| {
                    let transport = match &srv.transport {
                        McpTransport::Stdio { command, args } => {
                            format!("stdio: {} {}", command, args.join(" "))
                        }
                        McpTransport::Http { url } => format!("http: {url}"),
                    };
                    div()
                        .p(px(8.))
                        .rounded(px(6.))
                        .bg(theme.bg_app)
                        .border_1()
                        .border_color(theme.border_subtle)
                        .text_size(px(12.))
                        .text_color(theme.text_secondary)
                        .child(SharedString::from(format!(
                            "{} ({transport}) — {}",
                            srv.name,
                            srv.source_path.display()
                        )))
                        .into_any_element()
                })
                .collect();

            let is_print_only = info.detection.print_only || info.plan.print_only;
            let plan_notes = info.plan.notes.clone();

            div()
                .id("harness-detail-scroll")
                .flex_1()
                .min_w_0()
                .min_h_0()
                .overflow_y_scroll()
                .p(px(20.))
                .flex()
                .flex_col()
                .gap(px(16.))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(6.))
                        .child(
                            div()
                                .flex()
                                .flex_wrap()
                                .items_center()
                                .gap(px(8.))
                                .child(
                                    div()
                                        .text_size(px(19.))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(theme.text_primary)
                                        .child(info.detection.display_name),
                                )
                                .when(is_print_only, |row| {
                                    row.child(
                                        div()
                                            .id("harness-print-only-badge")
                                            .role(Role::Status)
                                            .aria_label("Print-only")
                                            .h(px(20.))
                                            .px(px(8.))
                                            .rounded(px(99.))
                                            .bg(theme.bg_elevated)
                                            .border_1()
                                            .border_color(theme.border)
                                            .flex()
                                            .items_center()
                                            .text_size(px(11.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text_secondary)
                                            .child("Print-only"),
                                    )
                                }),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .child(status_dot(status_color))
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .text_color(theme.text_secondary)
                                        .child(match &info.detection.version {
                                            Some(v) => format!("{status_text} · {v}"),
                                            None => status_text.to_string(),
                                        }),
                                ),
                        )
                        .child(
                            div()
                                .text_size(px(13.))
                                .line_height(px(18.))
                                .text_color(theme.text_muted)
                                .child(if is_print_only {
                                    "Print-only integration: copy the generated snippet below without overwriting your existing tool config files."
                                } else {
                                    "Launch an isolated session wired to your local MemOS store without modifying global config files."
                                }),
                        )
                        .when(!plan_notes.trim().is_empty(), |col| {
                            col.child(
                                div()
                                    .id("harness-plan-notes")
                                    .role(Role::Note)
                                    .aria_label(plan_notes.clone())
                                    .mt(px(4.))
                                    .p(px(10.))
                                    .rounded(px(6.))
                                    .bg(theme.bg_app)
                                    .border_1()
                                    .border_color(theme.border_subtle)
                                    .text_size(px(12.))
                                    .line_height(px(17.))
                                    .text_color(theme.text_secondary)
                                    .child(SharedString::from(plan_notes)),
                            )
                        }),
                )
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(8.))
                        .child(
                            div()
                                .id("harness-launch-memos-btn")
                                .focusable()
                                .role(Role::Button)
                                .aria_label(format!("Connect {harness_display}"))
                                .h(px(34.))
                                .px(px(16.))
                                .rounded(px(6.))
                                .cursor_pointer()
                                .bg(theme.accent)
                                .focus_visible(move |s| s.border_2().border_color(theme.text_primary))
                                .flex()
                                .items_center()
                                .text_size(px(13.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.primary_btn_fg)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.pending_connect_id = Some(harness_id);
                                    cx.notify();
                                }))
                                .child("Connect"),
                        )
                        .child(
                            div()
                                .id("launch-harness-btn")
                                .focusable()
                                .role(Role::Button)
                                .aria_label(format!("Open {harness_display} in terminal"))
                                .h(px(34.))
                                .px(px(12.))
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
                                .on_click(cx.listener(move |_this, _, _, cx| {
                                    cx.spawn(async move |weak, cx| {
                                        let outcome = cx
                                            .background_executor()
                                            .spawn(async move {
                                                let adapter = harness::all_adapters()
                                                    .into_iter()
                                                    .find(|a| a.id() == harness_id)
                                                    .ok_or_else(|| {
                                                        anyhow::anyhow!("Tool adapter missing")
                                                    })?;
                                                adapter.launch()
                                            })
                                            .await;
                                        let _ = weak.update(cx, |app, cx| match outcome {
                                            Ok(()) => app.set_notice(
                                                format!("Opened {harness_display} in terminal"),
                                                cx,
                                            ),
                                            Err(err) => app.set_notice(
                                                format!(
                                                    "Could not open {harness_display}: {err}"
                                                ),
                                                cx,
                                            ),
                                        });
                                    })
                                    .detach();
                                }))
                                .child("Open terminal"),
                        )
                        .child(
                            div()
                                .id("harness-copy-snippet-btn")
                                .focusable()
                                .role(Role::Button)
                                .aria_label(format!("Copy MCP snippet for {harness_display}"))
                                .h(px(34.))
                                .px(px(12.))
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
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    cx.write_to_clipboard(ClipboardItem::new_string(
                                        stdio_snippet.clone(),
                                    ));
                                    this.set_notice(
                                        format!("Copied MCP snippet for {harness_display}"),
                                        cx,
                                    );
                                }))
                                .child("Copy MCP snippet"),
                        ),
                )
                .when(connect_pending, |col| {
                    let db_path_confirmed = db_path_for_launch.clone();
                    col.child(
                        div()
                            .id("harness-connect-confirm")
                            .p(px(14.))
                            .rounded(px(8.))
                            .bg(theme.bg_app)
                            .border_1()
                            .border_color(theme.border_subtle)
                            .flex()
                            .flex_col()
                            .gap(px(10.))
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme.text_primary)
                                    .child(format!("Review connection plan for {harness_display}")),
                            )
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .line_height(px(17.))
                                    .text_color(theme.text_secondary)
                                    .child("Isolated session launch sets MEMOS_DB and leaves your global config file untouched. Config & backup plan:"),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(4.))
                                    .text_size(px(12.))
                                    .text_color(theme.text_muted)
                                    .child(SharedString::from(format!("Target config: {target_cfg_text}")))
                                    .child(SharedString::from(format!("Backup path:   {backup_cfg_text}"))),
                            )
                            .child(
                                div()
                                    .id("harness-connect-diff-scroll")
                                    .max_h(px(96.))
                                    .overflow_y_scroll()
                                    .p(px(10.))
                                    .rounded(px(6.))
                                    .bg(theme.bg_sunken)
                                    .border_1()
                                    .border_color(theme.border_subtle)
                                    .text_size(px(12.))
                                    .line_height(px(17.))
                                    .text_color(theme.text_secondary)
                                    .child(SharedString::from(diff_preview_text.clone())),
                            )
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_end()
                                    .gap(px(8.))
                                    .child(
                                        div()
                                            .id("harness-cancel-connect-btn")
                                            .focusable()
                                            .role(Role::Button)
                                            .aria_label("Cancel connect")
                                            .cursor_pointer()
                                            .h(px(30.))
                                            .px(px(12.))
                                            .rounded(px(6.))
                                            .bg(theme.bg_elevated)
                                            .border_1()
                                            .border_color(theme.border_subtle)
                                            .hover(move |s| s.bg(theme.bg_selected))
                                            .flex()
                                            .items_center()
                                            .text_size(px(12.))
                                            .text_color(theme.text_primary)
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.pending_connect_id = None;
                                                cx.notify();
                                            }))
                                            .child("Cancel"),
                                    )
                                    .child(
                                        div()
                                            .id("harness-confirm-connect-btn")
                                            .focusable()
                                            .role(Role::Button)
                                            .aria_label(format!("Confirm connect {harness_display}"))
                                            .cursor_pointer()
                                            .h(px(30.))
                                            .px(px(14.))
                                            .rounded(px(6.))
                                            .bg(theme.accent)
                                            .hover(move |s| s.opacity(0.9))
                                            .flex()
                                            .items_center()
                                            .text_size(px(12.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.primary_btn_fg)
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                this.pending_connect_id = None;
                                                let db_path = db_path_confirmed.clone();
                                                cx.spawn(async move |weak, cx| {
                                                    let outcome = cx
                                                        .background_executor()
                                                        .spawn(async move {
                                                            let adapter = harness::all_adapters()
                                                                .into_iter()
                                                                .find(|a| a.id() == harness_id)
                                                                .ok_or_else(|| {
                                                                    anyhow::anyhow!("Tool adapter missing")
                                                                })?;
                                                            adapter.launch_with_memos(&db_path)
                                                        })
                                                        .await;
                                                    let _ = weak.update(cx, |app, cx| match outcome {
                                                        Ok(spec) => {
                                                            let note = if spec.uses_temp_mcp_config {
                                                                format!(
                                                                    "Connected {harness_display} with temporary MCP config"
                                                                )
                                                            } else {
                                                                format!(
                                                                    "Connected {harness_display} with MEMOS_DB env"
                                                                )
                                                            };
                                                            app.set_notice(note, cx);
                                                        }
                                                        Err(err) => {
                                                            app.set_notice(
                                                                format!(
                                                                    "Could not launch {harness_display}: {err}"
                                                                ),
                                                                cx,
                                                            );
                                                        }
                                                    });
                                                })
                                                .detach();
                                                cx.notify();
                                            }))
                                            .child("Confirm & launch"),
                                    ),
                            ),
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
                                .id("tools-advanced-toggle")
                                .focusable()
                                .cursor_pointer()
                                .h(px(28.))
                                .px(px(4.))
                                .rounded(px(6.))
                                .hover(move |s| s.bg(theme.bg_elevated))
                                .flex()
                                .items_center()
                                .justify_between()
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.tools_advanced_open = !this.tools_advanced_open;
                                    cx.notify();
                                }))
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(theme.text_primary)
                                        .child("Advanced"),
                                )
                                .child(render_ui_icon(
                                    if self.tools_advanced_open {
                                        UiIcon::ChevronDown
                                    } else {
                                        UiIcon::ChevronRight
                                    },
                                    14.0,
                                    theme.text_muted,
                                )),
                        )
                        .when(self.tools_advanced_open, |adv| {
                            adv.child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(10.))
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .justify_between()
                                            .gap(px(8.))
                                            .child(
                                                div()
                                                    .flex_1()
                                                    .min_w_0()
                                                    .text_size(px(12.))
                                                    .text_color(theme.text_muted)
                                                    .truncate()
                                                    .child(format!("Config: {config_summary}")),
                                            )
                                            .child(
                                                div()
                                                    .id("harness-reveal-config-btn")
                                                    .focusable()
                                                    .h(px(26.))
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
                                                    .text_color(if reveal_target.is_some() {
                                                        theme.text_primary
                                                    } else {
                                                        theme.text_muted
                                                    })
                                                    .on_click(cx.listener(move |this, _, _, cx| {
                                                        if let Some(target) = &reveal_target {
                                                            cx.reveal_path(target);
                                                            this.set_notice(
                                                                "Revealed config location",
                                                                cx,
                                                            );
                                                        } else {
                                                            this.set_notice(
                                                                "No config file on disk",
                                                                cx,
                                                            );
                                                        }
                                                    }))
                                                    .child("Reveal"),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text_muted)
                                            .child("Detected MCP servers"),
                                    )
                                    .when(servers_list.is_empty(), |el| {
                                        el.child(
                                            div()
                                                .text_size(px(12.))
                                                .text_color(theme.text_muted)
                                                .child("No existing MCP entries found."),
                                        )
                                    })
                                    .children(servers_list)
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text_muted)
                                            .child(SharedString::from(format!(
                                                "Install plan preview (not applied · backup: {})",
                                                info.plan.backup_path.display()
                                            ))),
                                    )
                                    .child(
                                        div()
                                            .w_full()
                                            .min_w_0()
                                            .p(px(10.))
                                            .rounded(px(6.))
                                            .bg(theme.bg_app)
                                            .border_1()
                                            .border_color(theme.border_subtle)
                                            .text_size(px(12.))
                                            .text_color(theme.text_secondary)
                                            .child(SharedString::from(
                                                info.plan.diff_preview.clone(),
                                            )),
                                    ),
                            )
                        }),
                )
                .into_any_element()
        } else {
            div()
                .flex_1()
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(13.))
                .text_color(theme.text_muted)
                .child("Checking installed tools…")
                .into_any_element()
        };

        let dismiss = cx.entity();
        kit::ModalShell::new("harness-dialog", "Tools")
            .subtitle(SharedString::from(format!(
                "{installed_count} installed · {total_harnesses} supported"
            )))
            .width(780.)
            .height(580.)
            .flush_body()
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .child(
                        div()
                            .id("harness-list-scroll")
                            .w(px(224.))
                            .h_full()
                            .min_h_0()
                            .overflow_y_scroll()
                            .p(px(8.))
                            .border_r_1()
                            .border_color(theme.border_subtle)
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .children(harness_rows),
                    )
                    .child(inspector_pane),
            )
            .render(
                &theme,
                std::rc::Rc::new(move |window, cx| {
                    dismiss.update(cx, |app, cx| {
                        app.show_harnesses_modal = false;
                        app.pending_connect_id = None;
                        window.focus(&app.focus_handle, cx);
                        cx.notify();
                    });
                }),
            )
    }
}
