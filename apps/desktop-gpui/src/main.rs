use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use memos_desktop::core::db::ReadOnlyStore;
use memos_desktop::core::harness;
use memos_desktop::core::settings::{AppSettings, resolve_db_path_with_settings};
use memos_desktop::telemetry::{self, StartupTimeline, TelemetryHandle};
use memos_desktop::ui::app::{LaunchOptions, launch_crash_dialog, launch_main_app, run_self_test};

#[derive(Default)]
struct CliArgs {
    db: Option<PathBuf>,
    startup_report: Option<PathBuf>,
    diagnostics: bool,
    crash_test: bool,
    crash_dialog: Option<PathBuf>,
    smoke_exit_after_first_frame: bool,
    self_test: bool,
    no_fun: bool,
    help: bool,
}

fn parse_args() -> CliArgs {
    let mut parsed = CliArgs::default();
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        let s = arg.to_string_lossy();
        if s == "--db" {
            if let Some(val) = args.next() {
                parsed.db = Some(PathBuf::from(val));
            }
        } else if let Some(val) = s.strip_prefix("--db=") {
            parsed.db = Some(PathBuf::from(val));
        } else if s == "--startup-report" {
            if let Some(val) = args.next() {
                parsed.startup_report = Some(PathBuf::from(val));
            }
        } else if let Some(val) = s.strip_prefix("--startup-report=") {
            parsed.startup_report = Some(PathBuf::from(val));
        } else if s == "--diagnostics" {
            parsed.diagnostics = true;
        } else if s == "--crash-test" {
            parsed.crash_test = true;
        } else if s == "--crash-dialog" {
            if let Some(val) = args.next() {
                parsed.crash_dialog = Some(PathBuf::from(val));
            }
        } else if s == "--smoke-exit-after-first-frame" {
            parsed.smoke_exit_after_first_frame = true;
        } else if s == "--self-test" {
            parsed.self_test = true;
        } else if s == "--no-fun" {
            parsed.no_fun = true;
        } else if s == "--help" || s == "-h" {
            parsed.help = true;
        }
    }
    parsed
}

fn main() {
    let started_at = Instant::now();
    let cli = parse_args();
    let timeline = StartupTimeline::new(started_at, cli.startup_report);

    if cli.help {
        println!(
            "MemOS Desktop v{} (read-only GPUI viewer)\n\
             Usage: memos-desktop [--db <path>] [--startup-report <path>] [--diagnostics] [--self-test] [--no-fun] [--help]\n\
             Env:   MEMOS_DB, MEMOS_DESKTOP_HOME, MEMOS_DESKTOP_SENTRY_DSN",
            telemetry::APP_VERSION
        );
        return;
    }

    let settings_start = Instant::now();
    let settings = AppSettings::load();
    let resolved_db = resolve_db_path_with_settings(cli.db.as_deref(), &settings);
    timeline.record_span("settings", settings_start, Instant::now());

    #[cfg(debug_assertions)]
    if cli.crash_test {
        telemetry::run_crash_test(&settings);
    }

    #[cfg(not(debug_assertions))]
    if cli.crash_test {
        eprintln!("--crash-test is only available in debug builds");
        std::process::exit(2);
    }

    let telemetry_start = Instant::now();
    let telemetry = Arc::new(TelemetryHandle::init(&settings));
    let telemetry_end = Instant::now();
    timeline.record_span("telemetry_init", telemetry_start, telemetry_end);
    timeline.mark_tracing_ready();

    if cli.diagnostics {
        let overview = ReadOnlyStore::open(&resolved_db.path)
            .ok()
            .and_then(|s| s.load_overview().ok());
        let harnesses = harness::detect_all();
        let out = telemetry::build_diagnostics_text(
            &resolved_db,
            overview.as_ref(),
            &settings,
            &telemetry::log_dir(),
            &harnesses,
        );
        println!("{out}");
        return;
    }

    if cli.self_test {
        if let Err(err) = run_self_test(resolved_db, settings, telemetry, timeline) {
            eprintln!("self-test failed: {err}");
            std::process::exit(1);
        }
        return;
    }

    if let Some(report_path) = cli.crash_dialog {
        launch_crash_dialog(report_path, resolved_db, settings, telemetry);
        return;
    }

    launch_main_app(
        resolved_db,
        settings,
        telemetry,
        timeline,
        LaunchOptions {
            smoke_exit_after_first_frame: cli.smoke_exit_after_first_frame,
            no_fun: cli.no_fun,
        },
    );
}
