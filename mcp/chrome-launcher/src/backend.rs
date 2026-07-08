//! Platform-backend abstraction for the chrome launcher.
//!
//! Every OS-specific way of launching + driving Chrome implements [`LaunchBackend`]. The
//! WSL->Windows backend is implemented ([`crate::wsl_windows`], added in U3); macOS and native
//! Linux are documented seams — see [`MacBackend`] / [`LinuxBackend`]. The trait methods mirror
//! the tools the actions.json MCP exposes, and the result types serialize to the same JSON
//! shape the Python MCP returns, so the bridge (U7) is a drop-in.

use serde::{Deserialize, Serialize};
use std::future::Future;
use std::pin::Pin;

/// Errors any backend can raise. Serializes into the `{ok:false, stage, error}` shape the
/// Python MCP used, so tool callers see a consistent failure envelope.
#[derive(Debug, thiserror::Error)]
pub enum LauncherError {
    /// A required external tool / path was missing (schtasks, node, Chrome, wslpath).
    #[error("missing dependency: {0}")]
    MissingDependency(String),
    /// Spawning or driving a subprocess (schtasks, the helper, powershell) failed.
    #[error("process error at stage {stage}: {source}")]
    Process {
        stage: &'static str,
        #[source]
        source: std::io::Error,
    },
    /// Chrome/CDP was reachable but returned something unexpected.
    #[error("chrome/CDP error at stage {stage}: {message}")]
    Cdp { stage: &'static str, message: String },
    /// The operation timed out (e.g. no ready line from the pipe helper).
    #[error("timeout at stage {stage}: {message}")]
    Timeout { stage: &'static str, message: String },
    /// This backend does not implement the operation (e.g. an unfinished macOS seam).
    #[error("unsupported on this platform: {0}")]
    Unsupported(&'static str),
}

/// The CDP endpoint of a running Chrome, plus whether it is visible to the user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChromeEndpoint {
    /// The `ws://.../devtools/browser/<id>` URL a CDP client drives.
    pub web_socket_debugger_url: String,
    /// The reported browser version string (e.g. "Chrome/150.0...").
    pub browser: String,
    /// Whether the window renders in the user's interactive session (vs. an invisible session).
    pub visible: bool,
}

/// Result of a `start_extension_session` — a driveable Chrome that already has our extension.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionResult {
    /// The CDP WebSocket URL that drives the extension-loaded instance.
    pub web_socket_debugger_url: String,
    /// The loaded extension's id (as Chrome assigned it).
    pub id: String,
    /// The extension manifest name — identity is verified by NAME, never id prefix.
    pub name: String,
    /// The extension version from the manifest.
    pub version: String,
    /// How the browser was launched: "interactive (schtasks /IT)" or a fallback.
    pub launch: String,
}

/// Result of a `claim_tab` — the extension took control of a tab and a runtime registered.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaimResult {
    /// The tab that was claimed.
    pub tab_id: i64,
    /// The runtime key the bridge registered (e.g. "chrome-tab:<id>").
    pub runtime_key: String,
    /// The authorization id the claim produced.
    pub authorization_id: String,
}

/// A boxed, `Send` future — the return shape trait methods use so the trait stays object-safe
/// and usable from the async bridge without `async_trait`.
pub type BackendFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, LauncherError>> + Send + 'a>>;

/// One platform's way to launch and drive Chrome. Method set mirrors the MCP tool surface.
pub trait LaunchBackend: Send + Sync {
    /// Launch (or reuse) a **visible** Chrome with remote debugging and return its CDP endpoint.
    fn chrome_endpoint(&self) -> BackendFuture<'_, ChromeEndpoint>;

    /// Stop all Chrome processes this backend controls.
    fn chrome_kill(&self) -> BackendFuture<'_, ()>;

    /// Install our unpacked extension into a profile (persists to Secure Preferences).
    /// `extension_dir` is a path in this platform's namespace; `user_data_dir` the profile.
    fn load_extension<'a>(
        &'a self,
        extension_dir: &'a str,
        user_data_dir: &'a str,
    ) -> BackendFuture<'a, SessionResult>;

    /// Launch a persistent, **visible** Chrome that already has our extension loaded and is
    /// driveable — the self-install + drive-same-instance flow, no human clicks.
    fn start_extension_session<'a>(
        &'a self,
        extension_dir: &'a str,
        user_data_dir: &'a str,
    ) -> BackendFuture<'a, SessionResult>;

    /// Drive the extension's headless authorize path so a runtime registers on the bridge.
    fn claim_tab<'a>(
        &'a self,
        cdp_ws_url: &'a str,
        target_url_contains: &'a str,
        bridge_url: &'a str,
    ) -> BackendFuture<'a, ClaimResult>;
}

// ---- Seams: not implemented in this plan (WSL->Windows first). ----

/// macOS backend — **seam, not implemented in plan 2026-07-08-001.**
///
/// Contract for whoever implements it: there is no WSL boundary, so the pipe owner runs
/// **in-process** — spawn Chrome with `--remote-debugging-pipe`, own the pipe fds directly (no
/// separate `.exe`), do `Extensions.loadUnpacked`, and relay CDP as needed. `chrome_endpoint`
/// launches a normal visible window; no `schtasks`/session-0 concern exists on macOS.
pub struct MacBackend;

/// Native-Linux backend — **seam, not implemented in plan 2026-07-08-001.**
///
/// Same contract as [`MacBackend`]: in-process pipe ownership, direct visible launch, no WSL
/// interop. Distinct from the WSL->Windows backend, which must cross into Windows.
pub struct LinuxBackend;

macro_rules! unsupported_backend {
    ($ty:ty, $label:literal) => {
        impl LaunchBackend for $ty {
            fn chrome_endpoint(&self) -> BackendFuture<'_, ChromeEndpoint> {
                Box::pin(async { Err(LauncherError::Unsupported($label)) })
            }
            fn chrome_kill(&self) -> BackendFuture<'_, ()> {
                Box::pin(async { Err(LauncherError::Unsupported($label)) })
            }
            fn load_extension<'a>(
                &'a self,
                _extension_dir: &'a str,
                _user_data_dir: &'a str,
            ) -> BackendFuture<'a, SessionResult> {
                Box::pin(async { Err(LauncherError::Unsupported($label)) })
            }
            fn start_extension_session<'a>(
                &'a self,
                _extension_dir: &'a str,
                _user_data_dir: &'a str,
            ) -> BackendFuture<'a, SessionResult> {
                Box::pin(async { Err(LauncherError::Unsupported($label)) })
            }
            fn claim_tab<'a>(
                &'a self,
                _cdp_ws_url: &'a str,
                _target_url_contains: &'a str,
                _bridge_url: &'a str,
            ) -> BackendFuture<'a, ClaimResult> {
                Box::pin(async { Err(LauncherError::Unsupported($label)) })
            }
        }
    };
}

unsupported_backend!(MacBackend, "macOS backend not yet implemented (plan 2026-07-08-001 seam)");
unsupported_backend!(LinuxBackend, "native-Linux backend not yet implemented (plan 2026-07-08-001 seam)");

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal mock backend proves the trait is object-safe and dispatchable.
    struct MockBackend;
    impl LaunchBackend for MockBackend {
        fn chrome_endpoint(&self) -> BackendFuture<'_, ChromeEndpoint> {
            Box::pin(async {
                Ok(ChromeEndpoint {
                    web_socket_debugger_url: "ws://127.0.0.1:9223/devtools/browser/mock".into(),
                    browser: "Chrome/mock".into(),
                    visible: true,
                })
            })
        }
        fn chrome_kill(&self) -> BackendFuture<'_, ()> {
            Box::pin(async { Ok(()) })
        }
        fn load_extension<'a>(
            &'a self,
            _e: &'a str,
            _u: &'a str,
        ) -> BackendFuture<'a, SessionResult> {
            Box::pin(async { Err(LauncherError::Unsupported("mock")) })
        }
        fn start_extension_session<'a>(
            &'a self,
            _e: &'a str,
            _u: &'a str,
        ) -> BackendFuture<'a, SessionResult> {
            Box::pin(async { Err(LauncherError::Unsupported("mock")) })
        }
        fn claim_tab<'a>(
            &'a self,
            _c: &'a str,
            _t: &'a str,
            _b: &'a str,
        ) -> BackendFuture<'a, ClaimResult> {
            Box::pin(async { Err(LauncherError::Unsupported("mock")) })
        }
    }

    #[tokio::test]
    async fn mock_backend_dispatches_as_trait_object() {
        let backend: Box<dyn LaunchBackend> = Box::new(MockBackend);
        let ep = backend.chrome_endpoint().await.expect("endpoint");
        assert!(ep.visible);
        assert!(ep.web_socket_debugger_url.starts_with("ws://"));
        backend.chrome_kill().await.expect("kill ok");
    }

    #[test]
    fn endpoint_serializes_to_camel_json() {
        // The bridge (U7) serializes results back to tool callers; lock the field shape.
        let ep = ChromeEndpoint {
            web_socket_debugger_url: "ws://x".into(),
            browser: "Chrome/1".into(),
            visible: true,
        };
        let v = serde_json::to_value(&ep).unwrap();
        assert_eq!(v["web_socket_debugger_url"], "ws://x");
        assert_eq!(v["visible"], true);
    }

    #[tokio::test]
    async fn seam_backends_report_unsupported() {
        let mac: Box<dyn LaunchBackend> = Box::new(MacBackend);
        let err = mac.chrome_endpoint().await.unwrap_err();
        assert!(matches!(err, LauncherError::Unsupported(_)));
    }
}
