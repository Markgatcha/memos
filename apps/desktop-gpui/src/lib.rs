pub mod core;

#[cfg(any(feature = "cli", test))]
pub mod cli;

#[cfg(feature = "gui")]
pub mod telemetry;
#[cfg(feature = "gui")]
pub mod ui;

// The one place `unsafe` is allowed: Win32 FFI shims with SAFETY comments.
#[cfg(target_os = "windows")]
#[allow(unsafe_code)]
pub mod win32;
