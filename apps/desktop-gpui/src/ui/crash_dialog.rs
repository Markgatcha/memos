//! Crash-report window: a sanitized local report plus copyable diagnostics.

use std::path::PathBuf;
use std::sync::Arc;

use gpui::{
    App, AppContext, Bounds, ClipboardItem, Context, FontWeight, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, TitlebarOptions,
    Window, WindowBounds, WindowOptions, div, prelude::FluentBuilder, px, size,
};

use crate::core::settings::{AppSettings, ResolvedDbPath};
use crate::telemetry::{self, TelemetryHandle};
use crate::ui::app::register_app_key_bindings;
use crate::ui::views::ThemePalette;

pub fn launch_crash_dialog(
    report_path: PathBuf,
    resolved_db: ResolvedDbPath,
    settings: AppSettings,
    telemetry: Arc<TelemetryHandle>,
) {
    gpui_platform::application().run(move |cx: &mut App| {
        register_app_key_bindings(cx);
        cx.on_window_closed(|cx, _window_id| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();

        let bounds = Bounds::centered(None, size(px(680.), px(500.)), cx);
        let window_opts = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            focus: true,
            titlebar: Some(TitlebarOptions {
                title: Some("MemOS — Crash report".into()),
                ..Default::default()
            }),
            ..Default::default()
        };

        let _ = cx.open_window(window_opts, move |_window, cx| {
            cx.new(|cx| CrashDialogView::new(report_path, resolved_db, settings, telemetry, cx))
        });
    });
}

struct CrashDialogView {
    report_path: PathBuf,
    report_preview: String,
    resolved_db: ResolvedDbPath,
    settings: AppSettings,
    _telemetry: Arc<TelemetryHandle>,
    theme: ThemePalette,
    copied: bool,
}

impl CrashDialogView {
    fn new(
        report_path: PathBuf,
        resolved_db: ResolvedDbPath,
        settings: AppSettings,
        telemetry: Arc<TelemetryHandle>,
        cx: &mut Context<Self>,
    ) -> Self {
        let theme = ThemePalette::for_mode(settings.theme);
        let path_clone = report_path.clone();
        cx.spawn(async move |this, cx| {
            let text = cx
                .background_executor()
                .spawn(async move {
                    std::fs::read_to_string(&path_clone)
                        .unwrap_or_else(|e| format!("Unable to read local crash report: {e}"))
                })
                .await;
            let _ = this.update(cx, |view, cx| {
                view.report_preview = text;
                cx.notify();
            });
        })
        .detach();

        Self {
            report_path,
            report_preview: "Loading sanitized local crash report…".to_string(),
            resolved_db,
            settings,
            _telemetry: telemetry,
            theme,
            copied: false,
        }
    }
}

impl Render for CrashDialogView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let report_path = self.report_path.clone();
        let resolved_db = self.resolved_db.clone();
        let settings = self.settings.clone();

        div()
            .w_full()
            .h_full()
            .p(px(18.))
            .bg(theme.bg_app)
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
                            .text_base()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.danger)
                            .child("MemOS Desktop encountered an unexpected error"),
                    )
                    .when(self.copied, |el| {
                        el.child(
                            div()
                                .text_size(px(12.))
                                .text_color(theme.success)
                                .child("Diagnostics copied"),
                        )
                    }),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(theme.text_muted)
                    .child(SharedString::from(format!(
                        "Sanitized local report saved at: {}",
                        self.report_path.display()
                    ))),
            )
            .child(
                div()
                    .id("crash-report-body")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p(px(10.))
                    .rounded(px(6.))
                    .bg(theme.bg_panel)
                    .border_1()
                    .border_color(theme.border)
                    .text_xs()
                    .text_color(theme.text_secondary)
                    .child(SharedString::from(self.report_preview.clone())),
            )
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(8.))
                    .child(
                        div()
                            .id("crash-open-logs")
                            .px(px(12.))
                            .py(px(6.))
                            .rounded(px(6.))
                            .cursor_pointer()
                            .bg(theme.bg_elevated)
                            .border_1()
                            .border_color(theme.border)
                            .hover(|s| s.bg(theme.bg_hover))
                            .text_xs()
                            .text_color(theme.text_primary)
                            .on_click(cx.listener(|_, _, _, cx| {
                                let dir = telemetry::log_dir();
                                cx.background_executor()
                                    .spawn(async move {
                                        let _ = std::fs::create_dir_all(&dir);
                                        let _ = open::that(dir);
                                    })
                                    .detach();
                            }))
                            .child("Open logs"),
                    )
                    .child(
                        div()
                            .id("crash-copy-diag")
                            .px(px(12.))
                            .py(px(6.))
                            .rounded(px(6.))
                            .cursor_pointer()
                            .bg(theme.accent_soft)
                            .hover(|s| s.bg(theme.bg_hover))
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.accent_text)
                            .on_click(cx.listener(move |_this, _, _, cx| {
                                let rdb = resolved_db.clone();
                                let st = settings.clone();
                                let rpath = report_path.clone();
                                cx.spawn(async move |weak, cx| {
                                    let diag = cx
                                        .background_executor()
                                        .spawn(async move {
                                            let log_directory = telemetry::log_dir();
                                            let base = telemetry::build_diagnostics_text(
                                                &rdb,
                                                None,
                                                &st,
                                                &log_directory,
                                                &[],
                                            );
                                            format!(
                                                "{base}\nlast_crash_report: {}",
                                                rpath.display()
                                            )
                                        })
                                        .await;
                                    let _ = weak.update(cx, |v, cx| {
                                        cx.write_to_clipboard(ClipboardItem::new_string(diag));
                                        v.copied = true;
                                        cx.notify();
                                    });
                                })
                                .detach();
                            }))
                            .child("Copy diagnostics"),
                    )
                    .child(
                        div()
                            .id("crash-close")
                            .px(px(12.))
                            .py(px(6.))
                            .rounded(px(6.))
                            .cursor_pointer()
                            .bg(theme.bg_elevated)
                            .border_1()
                            .border_color(theme.border)
                            .text_xs()
                            .text_color(theme.text_secondary)
                            .on_click(cx.listener(|_, _, _, cx| cx.quit()))
                            .child("Close"),
                    ),
            )
    }
}
