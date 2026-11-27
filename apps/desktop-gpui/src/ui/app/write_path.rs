//! Everything that changes the store. Writes go through the MCP `WriteBridge`; Rust never writes SQLite here.

use super::*;

/// Dedicated crash report recovery window launched by the panic hook.
pub(super) fn sanitize_db_error(err: &DbError, path: &std::path::Path) -> String {
    // Keep the message actionable without putting the full home path (and
    // therefore the OS username) into logs and crash reports.
    let label = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("the database file");
    match err {
        DbError::NotFound => format!("Database not found at {label}"),
        DbError::MissingNodesTable => "Database has no `nodes` table (run `memos init`)".into(),
        DbError::OpenFailed { code } => format!("Failed to open read-only SQLite store ({code})"),
        DbError::QueryFailed { code } => format!("Read-only SQLite query failed ({code})"),
    }
}

pub fn is_ingest_button_visible(write_mode: bool) -> bool {
    write_mode
}

pub fn parse_ingest_chunk_chars(raw: &str) -> Result<Option<usize>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let val: usize = trimmed
        .parse()
        .map_err(|_| "Chunk size must be a positive integer.".to_string())?;
    if !(100..=20_000).contains(&val) {
        return Err("Chunk size must be between 100 and 20000 characters.".to_string());
    }
    Ok(Some(val))
}

impl MemOSApp {
    /// Create a fresh store at `path`, then reload as if it had always existed.
    ///
    /// This is the only write path in the desktop crate that is not gated on
    /// write mode: it touches a path that does not hold a store yet.
    pub(super) fn create_memory_store(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        if self.store_create_in_flight {
            return;
        }
        self.store_create_in_flight = true;
        self.set_notice("Creating memory store…", cx);
        let create_path = path.clone();

        self._init_task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move { crate::core::store_init::create_store(&create_path) })
                .await;

            let _ = this.update(cx, |app, cx| {
                app.store_create_in_flight = false;
                match res {
                    Ok(()) => {
                        app.set_notice("Memory store created", cx);
                        app.spawn_initial_load(cx);
                        app.refresh_review_view(cx);
                    }
                    Err(err) => {
                        tracing::warn!(error = %err, "failed to create memory store");
                        app.set_notice(err.ui_summary(), cx);
                    }
                }
            });
        }));
    }

    /// Add missing read-path indexes. Explicit, non-destructive, idempotent.
    pub(super) fn optimize_store(&mut self, cx: &mut Context<Self>) {
        if self.store_optimize_in_flight {
            return;
        }
        self.store_optimize_in_flight = true;
        self.set_notice("Optimising store…", cx);
        let path = self.resolved_db.path.clone();

        self._optimize_task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move { crate::core::store_optimize::optimize_store(&path) })
                .await;

            let _ = this.update(cx, |app, cx| {
                app.store_optimize_in_flight = false;
                match res {
                    Ok(report) => {
                        // The cached connection must reopen: indexes changed.
                        app.shared_store.invalidate();
                        app.set_notice(report.summary(), cx);
                        app.spawn_initial_load(cx);
                    }
                    Err(err) => {
                        tracing::warn!(error = %err, "store optimisation failed");
                        app.set_notice(err.ui_summary(), cx);
                    }
                }
            });
        }));
    }

    pub(super) fn set_write_mode(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if enabled && !self.writer_preflight.compatible {
            self.settings.write_mode = false;
            self.bounds_dirty = false;
            self.settings.save_async();
            self.sync_write_mode_to_views(cx);
            if let Some(msg) = self.writer_preflight.human_message() {
                self.set_notice(msg, cx);
            }
            cx.notify();
            return;
        }
        self.settings.write_mode = enabled;
        self.bounds_dirty = false;
        self.settings.save_async();
        let cmd = self.settings.effective_writer_command().to_string();
        self.write_bridge.configure(&cmd, &self.resolved_db.path);
        self.writer_test_status = None;
        self.sync_write_mode_to_views(cx);
        self.set_notice(
            if enabled {
                "Write mode enabled (MemOS MCP)"
            } else {
                "Read-only mode restored"
            },
            cx,
        );
        cx.notify();
    }

    pub(super) fn reset_writer_command(&mut self, cx: &mut Context<Self>) {
        let recommended = recommended_writer_command();
        self.settings.writer_command = recommended.clone();
        self.bounds_dirty = false;
        self.settings.save_async();
        self.write_bridge
            .configure(&recommended, &self.resolved_db.path);
        self.writer_cmd_input
            .update(cx, |v, cx| v.set_text(recommended, cx));
        self.writer_test_status = None;
        self.write_bridge_error = None;
        self.set_notice("Writer command reset to default", cx);
        cx.notify();
    }

    pub(super) fn use_local_writer_command(&mut self, command: String, cx: &mut Context<Self>) {
        self.settings.writer_command = command.clone();
        self.bounds_dirty = false;
        self.settings.save_async();
        self.write_bridge
            .configure(&command, &self.resolved_db.path);
        self.writer_cmd_input
            .update(cx, |v, cx| v.set_text(command, cx));
        self.writer_test_status = None;
        self.write_bridge_error = None;
        self.set_notice("Switched writer command to local CLI", cx);
        cx.notify();
    }

    pub(super) fn active_writer_ping(&self) -> Option<PingResult> {
        if let Some(Ok(info)) = &self.writer_test_status {
            return Some(info.clone());
        }
        self.write_bridge.connected_info()
    }

    pub(super) fn run_writer_ping(&mut self, cx: &mut Context<Self>) {
        self.flush_dirty_settings();
        let cmd = self.settings.effective_writer_command();
        self.write_bridge.configure(&cmd, &self.resolved_db.path);
        self.writer_testing = true;
        self.writer_test_status = None;
        cx.notify();

        let bridge = self.write_bridge.clone();
        self._writer_ping_task = Some(cx.spawn(async move |this, cx| {
            let outcome = cx
                .background_executor()
                .spawn(async move { bridge.ping() })
                .await;
            let _ = this.update(cx, |app, cx| {
                app.writer_testing = false;
                match outcome {
                    Ok(info) => {
                        app.writer_test_status = Some(Ok(info));
                        app.write_bridge_error = None;
                    }
                    Err(err) => {
                        app.writer_test_status = Some(Err(err.ui_summary()));
                    }
                }
                cx.notify();
            });
        }));
    }

    pub(super) fn open_new_memory_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.settings.write_mode {
            self.set_notice("Enable write mode in Settings to add memories", cx);
            return;
        }
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.close_all_modals();
        self.composer_editing_id = None;
        self.composer_type = self
            .filter
            .node_type
            .clone()
            .unwrap_or_else(|| "fact".to_string());
        self.composer_pool = "event".to_string();
        self.composer_validation_error = None;
        let default_ns = self.filter.namespace.clone().unwrap_or_default();
        self.composer_content_input.update(cx, |v, cx| v.clear(cx));
        self.composer_tags_input.update(cx, |v, cx| v.clear(cx));
        self.composer_namespace_input
            .update(cx, |v, cx| v.set_text(default_ns, cx));
        self.composer_context_input.update(cx, |v, cx| v.clear(cx));
        self.show_composer_modal = true;
        let focus = self.composer_content_input.focus_handle(cx);
        window.focus(&focus, cx);
        cx.notify();
    }

    pub(super) fn open_edit_memory_composer(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.settings.write_mode {
            self.set_notice("Enable write mode in Settings to edit memories", cx);
            return;
        }
        let Some(target_id) = self.selected_id.clone() else {
            self.set_notice("Select a memory first", cx);
            return;
        };

        let detail_opt = self
            .detail_view
            .read(cx)
            .detail()
            .filter(|d| d.id == target_id)
            .cloned();

        let (node_type, pool, tags_csv, namespace, body_text) = if let Some(d) = detail_opt {
            let pool = if matches!(d.pool.as_str(), "event" | "note" | "procedure") {
                d.pool.clone()
            } else {
                "event".to_string()
            };
            let ns = if d.namespace == "default" || d.namespace.is_empty() {
                String::new()
            } else {
                d.namespace.clone()
            };
            let text = if !d.content.trim().is_empty() {
                d.content.clone()
            } else {
                d.summary.clone()
            };
            (d.node_type.clone(), pool, d.tags.join(", "), ns, text)
        } else if let Some(item) = self
            .list_view
            .read(cx)
            .items()
            .iter()
            .find(|it| it.id == target_id)
            .cloned()
        {
            let ns = if item.namespace.as_ref() == "default" || item.namespace.is_empty() {
                String::new()
            } else {
                item.namespace.to_string()
            };
            let tags_joined = item
                .tags
                .iter()
                .map(|t| t.as_ref())
                .collect::<Vec<_>>()
                .join(", ");
            (
                item.node_type.to_string(),
                "event".to_string(),
                tags_joined,
                ns,
                item.preview.to_string(),
            )
        } else {
            self.set_notice("Selected memory is no longer available", cx);
            return;
        };

        self.dismiss_popovers(PopoverOwner::None, cx);
        self.close_all_modals();
        self.composer_editing_id = Some(target_id);
        self.composer_type = if node_type.trim().is_empty() {
            "fact".to_string()
        } else {
            node_type
        };
        self.composer_pool = pool;
        self.composer_validation_error = None;
        self.composer_content_input
            .update(cx, |v, cx| v.set_text(body_text, cx));
        self.composer_tags_input
            .update(cx, |v, cx| v.set_text(tags_csv, cx));
        self.composer_namespace_input
            .update(cx, |v, cx| v.set_text(namespace, cx));
        self.composer_context_input.update(cx, |v, cx| v.clear(cx));
        self.show_composer_modal = true;
        let focus = self.composer_content_input.focus_handle(cx);
        window.focus(&focus, cx);
        cx.notify();
    }

    pub(super) fn submit_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.write_in_flight {
            return;
        }
        if !self.settings.write_mode {
            self.show_composer_modal = false;
            self.set_notice("Write mode is disabled", cx);
            return;
        }
        let content = self
            .composer_content_input
            .read(cx)
            .text()
            .trim()
            .to_string();
        if content.is_empty() {
            self.composer_validation_error =
                Some("Enter memory content before saving.".to_string());
            cx.notify();
            return;
        }
        let tags: Vec<String> = self
            .composer_tags_input
            .read(cx)
            .text()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string)
            .collect();
        let namespace = {
            let ns = self
                .composer_namespace_input
                .read(cx)
                .text()
                .trim()
                .to_string();
            if ns.is_empty() { None } else { Some(ns) }
        };
        let context = {
            let ctx = self
                .composer_context_input
                .read(cx)
                .text()
                .trim()
                .to_string();
            if ctx.is_empty() { None } else { Some(ctx) }
        };

        let input = StoreInput {
            content,
            node_type: Some(self.composer_type.clone()),
            tags,
            namespace,
            pool: Some(self.composer_pool.clone()),
            context,
        };
        let editing_id = self.composer_editing_id.take();
        self.show_composer_modal = false;
        self.composer_validation_error = None;
        window.focus(&self.focus_handle, cx);

        let action = if let Some(original_id) = editing_id {
            WriteRetryAction::Edit { original_id, input }
        } else {
            WriteRetryAction::Store { input }
        };
        self.execute_write_action(action, cx);
    }

    pub(super) fn open_forget_confirm(&mut self, cx: &mut Context<Self>) {
        let Some(target_id) = self.selected_id.clone() else {
            self.set_notice("Select a memory first", cx);
            return;
        };
        self.open_forget_confirm_for(target_id, cx);
    }

    pub(super) fn open_forget_confirm_for(&mut self, target_id: String, cx: &mut Context<Self>) {
        if !self.settings.write_mode {
            self.set_notice("Enable write mode in Settings to forget memories", cx);
            return;
        }

        let detail_opt = self
            .detail_view
            .read(cx)
            .detail()
            .filter(|d| d.id == target_id)
            .cloned()
            .or_else(|| self.compare.detail_for(&target_id).cloned());
        let (short_id, raw_preview) = if let Some(d) = detail_opt {
            let text = if !d.summary.trim().is_empty() {
                d.summary.clone()
            } else {
                d.content.clone()
            };
            (d.short_id.clone(), text)
        } else if let Some(item) = self
            .list_view
            .read(cx)
            .items()
            .iter()
            .find(|it| it.id == target_id)
        {
            (item.short_id.to_string(), item.preview.to_string())
        } else {
            let short: String = target_id.chars().take(8).collect();
            (short, String::new())
        };

        let first_line = raw_preview
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("Selected memory")
            .to_string();
        let preview = if first_line.chars().count() > 110 {
            let clipped: String = first_line.chars().take(109).collect();
            format!("{clipped}…")
        } else {
            first_line
        };

        self.dismiss_popovers(PopoverOwner::None, cx);
        self.close_all_modals();
        self.forget_confirm_target = Some(ForgetTarget {
            id: target_id,
            short_id,
            preview,
        });
        cx.notify();
    }

    pub(super) fn confirm_forget(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.write_in_flight {
            self.set_notice("Wait for the current save to finish", cx);
            return;
        }
        let Some(target) = self.forget_confirm_target.take() else {
            return;
        };
        window.focus(&self.focus_handle, cx);
        if !self.settings.write_mode {
            self.set_notice("Write mode is disabled", cx);
            return;
        }
        self.execute_write_action(WriteRetryAction::Forget { id: target.id }, cx);
    }

    pub(super) fn retry_failed_write(&mut self, cx: &mut Context<Self>) {
        if self.write_in_flight {
            return;
        }
        let Some(banner) = self.write_bridge_error.clone() else {
            return;
        };
        if !self.settings.write_mode {
            self.write_bridge_error = None;
            cx.notify();
            return;
        }
        self.execute_write_action(banner.retry_action, cx);
    }

    pub(super) fn execute_write_action(
        &mut self,
        action: WriteRetryAction,
        cx: &mut Context<Self>,
    ) {
        if !self.settings.write_mode {
            self.set_notice("Write mode is disabled", cx);
            return;
        }
        self.flush_dirty_settings();
        let cmd = self.settings.effective_writer_command().to_string();
        self.write_bridge.configure(&cmd, &self.resolved_db.path);
        let bridge = self.write_bridge.clone();
        let retry_action = action.clone();
        self.write_in_flight = true;
        self.write_bridge_error = None;
        cx.notify();

        self._write_task = Some(cx.spawn(async move |this, cx| {
            let outcome = cx
                .background_executor()
                .spawn(async move {
                    match action {
                        WriteRetryAction::Store { input } => match bridge.store(input) {
                            Ok(stored) => Ok::<_, (BridgeError, Option<WriteRetryAction>)>((
                                Some(stored.id),
                                None,
                                "Memory saved".to_string(),
                            )),
                            Err(err) => Err((err, None)),
                        },
                        WriteRetryAction::Edit { original_id, input } => {
                            match bridge.store(input) {
                                Ok(stored) => {
                                    match bridge.supersede(&original_id, Some(&stored.id)) {
                                        Ok(_) => Ok((
                                            Some(stored.id),
                                            Some(original_id),
                                            "Saved as a new version".to_string(),
                                        )),
                                        Err(err) => Err((
                                            err,
                                            Some(WriteRetryAction::FinishEdit {
                                                original_id,
                                                new_id: stored.id,
                                            }),
                                        )),
                                    }
                                }
                                Err(err) => Err((err, None)),
                            }
                        }
                        WriteRetryAction::FinishEdit {
                            original_id,
                            new_id,
                        } => match bridge.supersede(&original_id, Some(&new_id)) {
                            Ok(_) => Ok((
                                Some(new_id),
                                Some(original_id),
                                "Saved as a new version".to_string(),
                            )),
                            Err(err) => Err((
                                err,
                                Some(WriteRetryAction::FinishEdit {
                                    original_id,
                                    new_id,
                                }),
                            )),
                        },
                        WriteRetryAction::Forget { id } => match bridge.forget(&id) {
                            Ok(_) => Ok((None, Some(id), "Memory forgotten".to_string())),
                            Err(err) => Err((err, None)),
                        },
                        WriteRetryAction::Review { id, approve } => {
                            let action = if approve { "approve" } else { "reject" }.to_string();
                            match bridge.review(ReviewInput {
                                action,
                                id: Some(id),
                                namespace: None,
                            }) {
                                Ok(done) => Ok((None, None, done.summary)),
                                Err(err) => Err((err, None)),
                            }
                        }
                    }
                })
                .await;

            let _ = this.update(cx, |app, cx| {
                app.write_in_flight = false;
                match outcome {
                    Ok((jump_id, removed_id, toast)) => {
                        app.write_bridge_error = None;
                        if let Some(old_id) = removed_id
                            && app.selected_id.as_deref() == Some(old_id.as_str())
                        {
                            app.selected_id = None;
                            app.detail_open = false;
                        }
                        app.set_notice(toast, cx);
                        app.reload_store_after_write(jump_id, cx);
                    }
                    Err((err, retry_override)) => {
                        let summary = err.ui_summary();
                        tracing::warn!(error = %summary, "MCP write operation failed");
                        app.write_bridge_error = Some(BridgeErrorBanner {
                            command: cmd,
                            message: summary,
                            retry_action: retry_override.unwrap_or(retry_action),
                        });
                        cx.notify();
                    }
                }
            });
        }));
    }

    pub(super) fn reload_store_after_write(
        &mut self,
        jump_to_id: Option<String>,
        cx: &mut Context<Self>,
    ) {
        let db_path = self.resolved_db.path.clone();
        let filter = self.filter.clone();
        let shared = self.shared_store.clone();
        self._init_task = Some(cx.spawn(async move |this, cx| {
            let reloaded = cx
                .background_executor()
                .spawn(async move {
                    shared.with_store(&db_path, |store| {
                        load_initial_snapshot_blocking(store, &filter)
                    })
                })
                .await;

            let _ = this.update(cx, |app, cx| match reloaded {
                Ok(loaded) => {
                    let stamp = db_file_stamp(&app.resolved_db.path);
                    app.apply_loaded_snapshot(loaded, stamp, jump_to_id, cx);
                }
                Err(DbError::NotFound) => {
                    app.overview = None;
                    app.writer_preflight = WriterSchemaPreflight::default();
                    app.close_detail(cx);
                }
                Err(err) => {
                    let msg = sanitize_db_error(&err, &app.resolved_db.path);
                    app.set_notice(msg, cx);
                }
            });
        }));
    }

    pub(super) fn execute_review_decision(
        &mut self,
        id: String,
        approve: bool,
        cx: &mut Context<Self>,
    ) {
        if !self.settings.write_mode {
            self.set_notice("Turn on editing to review", cx);
            return;
        }
        let cmd = self.settings.effective_writer_command().to_string();
        self.write_bridge.configure(&cmd, &self.resolved_db.path);
        let bridge = self.write_bridge.clone();
        let retry_id = id.clone();
        self.review_view
            .update(cx, |r, cx| r.set_busy_id(Some(id.clone()), cx));
        let action = if approve { "approve" } else { "reject" }.to_string();

        self._review_task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move {
                    bridge.review(ReviewInput {
                        action,
                        id: Some(id),
                        namespace: None,
                    })
                })
                .await;

            let _ = this.update(cx, |app, cx| match res {
                Ok(done) => {
                    app.set_notice(done.summary, cx);
                    app.reload_store_after_write(None, cx);
                    app.spawn_review_list_load(cx);
                }
                Err(err) => {
                    let msg = err.ui_summary();
                    app.review_view.update(cx, |r, cx| r.set_busy_id(None, cx));
                    app.write_bridge_error = Some(BridgeErrorBanner {
                        command: cmd,
                        message: msg,
                        retry_action: WriteRetryAction::Review {
                            id: retry_id,
                            approve,
                        },
                    });
                    cx.notify();
                }
            });
        }));
    }

    pub(super) fn open_ingest_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !is_ingest_button_visible(self.settings.write_mode) {
            self.set_notice("Enable write mode to ingest files", cx);
            return;
        }
        self.dismiss_popovers(PopoverOwner::None, cx);
        self.close_all_modals();
        let cmd = self.settings.effective_writer_command();
        self.write_bridge.configure(&cmd, &self.resolved_db.path);
        self.ingest_error = self
            .write_bridge
            .cached_supports_tool("memos_ingest")
            .and_then(|res| res.err())
            .map(|err| err.ui_summary());
        self.ingest_result = None;
        self.ingest_in_flight = false;
        self.show_ingest_modal = true;
        let path_focus = self.ingest_path_input.focus_handle(cx);
        window.focus(&path_focus, cx);
        cx.notify();
    }

    pub(super) fn browse_ingest_path(&mut self, cx: &mut Context<Self>) {
        let receiver = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: true,
            multiple: false,
            prompt: Some("Select file or folder to ingest into MemOS".into()),
        });
        self._browse_ingest_task = Some(cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = receiver.await
                && let Some(selected) = paths.into_iter().next()
            {
                let display = selected.to_string_lossy().to_string();
                let _ = this.update(cx, |app, cx| {
                    app.ingest_path_input
                        .update(cx, |i, cx| i.set_text(display, cx));
                    app.ingest_error = None;
                    cx.notify();
                });
            }
        }));
    }

    pub(super) fn submit_ingest(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.settings.write_mode {
            self.ingest_error = Some("Enable write mode in Settings before ingesting.".to_string());
            cx.notify();
            return;
        }
        if self.ingest_in_flight {
            return;
        }
        let path = self.ingest_path_input.read(cx).text().trim().to_string();
        if path.is_empty() {
            self.ingest_error = Some("Select a file or folder path first.".to_string());
            cx.notify();
            return;
        }
        let chunk_chars = match parse_ingest_chunk_chars(self.ingest_chunk_input.read(cx).text()) {
            Ok(val) => val,
            Err(err) => {
                self.ingest_error = Some(err);
                cx.notify();
                return;
            }
        };
        let ns_raw = self
            .ingest_namespace_input
            .read(cx)
            .text()
            .trim()
            .to_string();
        let namespace = if ns_raw.is_empty() {
            None
        } else {
            Some(ns_raw)
        };
        let extensions = parse_extensions_csv(self.ingest_extensions_input.read(cx).text());
        let input = IngestInput {
            path,
            namespace,
            extensions,
            chunk_chars,
            recursive: self.ingest_recursive,
        };

        let cmd = self.settings.effective_writer_command().to_string();
        self.write_bridge.configure(&cmd, &self.resolved_db.path);
        let bridge = self.write_bridge.clone();
        self.ingest_in_flight = true;
        self.ingest_error = None;
        self.ingest_result = None;
        window.focus(&self.focus_handle, cx);
        cx.notify();

        self._ingest_task = Some(cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move { bridge.ingest(input) })
                .await;

            let _ = this.update(cx, |app, cx| {
                app.ingest_in_flight = false;
                match res {
                    Ok(summary) => {
                        app.ingest_error = None;
                        app.ingest_result = Some(summary.clone());
                        app.set_notice(
                            format!("Ingest complete: {}", summary.format_summary()),
                            cx,
                        );
                        app.reload_store_after_write(None, cx);
                    }
                    Err(err) => {
                        app.ingest_error = Some(err.ui_summary());
                        cx.notify();
                    }
                }
            });
        }));
    }

    pub(super) fn render_write_error_banner(
        &self,
        banner: BridgeErrorBanner,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        div()
            .id("write-bridge-error-banner")
            .w_full()
            .min_w(px(0.))
            .px(px(16.))
            .py(px(8.))
            .bg(theme.bg_panel)
            .border_b_1()
            .border_color(theme.danger)
            .flex()
            .flex_wrap()
            .items_center()
            .justify_between()
            .gap(px(10.))
            .child(
                div()
                    .flex_1()
                    .min_w(px(220.))
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(8.))
                    .child(render_ui_icon(UiIcon::Warning, 14.0, theme.danger))
                    .child(
                        div()
                            .id("write-banner-message")
                            .role(Role::Status)
                            .aria_label(banner.message.clone())
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text_primary)
                            .child(SharedString::from(banner.message)),
                    )
                    .child(
                        div()
                            .id("write-banner-command")
                            .role(Role::Note)
                            .aria_label(format!("Command: {}", banner.command))
                            .px(px(6.))
                            .py(px(2.))
                            .rounded(px(4.))
                            .bg(theme.bg_sunken)
                            .border_1()
                            .border_color(theme.border_subtle)
                            .font_family(crate::ui::views::kit::MONO_FONT)
                            .text_size(px(11.))
                            .text_color(theme.text_muted)
                            .truncate()
                            .child(SharedString::from(format!("Command: {}", banner.command))),
                    ),
            )
            .child(
                div()
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .child(
                        div()
                            .id("write-banner-retry-btn")
                            .focusable()
                            .role(Role::Button)
                            .aria_label("Retry write")
                            .h(px(26.))
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
                                this.retry_failed_write(cx);
                            }))
                            .child(if self.write_in_flight {
                                "Retrying…"
                            } else {
                                "Retry"
                            }),
                    )
                    .child(
                        div()
                            .id("write-banner-settings-btn")
                            .focusable()
                            .role(Role::Button)
                            .aria_label("Open Settings")
                            .h(px(26.))
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
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.open_settings_modal(window, cx);
                            }))
                            .child("Settings"),
                    )
                    .child(
                        div()
                            .id("write-banner-dismiss-btn")
                            .focusable()
                            .role(Role::Button)
                            .aria_label("Dismiss error")
                            .w(px(26.))
                            .h(px(26.))
                            .rounded(px(6.))
                            .cursor_pointer()
                            .hover(move |s| s.bg(theme.bg_elevated))
                            .flex()
                            .items_center()
                            .justify_center()
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.write_bridge_error = None;
                                cx.notify();
                            }))
                            .child(render_ui_icon(UiIcon::Close, 13.0, theme.text_muted)),
                    ),
            )
            .into_any_element()
    }
}
