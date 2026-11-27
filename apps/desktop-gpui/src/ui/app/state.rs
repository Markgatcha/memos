//! Construction and app-wide state: settings, theme, notices, popovers and the idle mascot.

use super::*;

pub(super) fn toggle_opt_string(slot: &mut Option<String>, val: String) {
    if slot.as_deref() == Some(val.as_str()) {
        *slot = None;
    } else {
        *slot = Some(val);
    }
}

pub(super) fn format_memory_count(n: usize) -> String {
    if n == 1 {
        "1 memory".to_string()
    } else {
        format!("{n} memories")
    }
}

impl MemOSApp {
    pub(crate) fn new(
        resolved_db: ResolvedDbPath,
        settings: AppSettings,
        telemetry: Arc<TelemetryHandle>,
        timeline: Arc<StartupTimeline>,
        options: LaunchOptions,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        init_icon_font_from_window(window);
        let theme = ThemePalette::resolve(settings.theme, window.appearance());
        sync_win32_titlebar(window, theme);
        let effective_no_fun = prefers_reduced_motion(options.no_fun);
        // Teach GPUI's animation layer the same policy as the logo/Momo easter
        // eggs so with_animation() renders static frames under reduced motion.
        cx.set_reduce_motion(effective_no_fun);
        let focus_handle = cx.focus_handle();
        let initial_view_mode = settings.last_view_mode.unwrap_or(settings.default_view);
        let mut initial_filter = QueryFilter::default();
        let mut initial_saved_view_id: Option<String> = None;
        if let Some(saved_id) = settings.last_saved_view_id.as_deref()
            && let Some(sv) = settings.saved_views.iter().find(|v| v.id == saved_id)
        {
            initial_filter = sv.resolved_filter(now_unix_ms());
            initial_saved_view_id = Some(sv.id.clone());
        }
        if settings.last_sort != SortOrder::Recency || initial_saved_view_id.is_none() {
            initial_filter.sort = settings.last_sort;
        }
        let search_input = cx.new(|cx| {
            let mut input =
                TextInput::new(cx, "Search memories", theme).with_leading_icon(UiIcon::Search);
            if !initial_filter.query.trim().is_empty() {
                input.set_text(initial_filter.query.clone(), cx);
            }
            input
        });
        let save_view_input = cx.new(|cx| TextInput::new(cx, "View name", theme));
        let writer_cmd_input = cx.new(|cx| {
            let mut input = TextInput::new(cx, DEFAULT_WRITER_COMMAND, theme);
            input.set_text(settings.effective_writer_command().to_string(), cx);
            input
        });
        let composer_content_input =
            cx.new(|cx| TextInput::new_multiline(cx, "Write durable memory content…", theme));
        let composer_tags_input = cx
            .new(|cx| TextInput::new(cx, "Comma-separated tags (e.g. auth, architecture)", theme));
        let composer_namespace_input = cx.new(|cx| {
            let mut input = TextInput::new(cx, "default", theme);
            input.set_text("default", cx);
            input
        });
        let composer_context_input =
            cx.new(|cx| TextInput::new(cx, "Optional situational context for retrieval", theme));
        let ingest_path_input =
            cx.new(|cx| TextInput::new(cx, "File or folder path to ingest…", theme));
        let ingest_namespace_input = cx.new(|cx| {
            let mut input = TextInput::new(cx, "default or documents", theme);
            input.set_text("documents", cx);
            input
        });
        let ingest_extensions_input = cx.new(|cx| {
            let mut input = TextInput::new(cx, "md,txt,html,pdf", theme);
            input.set_text("md,txt,html,pdf", cx);
            input
        });
        let ingest_chunk_input = cx.new(|cx| {
            let mut input = TextInput::new(cx, "1200 (optional)", theme);
            input.set_text("1200", cx);
            input
        });
        let write_bridge = Arc::new(WriteBridge::new(
            settings.effective_writer_command(),
            resolved_db.path.clone(),
        ));
        let sidebar = cx.new(|cx| {
            let mut v = SidebarView::new(settings.saved_views.clone(), theme);
            v.set_no_fun(effective_no_fun, cx);
            v.set_filter(initial_filter.clone(), cx);
            v.set_active_saved_view_id(initial_saved_view_id.clone(), cx);
            v
        });
        let initial_view_title = initial_saved_view_id
            .as_deref()
            .and_then(|id| settings.saved_views.iter().find(|v| v.id == id))
            .map(|sv| sv.name.clone())
            .or_else(|| Some("All memories".to_string()));
        let list_view = cx.new(|cx| {
            let mut v = MemoryListView::new(theme);
            v.set_no_fun(effective_no_fun, cx);
            v.set_row_density(settings.row_density, cx);
            v.set_active_view_name(initial_view_title, cx);
            v.set_filter(initial_filter.clone(), cx);
            v
        });
        let brief_view = cx.new(|_| BriefView::new(theme));
        let review_view = cx.new(|_| ReviewView::new(theme, settings.write_mode));
        let detail_view = cx.new(|cx| {
            let mut v = DetailView::new(theme);
            v.set_write_mode(settings.write_mode, cx);
            v.set_large_text(settings.large_reading_text, cx);
            v
        });
        let graph_view = cx.new(|cx| {
            let mut v = GraphView::new(GraphMode::Namespace, theme);
            v.set_no_fun(effective_no_fun, cx);
            v.set_active_visible(initial_view_mode == ViewMode::Graph, cx);
            v
        });
        let palette = cx.new(|cx| {
            let mut p = CommandPalette::new(theme, window, cx);
            p.set_write_context(settings.write_mode, false, cx);
            p.set_recent_commands(&settings.recent_commands);
            p
        });

        let show_onboarding =
            !options.smoke_exit_after_first_frame && !settings.onboarding_completed;
        let mut subs = Vec::new();
        let (capture, capture_sub) = capture_ui::CaptureState::new(theme, window, cx);
        subs.push(capture_sub);
        let (search_ui, search_ui_sub) = search_ui::SearchUiState::new(theme, window, cx);
        subs.push(search_ui_sub);
        subs.push(dialogs_ui::IngestUiState::subscribe(
            &ingest_path_input,
            window,
            cx,
        ));

        let onboarding = if show_onboarding {
            let ob = cx.new(|cx| {
                OnboardingView::new(resolved_db.path.clone(), settings.clone(), theme, cx)
            });
            subs.push(
                cx.subscribe_in(&ob, window, |this, _, event, window, cx| match event {
                    OnboardingEvent::Complete {
                        settings,
                        selected_db,
                    } => {
                        this.complete_onboarding(
                            (**settings).clone(),
                            selected_db.clone(),
                            window,
                            cx,
                        );
                    }
                    OnboardingEvent::ThemeChanged(mode) => {
                        this.settings.theme = *mode;
                        let resolved = ThemePalette::resolve(*mode, window.appearance());
                        this.apply_theme_palette(resolved, window, cx);
                    }
                }),
            );
            Some(ob)
        } else {
            None
        };
        subs.push(cx.subscribe_in(
            &search_input,
            window,
            |this, _, event, _window, cx| match event {
                InputEvent::Changed(query) => {
                    this.on_search_changed(query.clone(), cx);
                }
                InputEvent::Submit(query) => {
                    this.on_search_submit(query.clone(), cx);
                }
                InputEvent::Cancel => {
                    this.search_input.update(cx, |input, cx| input.clear(cx));
                }
                InputEvent::BackspaceWhenEmpty => {
                    this.remove_last_search_scope(cx);
                }
                InputEvent::MoveUp | InputEvent::MoveDown => {}
            },
        ));

        subs.push(
            cx.subscribe_in(&sidebar, window, |this, _, event, window, cx| {
                this.on_sidebar_event(event.clone(), window, cx);
            }),
        );

        subs.push(cx.subscribe_in(
            &brief_view,
            window,
            |this, _, event, window, cx| match event {
                BriefEvent::OpenMemory(id) => this.select_memory(id.clone(), false, cx),
                BriefEvent::ViewAll(section) => this.open_brief_section_in_list(*section, cx),
                BriefEvent::Compare(a, b) => {
                    this.open_compare(a.clone(), Some(b.clone()), window, cx)
                }
                BriefEvent::ViewAllMemories => {
                    this.active_surface = WorkspaceSurface::Memories;
                    this.sidebar.update(cx, |s, cx| {
                        s.set_active_surface(SidebarSurface::Memories, cx)
                    });
                    this.switch_view(ViewMode::List, cx);
                    this.clear_filters(cx);
                }
            },
        ));

        subs.push(cx.subscribe_in(
            &review_view,
            window,
            |this, _, event, window, cx| match event {
                ReviewEvent::Refresh => this.refresh_review_view(cx),
                ReviewEvent::OpenMemory(id) => this.select_memory(id.clone(), false, cx),
                ReviewEvent::Approve(id) => this.execute_review_decision(id.clone(), true, cx),
                ReviewEvent::Reject(id) => this.execute_review_decision(id.clone(), false, cx),
                ReviewEvent::OpenSettings => this.open_settings_modal(window, cx),
                ReviewEvent::Batch { ids, approve } => {
                    this.start_review_batch(ids.clone(), *approve, cx)
                }
                ReviewEvent::StopBatch => this.stop_review_batch(cx),
                ReviewEvent::Compare(id) => this.open_compare(id.clone(), None, window, cx),
            },
        ));

        for single_ingest in [
            &ingest_path_input,
            &ingest_namespace_input,
            &ingest_extensions_input,
            &ingest_chunk_input,
        ] {
            subs.push(
                cx.subscribe_in(
                    single_ingest,
                    window,
                    |this, _, event, window, cx| match event {
                        InputEvent::Submit(_) => this.submit_ingest(window, cx),
                        InputEvent::Cancel => {
                            this.show_ingest_modal = false;
                            window.focus(&this.focus_handle, cx);
                            cx.notify();
                        }
                        InputEvent::Changed(_) => {
                            if this.ingest_error.is_some() {
                                this.ingest_error = None;
                                cx.notify();
                            }
                        }
                        InputEvent::MoveUp
                        | InputEvent::MoveDown
                        | InputEvent::BackspaceWhenEmpty => {}
                    },
                ),
            );
        }

        subs.push(cx.subscribe_in(
            &list_view,
            window,
            |this, _, event, window, cx| match event {
                ListEvent::Select(id) => {
                    this.record_recent_search();
                    this.select_memory(id.clone(), false, cx)
                }
                ListEvent::Highlight(id) => {
                    this.selected_id = Some(id.clone());
                    this.graph_view
                        .update(cx, |g, cx| g.set_selected(Some(id.clone()), false, cx));
                    this.palette.update(cx, |p, cx| {
                        p.set_write_context(this.settings.write_mode, true, cx)
                    });
                    if this.detail_open {
                        this.select_memory(id.clone(), false, cx);
                    } else {
                        cx.notify();
                    }
                }
                ListEvent::Hover(hovered_id) => {
                    this.sync_linked_hover(HoverOrigin::List, hovered_id.clone(), cx);
                }
                ListEvent::PopoverOpened => this.dismiss_popovers(PopoverOwner::List, cx),
                ListEvent::ApplyLiveUpdates { jump_to_newest } => {
                    if let Some(pending) = this.pending_live_reload.take() {
                        this.list_view
                            .update(cx, |l, cx| l.set_pending_new_count(None, cx));
                        this.apply_loaded_snapshot(
                            pending.result,
                            pending.stamp,
                            if *jump_to_newest {
                                pending.newest_id
                            } else {
                                None
                            },
                            cx,
                        );
                    } else {
                        this.list_view
                            .update(cx, |l, cx| l.set_pending_new_count(None, cx));
                        this.schedule_filtered_query(0, cx);
                    }
                }
                ListEvent::ToggleNamespace(ns) => {
                    toggle_opt_string(&mut this.filter.namespace, ns.clone());
                    this.mark_custom_filter_changed(cx);
                }
                ListEvent::ToggleType(ty) => {
                    toggle_opt_string(&mut this.filter.node_type, ty.clone());
                    this.mark_custom_filter_changed(cx);
                }
                ListEvent::ToggleProvenance(prov) => {
                    toggle_opt_string(&mut this.filter.provenance, prov.clone());
                    this.mark_custom_filter_changed(cx);
                }
                ListEvent::ToggleContradictions => {
                    this.filter.has_contradiction = !this.filter.has_contradiction;
                    this.mark_custom_filter_changed(cx);
                }
                ListEvent::SetSort(sort) => {
                    this.set_sort_order(*sort, cx);
                }
                ListEvent::ClearFilters => this.clear_filters(cx),
                ListEvent::RetryLoad => this.spawn_initial_load(cx),
                ListEvent::LoadNextPage => this.spawn_next_page_load(cx),
                ListEvent::CreateStore(path) => this.create_memory_store(path.clone(), cx),
                ListEvent::CopyInitCommand => {
                    cx.write_to_clipboard(ClipboardItem::new_string(CLI_INIT_COMMAND.to_string()));
                    this.set_notice("Copied init command", cx);
                }
                ListEvent::CopyStoreCommand => {
                    cx.write_to_clipboard(ClipboardItem::new_string(CLI_STORE_COMMAND.to_string()));
                    this.set_notice("Copied add command", cx);
                }
                ListEvent::OpenTools => this.open_harnesses_modal(window, cx),
                ListEvent::OpenHealth => this.open_health_modal_from_momo(window, cx),
            },
        ));

        subs.push(cx.subscribe_in(
            &detail_view,
            window,
            |this, _, event, window, cx| match event {
                DetailEvent::SelectMemory(id) => this.select_memory(id.clone(), true, cx),
                DetailEvent::RevealInGraph(id) => this.reveal_in_graph(id.clone(), cx),
                DetailEvent::PreviewContext => {
                    this.open_context_pack(Some(PackSource::Selected), window, cx)
                }
                DetailEvent::TogglePin => this.toggle_pin_selected(cx),
                DetailEvent::CopyMarkdown => this.copy_active_memory_markdown(cx),
                DetailEvent::Export => {
                    this.pack.budget = crate::core::context_pack::PackBudget::Unlimited;
                    this.open_context_pack(Some(PackSource::Selected), window, cx);
                }
                DetailEvent::Compare(peer) => {
                    if let Some(sel) = this.selected_id.clone() {
                        this.open_compare(sel, Some(peer.clone()), window, cx);
                    }
                }
                DetailEvent::EditSelected => this.open_edit_memory_composer(window, cx),
                DetailEvent::ForgetSelected => this.open_forget_confirm(cx),
                DetailEvent::Close => this.close_detail(cx),
            },
        ));

        subs.push(
            cx.subscribe_in(
                &writer_cmd_input,
                window,
                |this, _, event, window, cx| match event {
                    InputEvent::Changed(cmd) => {
                        this.settings.writer_command = cmd.clone();
                        this.write_bridge.configure(
                            &this.settings.effective_writer_command(),
                            &this.resolved_db.path,
                        );
                        this.writer_test_status = None;
                        this.bounds_dirty = true;
                        cx.notify();
                    }
                    InputEvent::Submit(_) => {
                        this.settings.save_async();
                        this.bounds_dirty = false;
                        this.run_writer_ping(cx);
                    }
                    InputEvent::Cancel => {
                        window.focus(&this.focus_handle, cx);
                    }
                    InputEvent::MoveUp | InputEvent::MoveDown | InputEvent::BackspaceWhenEmpty => {}
                },
            ),
        );

        for single_input in [
            &composer_tags_input,
            &composer_namespace_input,
            &composer_context_input,
        ] {
            subs.push(cx.subscribe_in(
                single_input,
                window,
                |this, _, event, window, cx| match event {
                    InputEvent::Submit(_) => {
                        this.submit_composer(window, cx);
                    }
                    InputEvent::Cancel => {
                        this.show_composer_modal = false;
                        window.focus(&this.focus_handle, cx);
                        cx.notify();
                    }
                    InputEvent::Changed(_)
                    | InputEvent::MoveUp
                    | InputEvent::MoveDown
                    | InputEvent::BackspaceWhenEmpty => {}
                },
            ));
        }

        subs.push(cx.subscribe_in(
            &composer_content_input,
            window,
            |this, _, event, window, cx| match event {
                InputEvent::Changed(_) => {
                    if this.composer_validation_error.is_some() {
                        this.composer_validation_error = None;
                        cx.notify();
                    }
                }
                InputEvent::Cancel => {
                    this.show_composer_modal = false;
                    window.focus(&this.focus_handle, cx);
                    cx.notify();
                }
                // Ctrl/Cmd+Enter in the content field saves.
                InputEvent::Submit(_) => this.submit_composer(window, cx),
                InputEvent::MoveUp | InputEvent::MoveDown | InputEvent::BackspaceWhenEmpty => {}
            },
        ));

        subs.push(cx.subscribe_in(
            &save_view_input,
            window,
            |this, _, event, window, cx| match event {
                InputEvent::Submit(_) => {
                    this.confirm_save_view(window, cx);
                }
                InputEvent::Cancel => {
                    this.show_save_view_modal = false;
                    window.focus(&this.focus_handle, cx);
                    cx.notify();
                }
                InputEvent::Changed(_)
                | InputEvent::MoveUp
                | InputEvent::MoveDown
                | InputEvent::BackspaceWhenEmpty => {}
            },
        ));

        subs.push(cx.observe_window_bounds(window, |this, window, cx| {
            this.list_view
                .update(cx, |list, cx| list.clear_hover_on_resize(cx));
            if this.smoke_exit_after_first_frame {
                return;
            }
            let next = window_bounds_to_setting(window.window_bounds());
            // Ignore transient/minimized frames: saving a zero or negative
            // size here used to reopen the app with corrupt bounds.
            if !next.width.is_finite()
                || !next.height.is_finite()
                || next.width < 320.0
                || next.height < 240.0
            {
                return;
            }
            if this.settings.window_bounds != Some(next) {
                this.settings.window_bounds = Some(next);
                this.bounds_dirty = true;
                this._bounds_save_task = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor()
                        .timer(Duration::from_millis(200))
                        .await;
                    let _ = this.update(cx, |app, _cx| {
                        if app.bounds_dirty {
                            app.bounds_dirty = false;
                            app.settings.save_async();
                        }
                    });
                }));
            }
        }));

        subs.push(cx.subscribe_in(
            &graph_view,
            window,
            |this, _, event, _window, cx| match event {
                GraphEvent::SwitchMode(mode) => {
                    this.graph_mode = *mode;
                    this.spawn_graph_load(cx);
                }
                GraphEvent::SelectMemory(id) => {
                    this.select_memory(id.clone(), true, cx);
                }
                GraphEvent::Inspect(id) => this.inspect_from_graph(id.clone(), cx),
                GraphEvent::Hover(hovered_id) => {
                    this.sync_linked_hover(HoverOrigin::Graph, hovered_id.clone(), cx);
                }
                GraphEvent::PopoverOpened => this.dismiss_popovers(PopoverOwner::Graph, cx),
            },
        ));

        subs.push(
            cx.subscribe_in(&palette, window, |this, _, event, window, cx| match event {
                PaletteEvent::Execute(action) => {
                    this.execute_palette_action(action.clone(), window, cx)
                }
                PaletteEvent::RecentCommandsChanged(titles) => {
                    if &this.settings.recent_commands != titles {
                        this.settings.recent_commands = titles.clone();
                        this.settings.save_async();
                    }
                }
                PaletteEvent::Closed => {
                    if let Some(handle) = this.palette_return_focus.take() {
                        window.focus(&handle, cx);
                    } else {
                        window.focus(&this.focus_handle, cx);
                    }
                }
            }),
        );

        let show_consent_modal = !show_onboarding
            && !options.smoke_exit_after_first_frame
            && settings.crash_reporting_consent.is_none();
        let celebrate_100 = Celebrate100Tracker::new(settings.celebrated_100);
        let initial_stamp = db_file_stamp(&resolved_db.path);

        let mut app = Self {
            focus_handle: focus_handle.clone(),
            palette_return_focus: None,
            timeline,
            smoke_exit_after_first_frame: options.smoke_exit_after_first_frame,
            no_fun: effective_no_fun,
            first_frame_logged: false,
            first_frame_done: false,
            initial_load_done: show_onboarding,
            store_create_in_flight: false,
            store_optimize_in_flight: false,
            window_active: true,
            shared_store: SharedStore::new(),
            resolved_db,
            settings,
            telemetry,
            theme,
            overview: None,
            health_report: None,
            health_status: StoreHealthStatus::Empty,
            active_surface: WorkspaceSurface::Memories,
            view_mode: initial_view_mode,
            graph_mode: GraphMode::Namespace,
            filter: initial_filter,
            active_saved_view_id: initial_saved_view_id,
            today_count: 0,
            pending_review_count: 0,
            selected_id: None,
            detail_open: false,
            hovered_id: None,
            write_bridge,
            writer_preflight: WriterSchemaPreflight::default(),
            writer_testing: false,
            writer_test_status: None,
            write_in_flight: false,
            write_bridge_error: None,
            show_composer_modal: false,
            composer_editing_id: None,
            composer_type: "fact".to_string(),
            composer_pool: "event".to_string(),
            composer_validation_error: None,
            forget_confirm_target: None,
            show_ingest_modal: false,
            ingest_recursive: true,
            ingest_in_flight: false,
            ingest_result: None,
            ingest_error: None,
            harnesses: Vec::new(),
            selected_harness_ix: 0,
            harness_inspector: None,
            show_harnesses_modal: false,
            pending_connect_id: None,
            tools_advanced_open: false,
            show_settings_modal: false,
            settings_scroll: ScrollHandle::new(),
            show_health_modal: false,
            show_dream_diff_modal: false,
            show_shortcuts_modal: false,
            pack: pack_ui::PackState::default(),
            compare: compare_ui::CompareState::default(),
            capture,
            search_ui,
            review_batch: review_batch::ReviewBatchState::default(),
            store_switch: store_ui::StoreSwitchState::default(),
            graph_card: shortcuts::GraphCardState::default(),
            ingest_ui: dialogs_ui::IngestUiState::default(),
            show_save_view_modal: false,
            save_view_input,
            health_filter: HealthPanelFilter::All,
            dream_diff_entries: Vec::new(),
            dream_diff_loading: false,
            dream_diff_filter: None,
            show_overflow_menu: false,
            show_consent_modal,
            compact_layout: false,
            momo_hovered: false,
            last_synced_titlebar_dark: None,
            status_notice: None,
            bounds_dirty: false,
            konami: KonamiDetector::new(),
            celebrate_100,
            celebrate_100_until: None,
            momo_peek: MomoPeekController::new(Instant::now()),
            momo_peek_sample: PeekSample::default(),
            last_db_stamp: initial_stamp,
            pending_live_reload: None,
            query_generation: Default::default(),
            page_generation: Default::default(),
            detail_generation: Default::default(),
            graph_generation: Default::default(),
            list_cursor: None,
            list_total_matching: 0,
            loading_next_page: false,
            search_input,
            writer_cmd_input,
            composer_content_input,
            composer_tags_input,
            composer_namespace_input,
            composer_context_input,
            ingest_path_input,
            ingest_namespace_input,
            ingest_extensions_input,
            ingest_chunk_input,
            sidebar,
            list_view,
            brief_view,
            review_view,
            detail_view,
            graph_view,
            palette,
            onboarding,
            _init_task: None,
            _optimize_task: None,
            _search_task: None,
            _next_page_task: None,
            _brief_task: None,
            _review_task: None,
            _ingest_task: None,
            _browse_ingest_task: None,
            _detail_task: None,
            _graph_task: None,
            _harness_task: None,
            _harness_detail_task: None,
            _diag_task: None,
            _dream_diff_task: None,
            _bounds_save_task: None,
            _notice_task: None,
            _celebrate_task: None,
            _db_watch_task: None,
            _peek_watch_task: None,
            _peek_anim_task: None,
            _write_task: None,
            _writer_ping_task: None,
            _subscriptions: subs,
        };

        if !show_onboarding {
            app.spawn_initial_load(cx);
            window.focus(&focus_handle, cx);
        }
        if !options.smoke_exit_after_first_frame {
            app.start_db_watcher(cx);
            if !effective_no_fun {
                app.start_peek_watcher(cx);
            }
        }
        app
    }

    pub(super) fn maybe_finish_startup_exit(&self, cx: &mut Context<Self>) {
        if !self.smoke_exit_after_first_frame || !self.first_frame_done {
            return;
        }
        if !self.timeline.has_report_path() || self.initial_load_done {
            let _ = self.timeline.write_report_if_configured();
            cx.quit();
        }
    }

    pub(super) fn current_view_title(&self) -> String {
        if let Some(active_id) = self.active_saved_view_id.as_deref()
            && let Some(sv) = self.settings.saved_views.iter().find(|v| v.id == active_id)
        {
            return sv.name.clone();
        }
        if self.filter.is_empty() {
            "All memories".to_string()
        } else {
            describe_filter_target(&self.filter)
        }
    }

    pub(super) fn sync_active_view_name_to_list(&self, cx: &mut Context<Self>) {
        let title = self.current_view_title();
        self.list_view
            .update(cx, |l, cx| l.set_active_view_name(Some(title), cx));
    }

    pub(super) fn sync_filter_to_views(&self, cx: &mut Context<Self>) {
        let f = self.filter.clone();
        self.sidebar.update(cx, |s, cx| s.set_filter(f.clone(), cx));
        let title = self.current_view_title();
        self.list_view.update(cx, |l, cx| {
            l.set_active_view_name(Some(title), cx);
            l.set_filter(f, cx);
        });
    }

    pub(super) fn apply_theme_palette(
        &mut self,
        theme: ThemePalette,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        self.theme = theme;
        sync_win32_titlebar(window, theme);
        self.last_synced_titlebar_dark = Some(theme.is_dark);
        self.search_input.update(cx, |v, cx| v.set_theme(theme, cx));
        self.save_view_input
            .update(cx, |v, cx| v.set_theme(theme, cx));
        self.writer_cmd_input
            .update(cx, |v, cx| v.set_theme(theme, cx));
        self.composer_content_input
            .update(cx, |v, cx| v.set_theme(theme, cx));
        self.composer_tags_input
            .update(cx, |v, cx| v.set_theme(theme, cx));
        self.composer_namespace_input
            .update(cx, |v, cx| v.set_theme(theme, cx));
        self.composer_context_input
            .update(cx, |v, cx| v.set_theme(theme, cx));
        self.ingest_path_input
            .update(cx, |v, cx| v.set_theme(theme, cx));
        self.ingest_namespace_input
            .update(cx, |v, cx| v.set_theme(theme, cx));
        self.ingest_extensions_input
            .update(cx, |v, cx| v.set_theme(theme, cx));
        self.ingest_chunk_input
            .update(cx, |v, cx| v.set_theme(theme, cx));
        self.capture
            .input
            .update(cx, |v, cx| v.set_theme(theme, cx));
        self.search_ui
            .manage_input
            .update(cx, |v, cx| v.set_theme(theme, cx));
        self.sidebar.update(cx, |v, cx| v.set_theme(theme, cx));
        self.list_view.update(cx, |v, cx| v.set_theme(theme, cx));
        self.brief_view.update(cx, |v, cx| v.set_theme(theme, cx));
        self.review_view.update(cx, |v, cx| v.set_theme(theme, cx));
        self.detail_view.update(cx, |v, cx| v.set_theme(theme, cx));
        self.graph_view.update(cx, |v, cx| v.set_theme(theme, cx));
        self.palette.update(cx, |v, cx| v.set_theme(theme, cx));
        if let Some(onboarding) = &self.onboarding {
            onboarding.update(cx, |v, cx| v.set_theme(theme, cx));
        }
        cx.notify();
    }

    pub(super) fn toggle_theme(&mut self, window: &Window, cx: &mut Context<Self>) {
        self.settings.theme = self.settings.theme.toggle_from_dark(self.theme.is_dark);
        self.settings.save_async();
        let resolved = ThemePalette::resolve(self.settings.theme, window.appearance());
        self.apply_theme_palette(resolved, window, cx);
    }

    pub(super) fn complete_onboarding(
        &mut self,
        next_settings: AppSettings,
        selected_db: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.settings = next_settings;
        self.telemetry.sync_sentry_from_settings(&self.settings);
        self.show_consent_modal = false;
        if selected_db != self.resolved_db.path {
            self.resolved_db = ResolvedDbPath {
                path: selected_db,
                source: DbPathSource::SavedPreference,
            };
        }
        let writer_cmd = self.settings.effective_writer_command().to_string();
        self.write_bridge
            .configure(&writer_cmd, &self.resolved_db.path);
        self.writer_cmd_input
            .update(cx, |v, cx| v.set_text(writer_cmd, cx));
        self.sync_write_mode_to_views(cx);
        self.view_mode = self.settings.default_view;
        let resolved_theme = ThemePalette::resolve(self.settings.theme, window.appearance());
        self.onboarding = None;
        self.apply_theme_palette(resolved_theme, window, cx);
        self.spawn_initial_load(cx);
        self.spawn_harness_detection(cx);
        window.focus(&self.focus_handle, cx);
    }

    pub(super) fn set_crash_consent(&mut self, opt_in: bool, cx: &mut Context<Self>) {
        self.settings.crash_reporting_consent = Some(opt_in);
        self.show_consent_modal = false;
        self.telemetry.sync_sentry_from_settings(&self.settings);
        self.settings.save_async();
        self.set_notice(
            if opt_in {
                if telemetry::resolve_dsn().is_some() {
                    "Crash reporting enabled (scrubbed Sentry + local)"
                } else {
                    "Crash reporting opted in (local-only, no DSN configured)"
                }
            } else {
                "Crash reporting kept off (local crash logs active)"
            },
            cx,
        );
        cx.notify();
    }

    pub(super) fn dismiss_popovers(&mut self, keep: PopoverOwner, cx: &mut Context<Self>) {
        if keep != PopoverOwner::Overflow && self.show_overflow_menu {
            self.show_overflow_menu = false;
            cx.notify();
        }
        if keep != PopoverOwner::List {
            self.list_view.update(cx, |l, cx| l.close_popovers(cx));
        }
        if keep != PopoverOwner::Graph {
            self.graph_view.update(cx, |g, cx| g.close_popovers(cx));
        }
    }

    pub(super) fn has_any_popover_open(&self, cx: &App) -> bool {
        self.show_overflow_menu
            || self.list_view.read(cx).has_open_popover()
            || self.graph_view.read(cx).has_open_popover()
    }

    pub(super) fn apply_writer_preflight(
        &mut self,
        preflight: WriterSchemaPreflight,
        cx: &mut Context<Self>,
    ) {
        self.writer_preflight = preflight.clone();
        if !preflight.compatible && self.settings.write_mode {
            self.settings.write_mode = false;
            self.bounds_dirty = false;
            self.settings.save_async();
            self.sync_write_mode_to_views(cx);
            if let Some(msg) = preflight.human_message() {
                self.set_notice(msg, cx);
            }
        }
    }

    pub(super) fn apply_store_health_and_milestones(
        &mut self,
        overview: &DbOverview,
        health: Option<StoreHealthReport>,
        cx: &mut Context<Self>,
    ) {
        self.apply_writer_preflight(overview.writer_preflight.clone(), cx);
        let status = health
            .as_ref()
            .map(|h| h.status)
            .unwrap_or(if overview.node_count == 0 {
                StoreHealthStatus::Empty
            } else if overview.contradiction_count > 0 {
                StoreHealthStatus::Contradictions
            } else {
                StoreHealthStatus::Healthy
            });
        self.health_report = health.clone();
        self.health_status = status;
        self.sidebar.update(cx, |s, cx| {
            s.set_health_status(status, cx);
            s.set_health_report(health.as_ref(), cx);
        });
        self.list_view
            .update(cx, |l, cx| l.set_health_status(status, cx));

        match self
            .celebrate_100
            .observe_count(overview.node_count, self.no_fun)
        {
            Celebrate100Outcome::None => {}
            Celebrate100Outcome::PersistOnly => {
                self.settings.celebrated_100 = true;
                self.settings.save_async();
            }
            Celebrate100Outcome::AnimateAndPersist => {
                self.settings.celebrated_100 = true;
                self.settings.save_async();
                if !cx.reduce_motion() {
                    self.celebrate_100_until = Some(Instant::now() + CELEBRATE_100_DURATION);
                    self._celebrate_task = Some(cx.spawn(async move |this, cx| {
                        cx.background_executor().timer(CELEBRATE_100_DURATION).await;
                        let _ = this.update(cx, |app, cx| {
                            app.celebrate_100_until = None;
                            cx.notify();
                        });
                    }));
                }
            }
        }
    }

    pub(super) fn is_celebrating_100(&self) -> bool {
        self.celebrate_100_until
            .is_some_and(|until| Instant::now() < until)
    }

    pub(super) fn has_overlay_open(&self, cx: &App) -> bool {
        self.onboarding.is_some()
            || self.palette.read(cx).is_open()
            || self.show_harnesses_modal
            || self.show_settings_modal
            || self.show_health_modal
            || self.show_dream_diff_modal
            || self.show_shortcuts_modal
            || self.pack.open
            || self.compare.open
            || self.capture.open
            || self.store_switch.open
            || self.search_ui.manage_view_id.is_some()
            || self.show_save_view_modal
            || self.show_composer_modal
            || self.forget_confirm_target.is_some()
            || self.show_ingest_modal
            || self.show_consent_modal
    }

    pub(super) fn record_window_activity(&mut self) {
        self.momo_peek.record_activity(Instant::now());
    }

    pub(super) fn flush_dirty_settings(&mut self) {
        if self.bounds_dirty {
            self.bounds_dirty = false;
            self.settings.save_async();
        }
    }

    pub(super) fn sync_write_mode_to_views(&mut self, cx: &mut Context<Self>) {
        let enabled = self.settings.write_mode;
        let has_selection = self.selected_id.is_some();
        self.detail_view
            .update(cx, |d, cx| d.set_write_mode(enabled, cx));
        self.review_view
            .update(cx, |r, cx| r.set_write_mode(enabled, cx));
        self.palette
            .update(cx, |p, cx| p.set_write_context(enabled, has_selection, cx));
        if !enabled {
            self.show_composer_modal = false;
            self.forget_confirm_target = None;
            self.show_ingest_modal = false;
            self.write_bridge_error = None;
            self.write_bridge.shutdown();
        }
    }

    pub(super) fn sync_linked_hover(
        &mut self,
        origin: HoverOrigin,
        id: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if self.hovered_id == id {
            return;
        }
        self.hovered_id = id.clone();
        if origin != HoverOrigin::List {
            let list_id = id.clone();
            self.list_view
                .update(cx, |l, cx| l.set_external_hovered_id(list_id, cx));
        }
        if origin != HoverOrigin::Graph {
            self.graph_view
                .update(cx, |g, cx| g.set_external_hovered_id(id, cx));
        }
    }

    pub(super) fn set_row_density(&mut self, density: RowDensity, cx: &mut Context<Self>) {
        if self.settings.row_density == density {
            return;
        }
        self.settings.row_density = density;
        self.bounds_dirty = false;
        self.settings.save_async();
        self.list_view
            .update(cx, |l, cx| l.set_row_density(density, cx));
        self.set_notice(format!("Row density set to {}", density.label()), cx);
        cx.notify();
    }

    pub(super) fn start_peek_watcher(&mut self, cx: &mut Context<Self>) {
        self._peek_watch_task = Some(cx.spawn(async move |this, cx| {
            loop {
                let active = this
                    .read_with(cx, |app, _| app.window_active)
                    .unwrap_or(true);
                cx.background_executor()
                    .timer(Duration::from_secs(if active { 15 } else { 60 }))
                    .await;
                let res = this.update(cx, |app, cx| {
                    let suppressed = app.has_overlay_open(cx);
                    let reduce = cx.reduce_motion();
                    if app.momo_peek.should_start_peek(
                        Instant::now(),
                        suppressed,
                        reduce,
                        app.no_fun,
                    ) {
                        app.start_peek_animation(cx);
                    }
                });
                if res.is_err() {
                    break;
                }
            }
        }));
    }

    pub(super) fn start_peek_animation(&mut self, cx: &mut Context<Self>) {
        if self._peek_anim_task.is_some() || self.no_fun || cx.reduce_motion() {
            return;
        }
        self._peek_anim_task = Some(cx.spawn(async move |this, cx| {
            loop {
                let mut keep_going = false;
                let res = this.update(cx, |app, cx| {
                    let suppressed = app.has_overlay_open(cx);
                    let sample = app.momo_peek.poll(
                        Instant::now(),
                        suppressed,
                        cx.reduce_motion(),
                        app.no_fun,
                    );
                    app.momo_peek_sample = sample;
                    keep_going = sample.animating;
                    if !keep_going {
                        app._peek_anim_task = None;
                    }
                    cx.notify();
                });
                if res.is_err() || !keep_going {
                    break;
                }
                cx.background_executor()
                    .timer(Duration::from_millis(33))
                    .await;
            }
        }));
    }

    pub(super) fn set_notice(&mut self, msg: impl Into<String>, cx: &mut Context<Self>) {
        self.status_notice = Some(msg.into());
        cx.notify();
        self._notice_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(2600))
                .await;
            let _ = this.update(cx, |app, cx| {
                app.status_notice = None;
                cx.notify();
            });
        }));
    }
}
