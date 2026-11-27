//! User actions: navigation, filters, selection, the command palette and store utilities.

use super::*;

pub(super) fn reveal_path_in_file_manager(path: &std::path::Path) {
    #[cfg(target_os = "windows")]
    {
        if std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .is_ok()
        {
            return;
        }
    }
    #[cfg(target_os = "macos")]
    {
        if std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .is_ok()
        {
            return;
        }
    }
    if let Some(parent) = path.parent() {
        let _ = open::that(parent);
    }
}

impl MemOSApp {
    pub(super) fn apply_filter_update(&mut self, cx: &mut Context<Self>) {
        self.pending_live_reload = None;
        self.list_cursor = None;
        self.loading_next_page = false;
        self.page_generation.advance();
        self._next_page_task = None;
        self.list_view.update(cx, |l, cx| {
            l.set_pending_new_count(None, cx);
            l.scroll_to_top(cx);
        });
        self.sync_filter_to_views(cx);
        self.schedule_filtered_query(0, cx);
    }

    pub(super) fn on_search_changed(&mut self, query: String, cx: &mut Context<Self>) {
        self.pending_live_reload = None;
        self.list_view
            .update(cx, |l, cx| l.set_pending_new_count(None, cx));
        let parsed = extract_search_scopes(&query, &mut self.filter, now_unix_ms(), false);
        let effective_query = if parsed.applied_any {
            self.search_input
                .update(cx, |i, cx| i.set_text(parsed.remaining_input.clone(), cx));
            parsed.remaining_input
        } else {
            query
        };
        self.filter.query = effective_query.clone();
        telemetry::set_active_query(&effective_query);
        self.sync_filter_to_views(cx);
        self.schedule_filtered_query(if parsed.applied_any { 0 } else { 120 }, cx);
    }

    pub(super) fn on_search_submit(&mut self, query: String, cx: &mut Context<Self>) {
        let parsed = extract_search_scopes(&query, &mut self.filter, now_unix_ms(), true);
        let effective_query = if parsed.applied_any {
            self.search_input
                .update(cx, |i, cx| i.set_text(parsed.remaining_input.clone(), cx));
            parsed.remaining_input
        } else {
            query
        };
        self.filter.query = effective_query.clone();
        telemetry::set_active_query(&effective_query);
        self.record_recent_search();
        self.apply_filter_update(cx);
    }

    pub(super) fn remove_search_scope_chip(
        &mut self,
        kind: crate::core::model::SearchScopeKind,
        cx: &mut Context<Self>,
    ) {
        if remove_search_scope(&mut self.filter, kind) {
            self.mark_custom_filter_changed(cx);
        }
    }

    pub(super) fn remove_last_search_scope(&mut self, cx: &mut Context<Self>) {
        if remove_last_search_scope(&mut self.filter).is_some() {
            self.mark_custom_filter_changed(cx);
        }
    }

    pub(super) fn close_detail(&mut self, cx: &mut Context<Self>) {
        self.detail_open = false;
        self.selected_id = None;
        self.detail_generation.advance();
        self._detail_task = None;
        self.list_view
            .update(cx, |list, cx| list.set_selected(None, false, cx));
        self.graph_view
            .update(cx, |graph, cx| graph.set_selected(None, false, cx));
        self.detail_view.update(cx, |d, cx| d.set_detail(None, cx));
        let write_mode = self.settings.write_mode;
        self.palette
            .update(cx, |p, cx| p.set_write_context(write_mode, false, cx));
        cx.notify();
    }

    pub(super) fn select_memory(&mut self, id: String, scroll_list: bool, cx: &mut Context<Self>) {
        self.selected_id = Some(id.clone());
        self.detail_open = true;
        let write_mode = self.settings.write_mode;
        self.palette
            .update(cx, |p, cx| p.set_write_context(write_mode, true, cx));
        self.list_view.update(cx, |list, cx| {
            list.set_selected(Some(id.clone()), scroll_list, cx)
        });
        self.graph_view.update(cx, |graph, cx| {
            graph.set_selected(Some(id.clone()), false, cx)
        });

        let request_gen = self.detail_generation.advance();
        let db_path = self.resolved_db.path.clone();
        let shared = self.shared_store.clone();
        self.detail_view.update(cx, |d, cx| d.set_loading(true, cx));

        self._detail_task = Some(cx.spawn(async move |this, cx| {
            let detail_res = cx
                .background_executor()
                .spawn(
                    async move { shared.with_store(&db_path, |store| store.load_node_detail(&id)) },
                )
                .await;

            let _ = this.update(cx, |app, cx| {
                if !app.detail_generation.is_current(request_gen) {
                    return;
                }
                match detail_res {
                    Ok(Some(detail)) => {
                        telemetry::register_sensitive_text(&detail.content);
                        if !detail.summary.is_empty() {
                            telemetry::register_sensitive_text(&detail.summary);
                        }
                        app.detail_view
                            .update(cx, |d, cx| d.set_detail(Some(detail), cx));
                    }
                    Ok(None) => {
                        app.detail_view.update(cx, |d, cx| d.set_detail(None, cx));
                    }
                    Err(err) => {
                        let msg = sanitize_db_error(&err, &app.resolved_db.path);
                        app.detail_view
                            .update(cx, |d, cx| d.set_error(Some(msg), cx));
                    }
                }
            });
        }));
    }

    pub(super) fn switch_view(&mut self, mode: ViewMode, cx: &mut Context<Self>) {
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.active_surface = WorkspaceSurface::Memories;
        self.sidebar.update(cx, |s, cx| {
            s.set_active_surface(SidebarSurface::Memories, cx)
        });
        self.graph_view.update(cx, |g, cx| {
            g.set_active_visible(mode == ViewMode::Graph, cx)
        });
        if self.view_mode == mode {
            cx.notify();
            return;
        }
        self.view_mode = mode;
        self.settings.last_view_mode = Some(mode);
        if !self.smoke_exit_after_first_frame {
            self.settings.save_async();
        }
        if mode == ViewMode::Graph {
            self.detail_open = false;
            // Keep the memory the user was reading in focus instead of
            // dumping the whole store at Fit.
            if let Some(id) = self.selected_id.clone() {
                self.graph_view
                    .update(cx, |g, cx| g.set_selected(Some(id), true, cx));
            }
            self.spawn_graph_load(cx);
        }
        cx.notify();
    }

    pub(super) fn set_sort_order(&mut self, sort: SortOrder, cx: &mut Context<Self>) {
        self.filter.sort = sort;
        self.settings.last_sort = sort;
        if let Some(id) = self.active_saved_view_id.as_deref()
            && let Some(sv) = self.settings.saved_views.iter().find(|v| v.id == id)
            && sv.filter.sort != sort
        {
            self.active_saved_view_id = None;
            self.settings.last_saved_view_id = None;
            self.sidebar
                .update(cx, |s, cx| s.set_active_saved_view_id(None, cx));
        }
        if !self.smoke_exit_after_first_frame {
            self.settings.save_async();
        }
        self.apply_filter_update(cx);
    }

    pub(super) fn mark_custom_filter_changed(&mut self, cx: &mut Context<Self>) {
        let next_id = if self.filter.is_empty() {
            Some("all".to_string())
        } else {
            None
        };
        if self.active_saved_view_id != next_id {
            self.active_saved_view_id = next_id.clone();
            self.settings.last_saved_view_id = next_id.clone();
            self.sidebar
                .update(cx, |s, cx| s.set_active_saved_view_id(next_id, cx));
        }
        self.apply_filter_update(cx);
    }

    pub(super) fn reveal_in_graph(&mut self, id: String, cx: &mut Context<Self>) {
        self.selected_id = Some(id.clone());
        self.detail_open = true;
        self.active_surface = WorkspaceSurface::Memories;
        self.sidebar.update(cx, |s, cx| {
            s.set_active_surface(SidebarSurface::Memories, cx)
        });
        let need_load = self.view_mode != ViewMode::Graph;
        self.view_mode = ViewMode::Graph;
        self.settings.last_view_mode = Some(ViewMode::Graph);
        if !self.smoke_exit_after_first_frame {
            self.settings.save_async();
        }
        self.graph_view.update(cx, |g, cx| {
            g.set_active_visible(true, cx);
            g.set_selected(Some(id), true, cx);
        });
        if need_load {
            self.spawn_graph_load(cx);
        }
        cx.notify();
    }

    pub(super) fn on_sidebar_event(
        &mut self,
        event: SidebarEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            SidebarEvent::SelectSavedView {
                id,
                built_in,
                filter,
            } => {
                let mut filter = *filter;
                if built_in {
                    filter.query = self.filter.query.clone();
                } else {
                    self.search_input
                        .update(cx, |i, cx| i.set_text(filter.query.clone(), cx));
                    telemetry::set_active_query(&filter.query);
                }
                self.active_surface = WorkspaceSurface::Memories;
                self.filter = filter;
                self.active_saved_view_id = Some(id.clone());
                self.settings.last_saved_view_id = Some(id.clone());
                self.settings.last_sort = self.filter.sort;
                if !self.smoke_exit_after_first_frame {
                    self.settings.save_async();
                }
                self.sidebar.update(cx, |s, cx| {
                    s.set_active_surface(SidebarSurface::Memories, cx);
                    s.set_active_saved_view_id(Some(id), cx);
                });
            }
            SidebarEvent::SelectToday => {
                self.open_today_view(cx);
                return;
            }
            SidebarEvent::SelectReview => {
                self.open_review_view(cx);
                return;
            }
            SidebarEvent::ToggleTag(tag) => {
                self.active_surface = WorkspaceSurface::Memories;
                self.sidebar.update(cx, |s, cx| {
                    s.set_active_surface(SidebarSurface::Memories, cx)
                });
                toggle_opt_string(&mut self.filter.tag, tag);
                self.mark_custom_filter_changed(cx);
                return;
            }
            SidebarEvent::ClearFilters => {
                self.active_surface = WorkspaceSurface::Memories;
                self.sidebar.update(cx, |s, cx| {
                    s.set_active_surface(SidebarSurface::Memories, cx)
                });
                self.clear_filters(cx);
                return;
            }
            SidebarEvent::OpenHarnesses => {
                self.open_harnesses_modal(window, cx);
                return;
            }
            SidebarEvent::OpenPins => {
                self.open_context_pack(Some(PackSource::Pinned), window, cx);
                return;
            }
            SidebarEvent::ManageView(id) => {
                self.open_manage_view(id, window, cx);
                return;
            }
            SidebarEvent::OpenHealth => {
                self.open_health_modal(HealthPanelFilter::All, window, cx);
                return;
            }
        }
        self.apply_filter_update(cx);
    }

    pub(super) fn clear_filters(&mut self, cx: &mut Context<Self>) {
        let sort = self.filter.sort;
        self.filter = QueryFilter {
            sort,
            ..Default::default()
        };
        self.active_saved_view_id = Some("all".to_string());
        self.settings.last_saved_view_id = Some("all".to_string());
        if !self.smoke_exit_after_first_frame {
            self.settings.save_async();
        }
        self.sidebar.update(cx, |s, cx| {
            s.set_active_saved_view_id(Some("all".to_string()), cx)
        });
        telemetry::set_active_query("");
        self.search_input.update(cx, |i, cx| i.set_text("", cx));
        self.apply_filter_update(cx);
    }

    pub(super) fn open_today_view(&mut self, cx: &mut Context<Self>) {
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.active_surface = WorkspaceSurface::Today;
        self.sidebar
            .update(cx, |s, cx| s.set_active_surface(SidebarSurface::Today, cx));
        self.graph_view
            .update(cx, |g, cx| g.set_active_visible(false, cx));
        self.spawn_brief_and_review_badges(cx);
        cx.notify();
    }

    pub(super) fn open_brief_section_in_list(
        &mut self,
        section: BriefSectionKind,
        cx: &mut Context<Self>,
    ) {
        let now_ms = now_unix_ms();
        let next_filter = section.to_filter(now_ms);
        self.active_surface = WorkspaceSurface::Memories;
        self.view_mode = ViewMode::List;
        self.filter = next_filter;
        self.active_saved_view_id = if section == BriefSectionKind::Contradictions {
            Some("contradictions".to_string())
        } else {
            None
        };
        self.settings.last_view_mode = Some(ViewMode::List);
        self.sidebar.update(cx, |s, cx| {
            s.set_active_surface(SidebarSurface::Memories, cx);
            s.set_active_saved_view_id(self.active_saved_view_id.clone(), cx);
        });
        self.list_view.update(cx, |l, cx| {
            l.set_active_view_name(Some(section.view_name().to_string()), cx);
        });
        self.search_input.update(cx, |i, cx| i.set_text("", cx));
        self.apply_filter_update(cx);
        cx.notify();
    }

    pub(super) fn open_review_view(&mut self, cx: &mut Context<Self>) {
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.active_surface = WorkspaceSurface::Review;
        self.sidebar
            .update(cx, |s, cx| s.set_active_surface(SidebarSurface::Review, cx));
        self.graph_view
            .update(cx, |g, cx| g.set_active_visible(false, cx));
        self.refresh_review_view(cx);
        cx.notify();
    }

    pub(super) fn open_logs_folder(&mut self, cx: &mut Context<Self>) {
        let dir = telemetry::log_dir();
        cx.background_executor()
            .spawn(async move {
                let _ = std::fs::create_dir_all(&dir);
                let _ = open::that(dir);
            })
            .detach();
        self.set_notice("Opened logs directory", cx);
    }

    pub(super) fn reveal_database_file(&mut self, cx: &mut Context<Self>) {
        let db_path = self.resolved_db.path.clone();
        cx.background_executor()
            .spawn(async move {
                reveal_path_in_file_manager(&db_path);
            })
            .detach();
        self.set_notice("Revealed database in file manager", cx);
    }

    pub(super) fn copy_database_path(&mut self, cx: &mut Context<Self>) {
        let path_str = self.resolved_db.path.display().to_string();
        cx.write_to_clipboard(ClipboardItem::new_string(path_str));
        self.set_notice("Database path copied", cx);
    }

    pub(super) fn copy_diagnostics(&mut self, cx: &mut Context<Self>) {
        let resolved_db = self.resolved_db.clone();
        let overview = self.overview.clone();
        let settings = self.settings.clone();
        let log_directory = telemetry::log_dir();
        let harnesses = self.harnesses.clone();

        self._diag_task = Some(cx.spawn(async move |this, cx| {
            let text = cx
                .background_executor()
                .spawn(async move {
                    telemetry::build_diagnostics_text(
                        &resolved_db,
                        overview.as_ref(),
                        &settings,
                        &log_directory,
                        &harnesses,
                    )
                })
                .await;

            let _ = this.update(cx, |app, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string(text));
                app.set_notice("Diagnostics copied to clipboard (no memory text)", cx);
            });
        }));
    }

    pub(super) fn open_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.palette_return_focus = window.focused(cx);
        let items = self.list_view.read(cx).items().to_vec();
        let saved_views = self.settings.saved_views.clone();
        let write_mode = self.settings.write_mode;
        let has_selection = self.selected_id.is_some();
        let current = self.resolved_db.path.clone();
        let stores: Vec<PathBuf> = self
            .settings
            .recent_stores
            .iter()
            .filter(|p| **p != current)
            .cloned()
            .collect();
        self.palette.update(cx, |p, cx| {
            p.set_write_context(write_mode, has_selection, cx);
            p.set_recent_stores(stores);
            p.open(&items, &saved_views, window, cx);
        });
    }

    pub(super) fn execute_palette_action(
        &mut self,
        action: PaletteAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match action {
            PaletteAction::JumpToMemory(id) => {
                self.select_memory(id, true, cx);
            }
            PaletteAction::SwitchView(mode) => self.switch_view(mode, cx),
            PaletteAction::OpenToday => self.open_today_view(cx),
            PaletteAction::OpenReview => self.open_review_view(cx),
            PaletteAction::SwitchGraphMode(gm) => {
                self.graph_mode = gm;
                self.view_mode = ViewMode::Graph;
                self.settings.last_view_mode = Some(ViewMode::Graph);
                if !self.smoke_exit_after_first_frame {
                    self.settings.save_async();
                }
                self.graph_view
                    .update(cx, |g, cx| g.set_active_visible(true, cx));
                self.spawn_graph_load(cx);
                cx.notify();
            }
            PaletteAction::FitGraphView => {
                let was_graph = self.view_mode == ViewMode::Graph;
                if !was_graph {
                    self.switch_view(ViewMode::Graph, cx);
                }
                self.graph_view.update(cx, |g, cx| {
                    g.set_active_visible(true, cx);
                    g.fit_view(cx);
                });
            }
            PaletteAction::SetSort(sort) => {
                self.set_sort_order(sort, cx);
            }
            PaletteAction::NewMemory => {
                self.open_new_memory_composer(window, cx);
                return;
            }
            PaletteAction::EditSelectedMemory => {
                self.open_edit_memory_composer(window, cx);
                return;
            }
            PaletteAction::ForgetSelectedMemory => self.open_forget_confirm(cx),
            PaletteAction::ToggleTheme => self.toggle_theme(window, cx),
            PaletteAction::ToggleRowDensity => {
                let next = match self.settings.row_density {
                    RowDensity::Comfortable => RowDensity::Compact,
                    RowDensity::Compact => RowDensity::Comfortable,
                };
                self.set_row_density(next, cx);
            }
            PaletteAction::OpenHealth => self.open_health_modal(HealthPanelFilter::All, window, cx),
            PaletteAction::OpenDreamDiff => self.open_dream_diff_modal(window, cx),
            PaletteAction::PreviewContext => {
                self.open_context_pack(Some(PackSource::CurrentView), window, cx)
            }
            PaletteAction::OpenContextPack => self.open_context_pack(None, window, cx),
            PaletteAction::TogglePinSelected => self.toggle_pin_selected(cx),
            PaletteAction::CompareSelected => {
                self.compare_selected(window, cx);
                return;
            }
            PaletteAction::QuickCapture => {
                self.open_quick_capture(window, cx);
                return;
            }
            PaletteAction::ExplainWriteMode => {
                self.explain_write_mode(window, cx);
                return;
            }
            PaletteAction::ToggleInspector => self.toggle_inspector(cx),
            PaletteAction::ToggleGraphFocus => {
                if self.view_mode != ViewMode::Graph
                    || self.active_surface != WorkspaceSurface::Memories
                {
                    self.switch_view(ViewMode::Graph, cx);
                }
                self.graph_view.update(cx, |g, cx| g.toggle_focus_mode(cx));
            }
            PaletteAction::OpenSearchSyntax => {
                self.toggle_search_help(window, cx);
                return;
            }
            PaletteAction::ExportMemories => {
                self.open_export(window, cx);
                return;
            }
            PaletteAction::ShowPinned => {
                self.open_context_pack(Some(PackSource::Pinned), window, cx);
                return;
            }
            PaletteAction::ClearPins => self.clear_pins(cx),
            PaletteAction::SwitchStore => {
                self.open_store_switcher(window, cx);
                return;
            }
            PaletteAction::OpenRecentStore(path) => {
                self.try_switch_store(path, cx);
            }
            PaletteAction::ToggleReadingSize => self.toggle_reading_size(cx),
            PaletteAction::ManageSavedView(id) => {
                self.open_manage_view(id, window, cx);
                return;
            }
            PaletteAction::SaveCurrentView => {
                self.open_save_view_modal(window, cx);
                return;
            }
            PaletteAction::DeleteSavedView(id) => self.delete_saved_view(&id, cx),
            PaletteAction::OpenShortcuts => self.open_shortcuts_modal(window, cx),
            PaletteAction::CopyActiveMarkdown => self.copy_active_memory_markdown(cx),
            PaletteAction::OpenHarnesses => self.open_harnesses_modal(window, cx),
            PaletteAction::OpenSettings => self.open_settings_modal(window, cx),
            PaletteAction::OptimizeStore => self.optimize_store(cx),
            PaletteAction::OpenLogs => self.open_logs_folder(cx),
            PaletteAction::CopyDiagnostics => self.copy_diagnostics(cx),
            PaletteAction::ClearFilters => self.clear_filters(cx),
        }
        window.focus(&self.focus_handle, cx);
    }

    pub(super) fn copy_active_memory_markdown(&mut self, cx: &mut Context<Self>) {
        let md = if let Some(detail) = self.detail_view.read(cx).detail() {
            let mut lines = Vec::new();
            let trimmed_summary = detail.summary.trim();
            let heading = if trimmed_summary.is_empty() {
                detail.short_id.as_ref()
            } else {
                trimmed_summary
            };
            lines.push(format!("## [mem:{}] {}", detail.short_id, heading));
            lines.push(String::new());
            lines.push(format!(
                "- Type: `{}` · Namespace: `{}` · Trust: `{:.2}` · Importance: `{:.2}`",
                detail.node_type, detail.namespace, detail.trust_score, detail.importance
            ));
            if !detail.tags.is_empty() {
                let tags = detail
                    .tags
                    .iter()
                    .map(|t| format!("#{t}"))
                    .collect::<Vec<_>>()
                    .join(" ");
                lines.push(format!("- Tags: {tags}"));
            }
            let body = if !detail.content.trim().is_empty() {
                detail.content.trim()
            } else {
                trimmed_summary
            };
            if !body.is_empty() {
                lines.push(String::new());
                lines.push(body.to_string());
            }
            Some(lines.join("\n"))
        } else if let Some(sel_id) = self.selected_id.as_deref() {
            self.list_view
                .read(cx)
                .items()
                .iter()
                .find(|item| item.id == sel_id)
                .map(|item| {
                    format!(
                        "## [mem:{}] {}\n\n- Type: `{}` · Namespace: `{}`\n",
                        item.short_id, item.preview, item.node_type, item.namespace
                    )
                })
        } else {
            None
        };

        if let Some(markdown) = md {
            cx.write_to_clipboard(ClipboardItem::new_string(markdown));
            self.status_notice = Some("Copied active memory as Markdown.".to_string());
        } else {
            self.status_notice = Some("Select a memory first to copy as Markdown.".to_string());
        }
        cx.notify();
    }

    pub(super) fn apply_health_fix_filter(&mut self, filter: QueryFilter, cx: &mut Context<Self>) {
        self.show_health_modal = false;
        self.filter = filter;
        self.view_mode = ViewMode::List;
        self.settings.last_view_mode = Some(ViewMode::List);
        self.graph_view.update(cx, |g, cx| {
            g.set_active_visible(false, cx);
        });
        self.mark_custom_filter_changed(cx);
    }
}
