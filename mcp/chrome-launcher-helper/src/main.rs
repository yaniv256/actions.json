//! chrome-launcher-helper — native-Windows pipe owner for the chrome-launcher crate.
//!
//! Direct port of `windows/pipe_session.mjs` (+ `load_unpacked.mjs`). Chrome's
//! `--remote-debugging-pipe` transport speaks **NUL-terminated JSON** over a pair of inherited
//! fds/handles that only a native process (same OS as Chrome) can own — a WSL/Linux process
//! cannot. So this helper is cross-compiled `x86_64-pc-windows-gnu` and spawned by the WSL
//! bridge. It: launches a headed pipe-Chrome, `Extensions.loadUnpacked`s our extension, verifies
//! the manifest name, then runs a WebSocket relay on `127.0.0.1:9222` — clients' CDP frames go
//! INTO the pipe; the pipe's events/responses fan OUT to clients.
//!
//! Usage: `chrome-launcher-helper <chromeExe> <userDataDir> <extPath> [wsPort]`
//! Emits one JSON line when ready: `{"ok":true,"id","name","version","wsPort"}` then stays alive
//! relaying until Chrome exits or it is killed. On failure: `{"ok":false,"error",...}`.
//!
//! The **framing codec** and identity check are cross-platform and unit-tested here. The actual
//! pipe-Chrome spawn (owning fds 3/4 / Windows HANDLEs) is `#[cfg(windows)]` and exercised on
//! the Windows target (U8/U9).

mod frame;
mod identity;

pub use frame::{split_nul_frames, FrameBuffer, SETUP_BASE};
pub use identity::{read_manifest_identity, EXPECTED_NAME};

fn main() {
    #[cfg(windows)]
    {
        windows_run::main();
    }
    #[cfg(not(windows))]
    {
        // The pipe owner only functions on Windows (it must own Chrome's pipe handles).
        // On other targets the binary still builds so the framing codec can be unit-tested,
        // but running it is a no-op that reports the constraint.
        eprintln!(
            "{}",
            serde_json::json!({
                "ok": false,
                "error": "chrome-launcher-helper runs only on Windows (owns Chrome --remote-debugging-pipe handles)"
            })
        );
        std::process::exit(2);
    }
}

#[cfg(windows)]
mod windows_run {
    //! The Windows-only pipe-owner + relay. Ported 1:1 from pipe_session.mjs; compiled only for
    //! the Windows target where inheritable pipe handles can be owned.
    use crate::frame::{FrameBuffer, SETUP_BASE};
    use crate::identity::{read_manifest_identity, EXPECTED_NAME};
    use futures_util::{SinkExt, StreamExt};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::mpsc;
    use tokio_tungstenite::tungstenite::Message;

    pub fn main() {
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        rt.block_on(async {
            if let Err(e) = run().await {
                println!("{}", serde_json::json!({ "ok": false, "error": e.to_string() }));
                std::process::exit(1);
            }
        });
    }

    /// Free a TCP port held by a stale process (a prior helper/relay). Windows: find the
    /// LISTENING PID via netstat and taskkill it. Best-effort — errors are non-fatal (the
    /// subsequent bind reports a clear error if the port is still taken).
    async fn free_tcp_port(port: u16) {
        let out = match tokio::process::Command::new("netstat").args(["-ano"]).output().await {
            Ok(o) => o,
            Err(_) => return,
        };
        let text = String::from_utf8_lossy(&out.stdout);
        let needle = format!(":{port} ");
        for line in text.lines() {
            if line.contains(&needle) && line.contains("LISTENING") {
                if let Some(pid) = line.split_whitespace().last() {
                    if pid.chars().all(|c| c.is_ascii_digit()) {
                        let _ = tokio::process::Command::new("taskkill")
                            .args(["/F", "/PID", pid])
                            .output()
                            .await;
                    }
                }
            }
        }
    }

    async fn run() -> Result<(), Box<dyn std::error::Error>> {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let chrome_exe = args.first().ok_or("usage: <chromeExe> <userDataDir> <extPath> [wsPort]")?;
        let user_data_dir = args.get(1).ok_or("missing userDataDir")?;
        let ext_path = args.get(2).ok_or("missing extPath")?;
        let ws_port: u16 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(9222);

        // 1) Spawn a headed pipe-Chrome. The pipe handles are wired to fds 3 (write) / 4 (read)
        //    on the child; we own the other ends. windows_spawn returns those owned ends.
        let (mut pipe_write, mut pipe_read, _child) =
            windows_spawn::spawn_pipe_chrome(chrome_exe, user_data_dir).await?;

        // 2) NUL-framed pipe reader: setup responses (id >= SETUP_BASE) resolve our pending
        //    calls; everything else fans out to WS clients.
        let clients: Arc<Mutex<Vec<mpsc::UnboundedSender<String>>>> = Arc::new(Mutex::new(Vec::new()));
        let pending: Arc<Mutex<HashMap<i64, tokio::sync::oneshot::Sender<serde_json::Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let clients_r = clients.clone();
        let pending_r = pending.clone();
        tokio::spawn(async move {
            let mut fb = FrameBuffer::new();
            let mut chunk = [0u8; 8192];
            loop {
                let n = match pipe_read.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                for raw in fb.push(&chunk[..n]) {
                    let d: serde_json::Value = match serde_json::from_str(&raw) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let id = d.get("id").and_then(|v| v.as_i64());
                    if let Some(id) = id {
                        if id >= SETUP_BASE {
                            if let Some(tx) = pending_r.lock().unwrap().remove(&id) {
                                let _ = tx.send(d);
                                continue;
                            }
                        }
                    }
                    let mut guard = clients_r.lock().unwrap();
                    guard.retain(|c| c.send(raw.clone()).is_ok());
                }
            }
        });

        // 3) loadUnpacked our extension, verify identity.
        let mut setup_id: i64 = 0;
        let ext_win = ext_path.clone();
        let load = {
            let (tx, rx) = tokio::sync::oneshot::channel();
            setup_id += 1;
            let id = SETUP_BASE + setup_id;
            pending.lock().unwrap().insert(id, tx);
            let msg = serde_json::json!({ "id": id, "method": "Extensions.loadUnpacked", "params": { "path": ext_win } });
            pipe_write.write_all(format!("{msg}\0").as_bytes()).await?;
            pipe_write.flush().await?;
            tokio::time::timeout(std::time::Duration::from_secs(30), rx).await??
        };
        if load.get("error").is_some() {
            return Err(format!("loadUnpacked failed: {}", load["error"]).into());
        }
        let ext_id = load["result"]["id"].as_str().unwrap_or("").to_string();
        let (name, version) = read_manifest_identity(ext_path);
        if name.as_deref() != Some(EXPECTED_NAME) {
            return Err(format!("manifest name mismatch: expected {EXPECTED_NAME:?} got {name:?}").into());
        }

        // 4) WS relay on 127.0.0.1:wsPort. Client frames -> pipe; pipe frames -> clients (above).
        // A stale helper/relay from a prior run can still hold this fixed port (EADDRINUSE / os
        // error 10048) — the incident this guard closes (investigations/rust-helper-cdp-pipe-oneway.md).
        // Free any prior holder, then bind with a clear, actionable error if it's still taken.
        free_tcp_port(ws_port).await;
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", ws_port)).await {
            Ok(l) => l,
            Err(e) => {
                return Err(format!(
                    "relay port {ws_port} in use ({e}); a prior chrome-launcher-helper may still be \
                     running — kill it (taskkill /F /IM chrome-launcher-helper.exe) or free the port"
                )
                .into())
            }
        };
        let pipe_write = Arc::new(tokio::sync::Mutex::new(pipe_write));
        println!(
            "{}",
            serde_json::json!({ "ok": true, "id": ext_id, "name": name, "version": version, "wsPort": ws_port })
        );

        loop {
            // A single bad/non-WS connection (a health probe, a port scan, a client that speaks
            // raw CDP without the WebSocket upgrade) must NEVER take down the session. Both the
            // TCP accept and the WS handshake are per-connection recoverable: log and continue,
            // never `?` out of run() (that kills the helper AND its child Chrome — bug #4, the
            // "why did the browser vanish" incident).
            let stream = match listener.accept().await {
                Ok((s, _)) => s,
                Err(_) => continue,
            };
            let ws = match tokio_tungstenite::accept_async(stream).await {
                Ok(ws) => ws,
                Err(_) => continue, // bad handshake — drop this client, keep serving
            };
            let (mut ws_tx, mut ws_rx) = ws.split();
            let (tx, mut rx) = mpsc::unbounded_channel::<String>();
            clients.lock().unwrap().push(tx);
            let pw = pipe_write.clone();
            // pipe -> this client
            tokio::spawn(async move {
                while let Some(frame) = rx.recv().await {
                    if ws_tx.send(Message::Text(frame)).await.is_err() {
                        break;
                    }
                }
            });
            // this client -> pipe
            tokio::spawn(async move {
                while let Some(Ok(msg)) = ws_rx.next().await {
                    if let Message::Text(t) = msg {
                        let mut w = pw.lock().await;
                        let _ = w.write_all(format!("{t}\0").as_bytes()).await;
                    }
                }
            });
        }
    }

    /// Windows-specific spawn of Chrome with `--remote-debugging-pipe`, owning the pipe ends.
    /// Chrome's pipe protocol: the parent hands the child two INHERITABLE anonymous-pipe ends —
    /// fd 3 = the channel Chrome READS commands from (so WE write it), fd 4 = the channel Chrome
    /// WRITES responses/events to (so WE read it). Node did this with
    /// `stdio: ['inherit','inherit','inherit','pipe','pipe']` (indices 3,4). On Windows we
    /// CreatePipe two pipes with inheritable handles, mark only the child's ends inheritable,
    /// and pass `handle-inheritance`; the child receives them as fds 3/4 via the CRT.
    mod windows_spawn {
        use std::os::windows::io::{FromRawHandle, OwnedHandle};
        use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
        use windows_sys::Win32::System::Pipes::CreatePipe;

        /// Async wrappers over the owned pipe ends (via tokio's blocking-file bridge over the
        /// raw handles). PipeWrite is our end of Chrome's fd-3 (we write commands); PipeRead is
        /// our end of Chrome's fd-4 (we read responses/events).
        pub type PipeWrite = tokio::fs::File;
        pub type PipeRead = tokio::fs::File;

        /// Create one anonymous pipe; returns (read_end, write_end) as OwnedHandles. `inherit`
        /// marks the returned handles inheritable at creation (we then clear inheritance on the
        /// end WE keep, so only the child's end is inherited).
        fn make_pipe() -> std::io::Result<(OwnedHandle, OwnedHandle)> {
            let mut read: HANDLE = INVALID_HANDLE_VALUE;
            let mut write: HANDLE = INVALID_HANDLE_VALUE;
            let mut sa = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: std::ptr::null_mut(),
                bInheritHandle: 1, // inheritable; caller clears it on the kept end
            };
            let ok = unsafe { CreatePipe(&mut read, &mut write, &mut sa, 0) };
            if ok == 0 {
                return Err(std::io::Error::last_os_error());
            }
            // SAFETY: CreatePipe returned valid, owned handles.
            Ok(unsafe {
                (
                    OwnedHandle::from_raw_handle(read as *mut _),
                    OwnedHandle::from_raw_handle(write as *mut _),
                )
            })
        }

        /// Clear the inheritable flag on a handle we keep, so the child does not inherit a stray
        /// copy (only the HANDLE_LIST-named ends should cross into the child).
        fn clear_inherit(h: HANDLE) -> std::io::Result<()> {
            use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};
            let ok = unsafe { SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0) };
            if ok == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        }

        /// A spawned Chrome process handle (raw CreateProcess result). We only need to keep it
        /// alive and know when it exits; not a tokio::process::Child (we made it ourselves).
        pub struct RawChild {
            process: HANDLE,
            thread: HANDLE,
        }
        unsafe impl Send for RawChild {}
        impl Drop for RawChild {
            fn drop(&mut self) {
                use windows_sys::Win32::Foundation::CloseHandle;
                unsafe {
                    if !self.process.is_null() { CloseHandle(self.process); }
                    if !self.thread.is_null() { CloseHandle(self.thread); }
                }
            }
        }

        /// Spawn chrome.exe --remote-debugging-pipe, wiring the two pipes to the child's fds 3/4.
        /// Returns (our-write-to-chrome, our-read-from-chrome, child).
        ///
        /// The real Windows mechanism: CreateProcessW with EXTENDED_STARTUPINFO_PRESENT and a
        /// STARTUPINFOEX carrying (1) a PROC_THREAD_ATTRIBUTE_HANDLE_LIST naming exactly the two
        /// child pipe handles (so ONLY they are inherited), and (2) a CRT lpReserved2 fd-table
        /// that maps those handles to fds 3 and 4 — which is how the child's C runtime exposes
        /// them as file descriptors, exactly what Chrome's --remote-debugging-pipe reads. This
        /// mirrors node's `stdio: [inherit,inherit,inherit, pipe(3), pipe(4)]`.
        pub async fn spawn_pipe_chrome(
            chrome_exe: &str,
            user_data_dir: &str,
        ) -> Result<(PipeWrite, PipeRead, RawChild), Box<dyn std::error::Error>> {
            // fd 3: Chrome reads -> we own the WRITE end. fd 4: Chrome writes -> we own the READ end.
            let (child_fd3_read, our_write) = make_pipe()?;
            let (our_read, child_fd4_write) = make_pipe()?;

            // CRITICAL: CreatePipe made BOTH ends of each pipe inheritable. The child must inherit
            // ONLY the two ends named in the HANDLE_LIST; our kept ends must be non-inheritable, or
            // the child inherits stray copies (leaked fds, and the HANDLE_LIST restriction becomes
            // undefined). Clear HANDLE_FLAG_INHERIT on the two ends we keep. (libuv did this for
            // us in the node version.)
            clear_inherit(our_write.as_raw_handle() as HANDLE)?;
            clear_inherit(our_read.as_raw_handle() as HANDLE)?;

            let child = raw_create::spawn_with_inherited_pipes(
                chrome_exe,
                user_data_dir,
                child_fd3_read.as_raw_handle() as HANDLE,
                child_fd4_write.as_raw_handle() as HANDLE,
            )?;

            let our_write = tokio::fs::File::from_std(unsafe {
                std::fs::File::from_raw_handle(OwnedHandle::into_raw_handle(our_write))
            });
            let our_read = tokio::fs::File::from_std(unsafe {
                std::fs::File::from_raw_handle(OwnedHandle::into_raw_handle(our_read))
            });
            drop(child_fd3_read);
            drop(child_fd4_write);
            Ok((our_write, our_read, child))
        }

        use std::os::windows::io::{AsRawHandle, IntoRawHandle};

        mod raw_create {
            use super::RawChild;
            use std::ffi::OsStr;
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Foundation::{HANDLE, TRUE};
            use windows_sys::Win32::System::Threading::{
                CreateProcessW, InitializeProcThreadAttributeList, UpdateProcThreadAttribute,
                DeleteProcThreadAttributeList, PROCESS_INFORMATION, STARTUPINFOEXW,
                EXTENDED_STARTUPINFO_PRESENT, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            };

            fn to_wide(s: &str) -> Vec<u16> {
                OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
            }

            /// Build the CRT lpReserved2 inherited-fd block mapping fds 0..=4 for the child.
            /// Layout (documented MSVCRT format): [i32 count][u8 flags*count][HANDLE handles*count].
            /// FOPEN|FDEV flags on each; fds 0-2 are the std handles, 3=pipe read, 4=pipe write.
            fn build_crt_fd_block(
                std_in: HANDLE,
                std_out: HANDLE,
                std_err: HANDLE,
                fd3: HANDLE,
                fd4: HANDLE,
            ) -> Vec<u8> {
                const FOPEN: u8 = 0x01;
                const FDEV: u8 = 0x40;
                let handles = [std_in, std_out, std_err, fd3, fd4];
                let count = handles.len() as i32;
                let mut block = Vec::new();
                block.extend_from_slice(&count.to_ne_bytes());
                for _ in 0..handles.len() {
                    block.push(FOPEN | FDEV);
                }
                for h in handles {
                    block.extend_from_slice(&(h as usize).to_ne_bytes());
                }
                block
            }

            pub fn spawn_with_inherited_pipes(
                chrome_exe: &str,
                user_data_dir: &str,
                fd3_read: HANDLE,
                fd4_write: HANDLE,
            ) -> Result<RawChild, Box<dyn std::error::Error>> {
                use windows_sys::Win32::System::Console::{
                    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
                };
                let (h_in, h_out, h_err) = unsafe {
                    (
                        GetStdHandle(STD_INPUT_HANDLE),
                        GetStdHandle(STD_OUTPUT_HANDLE),
                        GetStdHandle(STD_ERROR_HANDLE),
                    )
                };

                // Command line: "chrome.exe" --remote-debugging-pipe ... about:blank
                let cmdline = format!(
                    "\"{chrome_exe}\" --remote-debugging-pipe --enable-unsafe-extension-debugging \
                     --user-data-dir=\"{user_data_dir}\" --no-first-run --no-default-browser-check about:blank"
                );
                let mut cmdline_w = to_wide(&cmdline);

                // Inherit exactly the two pipe handles via PROC_THREAD_ATTRIBUTE_HANDLE_LIST.
                let inherit_handles: [HANDLE; 2] = [fd3_read, fd4_write];
                let mut attr_size: usize = 0;
                unsafe {
                    InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut attr_size);
                }
                let mut attr_buf: Vec<u8> = vec![0u8; attr_size];
                let attr_list = attr_buf.as_mut_ptr() as *mut _;
                unsafe {
                    if InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_size) == 0 {
                        return Err(format!("InitializeProcThreadAttributeList: {}", std::io::Error::last_os_error()).into());
                    }
                    if UpdateProcThreadAttribute(
                        attr_list,
                        0,
                        PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                        inherit_handles.as_ptr() as *const _,
                        std::mem::size_of_val(&inherit_handles),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                    ) == 0 {
                        return Err(format!("UpdateProcThreadAttribute: {}", std::io::Error::last_os_error()).into());
                    }
                }

                // CRT fd block exposes the handles to the child as fds 3/4.
                let mut fd_block = build_crt_fd_block(h_in, h_out, h_err, fd3_read, fd4_write);

                let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
                si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
                si.lpAttributeList = attr_list;
                si.StartupInfo.cbReserved2 = fd_block.len() as u16;
                si.StartupInfo.lpReserved2 = fd_block.as_mut_ptr();
                // Also pass std handles explicitly so the child's 0/1/2 are sane.
                use windows_sys::Win32::System::Threading::STARTF_USESTDHANDLES;
                si.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
                si.StartupInfo.hStdInput = h_in;
                si.StartupInfo.hStdOutput = h_out;
                si.StartupInfo.hStdError = h_err;

                let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
                let ok = unsafe {
                    CreateProcessW(
                        std::ptr::null(),
                        cmdline_w.as_mut_ptr(),
                        std::ptr::null(),
                        std::ptr::null(),
                        TRUE, // bInheritHandles: required for the handle list to take effect
                        EXTENDED_STARTUPINFO_PRESENT,
                        std::ptr::null(),
                        std::ptr::null(),
                        &mut si as *mut _ as *mut _,
                        &mut pi,
                    )
                };
                unsafe { DeleteProcThreadAttributeList(attr_list); }
                if ok == 0 {
                    return Err(format!("CreateProcessW: {}", std::io::Error::last_os_error()).into());
                }
                Ok(RawChild { process: pi.hProcess, thread: pi.hThread })
            }
        }
    }
}
