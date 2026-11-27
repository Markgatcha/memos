//! Batch approve/reject for the Review queue.
//!
//! `memos_review` acts on one id at a time, so a batch is a sequence of
//! independent calls through the same writer session. Progress is shown per
//! item, failures are collected rather than aborting the run, and "Stop" takes
//! effect between items. Nothing here claims the batch is atomic.

use gpui::Context;

use super::MemOSApp;
use crate::core::write_bridge::ReviewInput;
use crate::ui::views::review::BatchProgress;

#[derive(Default)]
pub(super) struct ReviewBatchState {
    pub progress: Option<BatchProgress>,
    pub stop_requested: bool,
}

impl MemOSApp {
    pub(super) fn start_review_batch(
        &mut self,
        ids: Vec<String>,
        approve: bool,
        cx: &mut Context<Self>,
    ) {
        if !self.settings.write_mode {
            self.set_notice("Turn on editing to review", cx);
            return;
        }
        if ids.is_empty()
            || self
                .review_batch
                .progress
                .as_ref()
                .is_some_and(|p| !p.finished)
        {
            return;
        }
        let cmd = self.settings.effective_writer_command().to_string();
        self.write_bridge.configure(&cmd, &self.resolved_db.path);
        self.review_batch.stop_requested = false;
        self.review_batch.progress = Some(BatchProgress {
            approve,
            total: ids.len(),
            ..Default::default()
        });
        self.sync_batch_progress(cx);

        let bridge = self.write_bridge.clone();
        self._review_task = Some(cx.spawn(async move |this, cx| {
            for id in ids {
                let stop = this
                    .update(cx, |app, _| app.review_batch.stop_requested)
                    .unwrap_or(true);
                if stop {
                    break;
                }
                let b = bridge.clone();
                let target = id.clone();
                let res = cx
                    .background_executor()
                    .spawn(async move {
                        b.review(ReviewInput {
                            action: if approve { "approve" } else { "reject" }.to_string(),
                            id: Some(target),
                            namespace: None,
                        })
                    })
                    .await;
                let capability_missing = res.as_ref().is_err_and(|e| e.is_capability_missing());
                let alive = this.update(cx, |app, cx| {
                    if let Some(p) = app.review_batch.progress.as_mut() {
                        p.done += 1;
                        if let Err(err) = &res {
                            p.failed.push((id.clone(), err.ui_summary()));
                        }
                    }
                    // A missing capability will fail every remaining item the same way.
                    if capability_missing {
                        app.review_batch.stop_requested = true;
                    }
                    app.sync_batch_progress(cx);
                });
                if alive.is_err() {
                    return;
                }
            }
            let _ = this.update(cx, |app, cx| {
                let stopped = app.review_batch.stop_requested;
                if let Some(p) = app.review_batch.progress.as_mut() {
                    p.finished = true;
                    p.stopped = stopped || p.done < p.total;
                }
                let summary = app
                    .review_batch
                    .progress
                    .as_ref()
                    .map(|p| p.summary())
                    .unwrap_or_default();
                app.sync_batch_progress(cx);
                app.set_notice(summary, cx);
                app.reload_store_after_write(None, cx);
                app.spawn_review_list_load(cx);
            });
        }));
    }

    pub(super) fn stop_review_batch(&mut self, cx: &mut Context<Self>) {
        if self
            .review_batch
            .progress
            .as_ref()
            .is_some_and(|p| !p.finished)
        {
            self.review_batch.stop_requested = true;
            self.set_notice("Stopping after the current memory…", cx);
        }
    }

    fn sync_batch_progress(&mut self, cx: &mut Context<Self>) {
        let progress = self.review_batch.progress.clone();
        self.review_view
            .update(cx, |r, cx| r.set_batch_progress(progress, cx));
    }
}
