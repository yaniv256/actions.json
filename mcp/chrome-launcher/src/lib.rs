//! chrome-launcher: a cross-platform library to launch and drive a real Chrome for the
//! actions.json MCP — open a browser, self-install our unpacked extension, and take control
//! of a tab, all with no human clicks.
//!
//! The public surface mirrors the tools the actions.json MCP exposes: `chrome_endpoint`,
//! `chrome_kill`, `load_extension`, `start_extension_session`, `claim_tab`. Each is served by
//! a platform [`backend::LaunchBackend`]. The WSL->Windows backend is implemented (U3);
//! macOS and native-Linux are documented seams (see [`backend`]).
//!
//! Ported from the Python `chrome_launcher.py` + Windows node helpers (plan
//! docs/plans/2026-07-08-001-feat-rust-chrome-launcher-crate-plan.md).

pub mod backend;
pub mod claim;
pub mod session;
pub mod wsl_windows;

pub use backend::{
    BackendFuture, ChromeEndpoint, ClaimResult, LaunchBackend, LauncherError, SessionResult,
};
pub use wsl_windows::WslWindowsBackend;

/// Crate version marker.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
