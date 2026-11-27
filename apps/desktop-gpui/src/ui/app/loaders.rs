//! Read-only loads on the background executor: startup, pages, graph, badges, review and store watching.

use super::*;

pub(super) fn load_initial_snapshot_with_overview(
    store: &ReadOnlyStore,
    overview: DbOverview,
    filter: &QueryFilter,
) -> Result<InitialLoadResult, DbError> {
    let page = store.query_nodes_page(
        filter,
        &overview.contradiction_node_ids,
        None,
        crate::core::db::LIST_PAGE_SIZE,
    )?;
    let total_matching = if !page.has_more {
        page.items.len()
    } else if filter.is_empty() {
        overview.node_count
    } else {
        store.count_matching_nodes(filter)?.max(page.items.len())
    };
    let health = assess_store_health(store, &overview, now_unix_ms()).ok();
    Ok(InitialLoadResult {
        overview,
        items: page.items,
        next_cursor: page.next_cursor,
        has_more: page.has_more,
        total_matching,
        health,
    })
}

pub(super) fn load_initial_snapshot_blocking(
    store: &ReadOnlyStore,
    filter: &QueryFilter,
) -> Result<InitialLoadResult, DbError> {
    let overview = store.load_overview()?;
    load_initial_snapshot_with_overview(store, overview, filter)
}

pub(super) fn db_file_stamp(db_path: &std::path::Path) -> Option<(u64, Option<SystemTime>)> {
    crate::core::store_cache::file_stamp(db_path)
}

pub(super) fn count_new_memory_ids(
    old_items: &[MemoryListItem],
    new_items: &[MemoryListItem],
    old_total: usize,
    new_total: usize,
) -> usize {
    let old_ids: std::collections::HashSet<&str> =
        old_items.iter().map(|item| item.id.as_str()).collect();
    let new_in_page = new_items
        .iter()
        .filter(|item| !old_ids.contains(item.id.as_str()))
        .count();
    new_in_page.max(new_total.saturating_sub(old_total))
}

pub(super) fn find_newest_added_id(
    old_items: &[MemoryListItem],
    new_items: &[MemoryListItem],
) -> Option<String> {
    let old_ids: std::collections::HashSet<&str> =
        old_items.iter().map(|item| item.id.as_str()).collect();
    new_items
        .iter()
        .filter(|item| !old_ids.contains(item.id.as_str()))
        .max_by_key(|item| (item.updated_at, item.created_at))
        .or_else(|| new_items.first())
        .map(|item| item.id.clone())
}

impl MemOSApp {
    pub(super) fn spawn_initial_load(&mut self, cx: &mut Context<Self>) {
        self.load_pins_for_store(cx);
        let db_path = self.resolved_db.path.clone();
        let filter = self.filter.clone();
        let timeline = self.timeline.clone();
        let shared = self.shared_store.clone();
        let record_startup = !self.initial_load_done;
        let fast_phase = record_startup;
        self.list_view.update(cx, |v, cx| v.set_loading(true, cx));

        // Phase one runs inside the same task, before the full load, so the
        // shared connection is free when it starts. It paints totals plus the
        // first page; facets, health and badges arrive in phase two.
        self._init_task = Some(cx.spawn(async move |this, cx| {
            let fast_applied = if fast_phase {
                let fast_db = db_path.clone();
                let fast_filter = filter.clone();
                let fast_shared = shared.clone();
                let fast_timeline = timeline.clone();
                let fast = cx
                    .background_executor()
                    .spawn(async move {
                        let db_open_start = Instant::now();
                        fast_shared.ensure_open(&fast_db)?;
                        fast_timeline.record_span("db_open", db_open_start, Instant::now());
                        fast_shared.with_store(&fast_db, |store| {
                            let (node_count, contradiction_ids) = store.load_list_fast_meta()?;
                            let overview =
                                DbOverview::fast(fast_db.clone(), node_count, contradiction_ids);
                            let list_start = Instant::now();
                            let page = store.query_nodes_page(
                                &fast_filter,
                                &overview.contradiction_node_ids,
                                None,
                                crate::core::db::LIST_PAGE_SIZE,
                            )?;
                            let total_matching = if !page.has_more {
                                page.items.len()
                            } else if fast_filter.is_empty() {
                                node_count
                            } else {
                                store
                                    .count_matching_nodes(&fast_filter)?
                                    .max(page.items.len())
                            };
                            Ok::<_, DbError>((overview, page, total_matching, list_start))
                        })
                    })
                    .await;

                let applied = this.update(cx, |app, cx| {
                    if app.initial_load_done {
                        return false;
                    }
                    if let Ok((overview, page, total_matching, list_start)) = fast {
                        timeline.record_span("first_list_page", list_start, Instant::now());
                        app.apply_fast_snapshot(overview, page, total_matching, cx);
                        true
                    } else {
                        false
                    }
                });
                matches!(applied, Ok(true))
            } else {
                false
            };

            let started = Instant::now();
            let result = cx
                .background_executor()
                .spawn(async move {
                    let db_open_start = Instant::now();
                    shared.ensure_open(&db_path)?;
                    if record_startup && !fast_applied {
                        timeline.record_span("db_open", db_open_start, Instant::now());
                    }

                    let phase = shared.with_store(&db_path, |store| {
                        let overview_start = Instant::now();
                        let overview = store.load_overview()?;
                        if record_startup {
                            timeline.record_span("overview", overview_start, Instant::now());
                        }
                        if fast_applied {
                            let health = assess_store_health(store, &overview, now_unix_ms()).ok();
                            Ok(PhaseTwo {
                                overview,
                                health,
                                full: None,
                            })
                        } else {
                            let list_start = Instant::now();
                            let loaded = load_initial_snapshot_with_overview(
                                store,
                                overview.clone(),
                                &filter,
                            )?;
                            Ok(PhaseTwo {
                                overview,
                                health: None,
                                full: Some((loaded, list_start)),
                            })
                        }
                    })?;
                    Ok::<PhaseTwo, DbError>(phase)
                })
                .await;

            let _ = this.update(cx, |app, cx| {
                let elapsed_ms = started.elapsed().as_secs_f32() * 1000.0;
                match result {
                    Ok(phase) => {
                        let overview = phase.overview;
                        tracing::info!(
                            nodes = overview.node_count,
                            edges = overview.edge_count,
                            elapsed_ms,
                            "database loaded read-only"
                        );
                        // In the fast path health comes from phase two; in the
                        // combined path it already rode along with the list.
                        let health = phase
                            .health
                            .or_else(|| phase.full.as_ref().and_then(|(l, _)| l.health.clone()));
                        app.apply_store_health_and_milestones(&overview, health, cx);
                        app.overview = Some(overview.clone());
                        app.sync_review_conflicts(cx);
                        app.last_db_stamp = db_file_stamp(&app.resolved_db.path);
                        app.sidebar
                            .update(cx, |s, cx| s.set_overview(Some(overview.clone()), cx));

                        if let Some((loaded, list_start)) = phase.full {
                            let total = overview.node_count;
                            let total_matching = loaded.total_matching;
                            app.list_cursor = loaded.next_cursor;
                            app.list_total_matching = total_matching;
                            app.loading_next_page = false;
                            app.page_generation.advance();
                            app._next_page_task = None;
                            app.list_view.update(cx, |list, cx| {
                                list.set_overview(Some(overview), cx);
                                list.set_items(
                                    loaded.items,
                                    !app.filter.is_empty(),
                                    total_matching,
                                    total,
                                    loaded.has_more,
                                    cx,
                                );
                                list.set_selected(None, false, cx);
                            });
                            app.selected_id = None;
                            app.detail_open = false;
                            app.detail_view.update(cx, |d, cx| d.set_detail(None, cx));
                            if record_startup {
                                app.timeline.record_span(
                                    "first_list_page",
                                    list_start,
                                    Instant::now(),
                                );
                            }
                        } else {
                            app.list_view
                                .update(cx, |list, cx| list.set_overview(Some(overview), cx));
                        }
                        app.spawn_brief_and_review_badges(cx);
                        if app.active_surface == WorkspaceSurface::Memories
                            && app.view_mode == ViewMode::Graph
                        {
                            app.spawn_graph_load(cx);
                        } else if app.active_surface == WorkspaceSurface::Review {
                            app.spawn_review_list_load(cx);
                        }
                    }
                    Err(DbError::NotFound) => {
                        tracing::info!(exists = false, elapsed_ms, "database file not found");
                        let path_str = app.resolved_db.path.display().to_string();
                        app.overview = None;
                        app.writer_preflight = WriterSchemaPreflight::default();
                        app.selected_id = None;
                        app.detail_open = false;
                        app.sidebar.update(cx, |s, cx| {
                            s.set_overview(None, cx);
                            s.set_health_report(None, cx);
                        });
                        app.list_view.update(cx, |list, cx| {
                            list.set_overview(None, cx);
                            list.set_missing_db(Some(path_str), cx);
                        });
                        app.detail_view.update(cx, |d, cx| d.set_detail(None, cx));
                    }
                    Err(err) => {
                        let safe_err = sanitize_db_error(&err, &app.resolved_db.path);
                        tracing::warn!(error = %safe_err, "failed to load database");
                        app.list_view
                            .update(cx, |list, cx| list.set_error(Some(safe_err), cx));
                    }
                }
                app.initial_load_done = true;
                let _ = app.timeline.write_report_if_configured();
                app.maybe_finish_startup_exit(cx);
            });
        }));
    }

    pub(super) fn schedule_filtered_query(&mut self, debounce_ms: u64, cx: &mut Context<Self>) {
        self.page_generation.advance();
        self.list_cursor = None;
        self.loading_next_page = false;
        self._next_page_task = None;
        let request_gen = self.query_generation.advance();
        let db_path = self.resolved_db.path.clone();
        let filter = self.filter.clone();
        let overview_clone = self.overview.clone();
        let shared = self.shared_store.clone();
        self.list_view.update(cx, |l, cx| l.set_loading(true, cx));

        self._search_task =
            Some(cx.spawn(async move |this, cx| {
                if debounce_ms > 0 {
                    cx.background_executor()
                        .timer(Duration::from_millis(debounce_ms))
                        .await;
                }

                let started = Instant::now();
                let result =
                    cx.background_executor()
                        .spawn(async move {
                            shared.with_store(&db_path, |store| {
                                let overview = match overview_clone {
                                    Some(ov) => ov,
                                    None => store.load_overview()?,
                                };
                                let page = store.query_nodes_page(
                                    &filter,
                                    &overview.contradiction_node_ids,
                                    None,
                                    crate::core::db::LIST_PAGE_SIZE,
                                )?;
                                let total_matching = if !page.has_more {
                                    page.items.len()
                                } else if filter.is_empty() {
                                    overview.node_count
                                } else {
                                    store.count_matching_nodes(&filter)?.max(page.items.len())
                                };
                                Ok::<(DbOverview, crate::core::db::ListPageResult, usize), DbError>(
                                    (overview, page, total_matching),
                                )
                            })
                        })
                        .await;

                let _ = this.update(cx, |app, cx| {
                    if !app.query_generation.is_current(request_gen) {
                        return;
                    }
                    let elapsed_ms = started.elapsed().as_secs_f32() * 1000.0;
                    match result {
                        Ok((ov, page, total_matching)) => {
                            tracing::info!(
                                results = page.items.len(),
                                total_matching,
                                has_more = page.has_more,
                                elapsed_ms,
                                has_query = !app.filter.query.trim().is_empty(),
                                "filtered query complete"
                            );
                            let total = ov.node_count;
                            let selected_still_present = app
                                .selected_id
                                .as_deref()
                                .is_some_and(|sel| page.items.iter().any(|it| it.id == sel));
                            app.list_cursor = page.next_cursor;
                            app.list_total_matching = total_matching;
                            app.loading_next_page = false;
                            app.list_view.update(cx, |list, cx| {
                                list.set_items(
                                    page.items,
                                    !app.filter.is_empty(),
                                    total_matching,
                                    total,
                                    page.has_more,
                                    cx,
                                );
                            });
                            if !selected_still_present {
                                app.selected_id = None;
                                app.detail_open = false;
                                app.list_view
                                    .update(cx, |list, cx| list.set_selected(None, false, cx));
                                app.graph_view
                                    .update(cx, |graph, cx| graph.set_selected(None, false, cx));
                                app.detail_view.update(cx, |d, cx| d.set_detail(None, cx));
                            }
                            if app.view_mode == ViewMode::Graph {
                                app.spawn_graph_load(cx);
                            }
                        }
                        Err(DbError::NotFound) => {
                            let path_str = app.resolved_db.path.display().to_string();
                            app.list_view
                                .update(cx, |list, cx| list.set_missing_db(Some(path_str), cx));
                        }
                        Err(err) => {
                            let msg = sanitize_db_error(&err, &app.resolved_db.path);
                            app.list_view
                                .update(cx, |list, cx| list.set_error(Some(msg), cx));
                        }
                    }
                });
            }));
    }

    pub(super) fn spawn_next_page_load(&mut self, cx: &mut Context<Self>) {
        if self.loading_next_page {
            return;
        }
        let Some(cursor) = self.list_cursor.clone() else {
            self.list_view
                .update(cx, |list, cx| list.cancel_loading_more(cx));
            return;
        };
        self.loading_next_page = true;
        self.page_generation.advance();
        let request_gen = self.page_generation.current();
        let query_gen = self.query_generation.current();
        let db_path = self.resolved_db.path.clone();
        let filter = self.filter.clone();
        let contradiction_ids = self
            .overview
            .as_ref()
            .map(|o| o.contradiction_node_ids.clone())
            .unwrap_or_default();
        let shared = self.shared_store.clone();

        self._next_page_task = Some(cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    shared.with_store(&db_path, |store| {
                        store.query_nodes_page(
                            &filter,
                            &contradiction_ids,
                            Some(&cursor),
                            LIST_NEXT_PAGE_SIZE,
                        )
                    })
                })
                .await;

            let _ = this.update(cx, |app, cx| {
                if !app.page_generation.is_current(request_gen)
                    || !app.query_generation.is_current(query_gen)
                {
                    return;
                }
                app.loading_next_page = false;
                match result {
                    Ok(page) => {
                        app.list_cursor = page.next_cursor;
                        let total_matching = app.list_total_matching;
                        app.list_view.update(cx, |list, cx| {
                            list.append_page(page.items, page.has_more, total_matching, cx);
                        });
                    }
                    Err(err) => {
                        tracing::warn!(error = %err, "failed to load next memory list page");
                        app.list_view
                            .update(cx, |list, cx| list.cancel_loading_more(cx));
                    }
                }
            });
        }));
    }

    pub(super) fn spawn_graph_load(&mut self, cx: &mut Context<Self>) {
        let request_gen = self.graph_generation.advance();
        let db_path = self.resolved_db.path.clone();
        let mode = self.graph_mode;
        let filter = self.filter.clone();
        let overview_clone = self.overview.clone();
        let shared = self.shared_store.clone();

        self.graph_view.update(cx, |g, cx| {
            g.set_mode(mode, cx);
            g.set_loading(true, cx);
        });

        self._graph_task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move {
                    shared.with_store(&db_path, |store| {
                        let overview = match overview_clone {
                            Some(ov) => ov,
                            None => store.load_overview()?,
                        };
                        store.load_graph_snapshot(
                            mode,
                            &filter,
                            &overview.contradiction_node_ids,
                            DEFAULT_GRAPH_NODE_CAP,
                        )
                    })
                })
                .await;

            let _ = this.update(cx, |app, cx| {
                if !app.graph_generation.is_current(request_gen) {
                    return;
                }
                match res {
                    Ok(snapshot) => {
                        app.graph_view
                            .update(cx, |g, cx| g.apply_snapshot(snapshot, cx));
                    }
                    Err(err) => {
                        let msg = sanitize_db_error(&err, &app.resolved_db.path);
                        app.graph_view
                            .update(cx, |g, cx| g.set_error(Some(msg), cx));
                    }
                }
            });
        }));
    }

    pub(super) fn start_db_watcher(&mut self, cx: &mut Context<Self>) {
        let shared = self.shared_store.clone();
        self._db_watch_task = Some(cx.spawn(async move |this, cx| {
            let mut watcher: Option<crate::ui::db_watch::DbWatcher> = None;
            loop {
                let state = this.read_with(cx, |app, _| {
                    (
                        app.window_active,
                        app.onboarding.is_some(),
                        app.resolved_db.path.clone(),
                    )
                });
                let Ok((active, onboarding_open, db_path)) = state else {
                    break;
                };

                // Event-driven watching replaces the fixed 1.5 s poll: kernel
                // notifications wake the task only when the store actually
                // changes. A slow fallback poll covers missed events; when no
                // watcher can be installed (onboarding, missing directory,
                // unsupported backend) the legacy cadence keeps the old
                // behavior.
                let legacy = onboarding_open || {
                    if watcher.as_ref().is_some_and(|w| w.db_path() != db_path) {
                        watcher = None;
                    }
                    if watcher.is_none() {
                        watcher = crate::ui::db_watch::DbWatcher::watch(&db_path);
                    }
                    watcher.is_none()
                };
                let fallback = if legacy {
                    Duration::from_millis(if active { 1500 } else { 8000 })
                } else {
                    Duration::from_secs(if active { 15 } else { 60 })
                };

                match watcher.as_mut() {
                    Some(w) if !legacy => {
                        let fired = {
                            let event = futures::StreamExt::next(w.receiver());
                            let tick = cx.background_executor().timer(fallback);
                            futures::pin_mut!(event, tick);
                            matches!(
                                futures::future::select(event, tick).await,
                                futures::future::Either::Left(_)
                            )
                        };
                        if fired {
                            // Coalesce the burst of events a single SQLite
                            // write produces, then drain any extras.
                            cx.background_executor()
                                .timer(Duration::from_millis(250))
                                .await;
                            while w.receiver().try_recv().is_ok() {}
                        } else {
                            // Fallback-poll wake: refresh the watch so a
                            // deleted-then-recreated store directory regains
                            // live watching (kernel watches die with the
                            // directory). Recreated on the next iteration.
                            // Teardown joins the backend thread (FSEvents on
                            // macOS), so drop it off the foreground task.
                            if let Some(w) = watcher.take() {
                                cx.background_executor()
                                    .spawn(async move {
                                        drop(w);
                                    })
                                    .detach();
                            }
                        }
                    }
                    _ => {
                        cx.background_executor().timer(fallback).await;
                    }
                }
                let info = this.read_with(cx, |app, _| {
                    if app.onboarding.is_some() {
                        return None;
                    }
                    let current = db_file_stamp(&app.resolved_db.path);
                    if current.is_some() && current != app.last_db_stamp {
                        Some((app.resolved_db.path.clone(), app.filter.clone(), current))
                    } else {
                        None
                    }
                });
                let Ok(Some((db_path, filter, stamp))) = info else {
                    if info.is_err() {
                        break;
                    }
                    continue;
                };

                let reload_shared = shared.clone();
                let reloaded = cx
                    .background_executor()
                    .spawn(async move {
                        reload_shared.with_store(&db_path, |store| {
                            load_initial_snapshot_blocking(store, &filter)
                        })
                    })
                    .await;

                if let Ok(loaded) = reloaded {
                    let _ = this.update(cx, |app, cx| {
                        let is_browsing = app.selected_id.is_some()
                            || app.detail_open
                            || app.list_view.read(cx).is_browsing_or_scrolled();
                        if is_browsing {
                            let old_total =
                                app.overview.as_ref().map(|o| o.node_count).unwrap_or(0);
                            let (new_count, newest_id) = {
                                let existing = app.list_view.read(cx).items();
                                (
                                    count_new_memory_ids(
                                        existing,
                                        &loaded.items,
                                        old_total,
                                        loaded.overview.node_count,
                                    ),
                                    find_newest_added_id(existing, &loaded.items),
                                )
                            };
                            app.last_db_stamp = stamp;
                            app.pending_live_reload = Some(PendingLiveReload {
                                result: loaded,
                                stamp,
                                newest_id,
                            });
                            app.list_view
                                .update(cx, |l, cx| l.set_pending_new_count(Some(new_count), cx));
                            if app.active_surface == WorkspaceSurface::Today {
                                app.spawn_brief_and_review_badges(cx);
                            }
                        } else {
                            app.apply_loaded_snapshot(loaded, stamp, None, cx);
                        }
                    });
                }
            }
        }));
    }

    /// First-paint apply: list + totals only. Deliberately does not touch
    /// health, milestones, brief, graph or review; the full load owns those.
    pub(super) fn apply_fast_snapshot(
        &mut self,
        overview: DbOverview,
        page: crate::core::db::ListPageResult,
        total_matching: usize,
        cx: &mut Context<Self>,
    ) {
        self.remember_current_store();
        if self.active_surface != WorkspaceSurface::Memories {
            return;
        }
        let total = overview.node_count;
        let filtered = !self.filter.is_empty();
        self.list_cursor = page.next_cursor;
        self.list_total_matching = total_matching;
        self.loading_next_page = false;
        self.overview = Some(overview.clone());
        self.sync_review_conflicts(cx);
        self.sidebar
            .update(cx, |s, cx| s.set_overview(Some(overview.clone()), cx));
        self.list_view.update(cx, |list, cx| {
            list.set_overview(Some(overview), cx);
            list.set_items(
                page.items,
                filtered,
                total_matching,
                total,
                page.has_more,
                cx,
            );
        });
        cx.notify();
    }

    pub(super) fn apply_loaded_snapshot(
        &mut self,
        loaded: InitialLoadResult,
        stamp: Option<(u64, Option<SystemTime>)>,
        jump_to_id: Option<String>,
        cx: &mut Context<Self>,
    ) {
        self.remember_current_store();
        self.last_db_stamp = stamp;
        self.pending_live_reload = None;
        let total = loaded.overview.node_count;
        let total_matching = loaded.total_matching;
        let has_more = loaded.has_more;
        self.list_cursor = loaded.next_cursor;
        self.list_total_matching = total_matching;
        self.loading_next_page = false;
        self.page_generation.advance();
        self._next_page_task = None;
        let ov = loaded.overview.clone();
        let ov_list = loaded.overview.clone();

        self.apply_store_health_and_milestones(&loaded.overview, loaded.health, cx);
        self.overview = Some(loaded.overview);
        self.sync_review_conflicts(cx);
        self.sidebar
            .update(cx, |s, cx| s.set_overview(Some(ov), cx));
        self.list_view.update(cx, |list, cx| {
            list.set_pending_new_count(None, cx);
            list.set_overview(Some(ov_list), cx);
            list.set_items(
                loaded.items,
                !self.filter.is_empty(),
                total_matching,
                total,
                has_more,
                cx,
            );
            if jump_to_id.is_some() {
                list.scroll_to_top(cx);
            }
        });

        if let Some(target_id) = jump_to_id {
            self.select_memory(target_id, true, cx);
        }
        // A reload must not close the detail pane just because the selected
        // memory fell outside the first page: that would throw away the
        // user's reading position. Explicit deletes clear `selected_id`
        // before reloading, so a genuinely removed memory still closes it.

        self.spawn_brief_and_review_badges(cx);
        if self.active_surface == WorkspaceSurface::Memories && self.view_mode == ViewMode::Graph {
            self.spawn_graph_load(cx);
        } else if self.active_surface == WorkspaceSurface::Review {
            self.spawn_review_list_load(cx);
        }
        cx.notify();
    }

    pub(super) fn spawn_brief_and_review_badges(&mut self, cx: &mut Context<Self>) {
        let db_path = self.resolved_db.path.clone();
        let contradiction_ids = self
            .overview
            .as_ref()
            .map(|o| o.contradiction_node_ids.clone())
            .unwrap_or_default();
        let shared = self.shared_store.clone();
        if self.active_surface == WorkspaceSurface::Today {
            self.brief_view.update(cx, |b, cx| b.set_loading(true, cx));
        }

        self._brief_task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move {
                    shared.with_store(&db_path, |store| {
                        let now_ms = now_unix_ms();
                        let snapshot = store.load_brief(now_ms, &contradiction_ids, 5)?;
                        let pending_review = store.count_pending_review().unwrap_or(0);
                        Ok::<(BriefSnapshot, usize), DbError>((snapshot, pending_review))
                    })
                })
                .await;

            let _ = this.update(cx, |app, cx| match res {
                Ok((snapshot, pending_review)) => {
                    let today_count = snapshot.total_count();
                    app.today_count = today_count;
                    app.pending_review_count = pending_review;
                    app.sidebar.update(cx, |s, cx| {
                        s.set_special_counts(today_count, pending_review, cx);
                    });
                    app.brief_view
                        .update(cx, |b, cx| b.set_snapshot(snapshot, cx));
                }
                Err(err) => {
                    let msg = sanitize_db_error(&err, &app.resolved_db.path);
                    app.brief_view
                        .update(cx, |b, cx| b.set_error(Some(msg), cx));
                }
            });
        }));
    }

    pub(super) fn refresh_review_view(&mut self, cx: &mut Context<Self>) {
        // Never start the MCP writer just to list review candidates. The
        // writer's read pass can re-sync node_tags and mutate a store that the
        // UI is presenting as read-only.
        if self.settings.write_mode && self.writer_preflight.compatible {
            self.spawn_review_list_load(cx);
        } else {
            self.spawn_read_only_review_load(cx);
        }
    }

    /// List the review queue straight from SQLite when the writer is off.
    ///
    /// The queue is read-only here: approve/reject remain gated on write mode,
    /// but the user can still see what their agents have queued up.
    pub(super) fn spawn_read_only_review_load(&mut self, cx: &mut Context<Self>) {
        let db_path = self.resolved_db.path.clone();
        let shared = self.shared_store.clone();
        self.review_view.update(cx, |r, cx| {
            r.set_load_error(None, cx);
            r.set_loading(true, cx);
        });

        self._review_task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move {
                    shared.with_store(&db_path, |store| store.load_pending_review(500))
                })
                .await;

            let _ = this.update(cx, |app, cx| match res {
                Ok(items) => {
                    let count = items.len();
                    app.pending_review_count = count;
                    app.sidebar
                        .update(cx, |s, cx| s.set_pending_review_count(count, cx));
                    app.review_view.update(cx, |r, cx| r.set_items(items, cx));
                }
                Err(err) => {
                    tracing::warn!(error = %err, "failed to list pending review from sqlite");
                    app.review_view.update(cx, |r, cx| {
                        r.set_load_error(Some(ReviewLoadError::Other(err.to_string())), cx)
                    });
                }
            });
        }));
    }

    pub(super) fn spawn_review_list_load(&mut self, cx: &mut Context<Self>) {
        let cmd = self.settings.effective_writer_command();
        self.write_bridge.configure(&cmd, &self.resolved_db.path);
        let bridge = self.write_bridge.clone();
        self.review_view.update(cx, |r, cx| r.set_loading(true, cx));

        self._review_task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move {
                    bridge.review(ReviewInput {
                        action: "list".to_string(),
                        id: None,
                        namespace: None,
                    })
                })
                .await;

            let _ = this.update(cx, |app, cx| match res {
                Ok(review) => {
                    let count = review.items.len();
                    app.pending_review_count = count;
                    app.sidebar
                        .update(cx, |s, cx| s.set_pending_review_count(count, cx));
                    app.review_view
                        .update(cx, |r, cx| r.set_items(review.items, cx));
                }
                Err(err) => {
                    let load_err = if err.is_capability_missing() {
                        ReviewLoadError::CapabilityMissing(err.ui_summary())
                    } else {
                        ReviewLoadError::Other(err.ui_summary())
                    };
                    app.review_view
                        .update(cx, |r, cx| r.set_load_error(Some(load_err), cx));
                }
            });
        }));
    }
}
