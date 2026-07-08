# Building chrome-launcher-helper.exe (Windows target from Linux/WSL)

`chrome-launcher-helper` is the native-Windows pipe owner (see `src/main.rs`). It must run on
Windows because it owns Chrome's `--remote-debugging-pipe` handles. The `chrome-launcher` crate
(and the actions.json MCP that consumes it) run in WSL/Linux and **spawn** this `.exe`.

## Target

```
x86_64-pc-windows-gnu
```

The GNU (mingw) target is used so the build works from Linux without MSVC.

## Cross-compile (recommended: `cross`)

`cross` runs the build in a container with the mingw toolchain preinstalled — no host setup:

```bash
cargo install cross --git https://github.com/cross-rs/cross   # once
cross build -p chrome-launcher-helper --release --target x86_64-pc-windows-gnu
```

Output: `mcp/target/x86_64-pc-windows-gnu/release/chrome-launcher-helper.exe`.

## Cross-compile (host mingw, no container)

```bash
rustup target add x86_64-pc-windows-gnu
sudo apt-get install -y gcc-mingw-w64-x86-64            # Debian/Ubuntu/WSL
cargo build -p chrome-launcher-helper --release --target x86_64-pc-windows-gnu
```

## Smoke-check the artifact

```bash
# From WSL, the .exe is a Windows binary; run it via Windows interop:
/mnt/c/.../chrome-launcher-helper.exe            # prints the usage/constraint JSON line
```

A bare run with no args prints a `{"ok":false,...}` usage line — proof the binary loads and its
arg parsing runs on Windows.

## Where the bridge looks for it

The actions.json MCP resolves the helper path from `CHROME_LAUNCHER_HELPER_WIN` (a Windows path).
Point it at the built `.exe` (copied to a stable Windows location, e.g. `C:\temp\`), e.g.:

```
CHROME_LAUNCHER_HELPER_WIN='C:\temp\chrome-launcher-helper.exe'
```

## Remaining Windows-only wiring (verify on the Windows target)

`src/main.rs` `windows_spawn::spawn_pipe_chrome` creates the two anonymous pipes and spawns
Chrome, but the final piece — passing the two child pipe ends as **fds 3/4** via
`STARTUPINFOEX` + `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` (which `std::process::Command` does not
surface) — is written to compile and must be exercised on Windows against Chrome 149. The node
reference (`windows/pipe_session.mjs`, `stdio: [...,'pipe','pipe']`) is the behavioural spec.
This is the one piece that cannot be validated from a Linux host; it is the U9 live-parity gate.
