//! `--finder-share <path>` CLI mode: forward a shell-extension click to the
//! running app, then exit.
//!
//! This is the *same* binary invoked in a short-lived second mode — the
//! one-binary requirement (no separate helper is shipped). The Linux
//! file-manager action files call `hippius --finder-share <abs-path>`; that
//! process connects to the running app's bridge socket, writes one
//! `SHARE:<path>` line (the exact wire the [`super::socket`] server parses), and
//! exits. It runs BEFORE the Tauri builder in `main()` and does blocking socket
//! I/O, so it never spins up the webview/runtime.
//!
//! If no app is running the socket is absent; the CLI launches a fresh app
//! instance once and retries while it boots and binds the socket, so a click
//! made while Hippius is closed still lands (the single-instance plugin forwards
//! a duplicate launch to the already-running app).

#[cfg(unix)]
use std::path::Path;

/// Forward a share click for `path` and terminate the process. Never returns.
#[cfg(unix)]
pub fn run(path: &str) -> ! {
    std::process::exit(forward(path));
}

/// Resolve the socket, then connect-and-send with a launch-and-retry fallback.
/// Returns a process exit code (0 = delivered, 1 = could not reach the app).
#[cfg(unix)]
fn forward(path: &str) -> i32 {
    use std::path::PathBuf;
    use std::time::Duration;

    use crate::finder_bridge::endpoint::{self, Endpoint};
    use crate::finder_bridge::protocol::ClientMessage;

    let Ok(Endpoint::Unix(sock)) = endpoint::resolve() else {
        warn("hippius: cannot resolve the share socket path");
        return 1;
    };
    let line = ClientMessage::Share(PathBuf::from(path)).to_wire();

    // ~10s total (50 × 200ms) — enough for a cold app launch to bind the socket,
    // short enough that a genuinely wedged launch fails the click rather than
    // hanging the file manager's spawned command forever.
    let mut launched = false;
    for attempt in 0..50 {
        if try_send(&sock, &line).is_ok() {
            return 0;
        }
        if !launched {
            launch_app();
            launched = true;
        }
        if attempt < 49 {
            std::thread::sleep(Duration::from_millis(200));
        }
    }
    warn("hippius: the app did not become reachable; share not sent");
    1
}

/// Emit a one-line diagnostic to stderr. Uses `writeln!` on the stderr handle
/// rather than the `eprintln!` macro (which the crate's `clippy::print_stderr`
/// denies), and because a tracing subscriber is not yet installed in CLI mode.
#[cfg(unix)]
fn warn(msg: &str) {
    use std::io::Write;
    let _ = writeln!(std::io::stderr(), "{msg}");
}

/// Connect to the bridge socket and write one newline-terminated wire line.
/// The blocking counterpart of the async server's per-connection read — split
/// out so it can be exercised against a live [`super::socket::FinderBridge`].
#[cfg(unix)]
fn try_send(sock: &Path, line: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::net::UnixStream;

    let mut stream = UnixStream::connect(sock)?;
    stream.write_all(line.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()
}

/// Launch a detached app instance so a click made while Hippius is closed still
/// boots it. Best-effort: a spawn failure just means the retry loop times out.
#[cfg(unix)]
fn launch_app() {
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::process::Command::new(exe).spawn();
    }
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use crate::finder_bridge::endpoint::Endpoint;
    use crate::finder_bridge::protocol::ClientMessage;
    use crate::finder_bridge::socket::FinderBridge;
    use std::path::PathBuf;
    use std::time::Duration;
    use tokio::time::timeout;

    /// The CLI send path reaches a live bridge: `try_send` of a `SHARE:` line
    /// arrives on the server's inbound channel as the exact `ClientMessage`.
    #[tokio::test]
    async fn try_send_delivers_a_share_click_to_the_bridge() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sock = dir.path().join("finder.sock");
        let (bridge, mut incoming) = FinderBridge::start(Endpoint::Unix(sock.clone())).expect("bridge starts");

        let clicked = PathBuf::from("/home/me/Hippius/report.pdf");
        let line = ClientMessage::Share(clicked.clone()).to_wire();
        // Blocking client I/O off the async runtime.
        let sock_for_send = sock.clone();
        tokio::task::spawn_blocking(move || try_send(&sock_for_send, &line))
            .await
            .expect("join")
            .expect("send ok");

        let msg = timeout(Duration::from_secs(2), incoming.recv()).await.expect("timeout").expect("closed");
        assert_eq!(msg, ClientMessage::Share(clicked));
        bridge.shutdown();
    }

    /// A path with a space + `:` survives the CLI → wire → server round trip
    /// (the percent codec framing the file manager's arbitrary path relies on).
    #[tokio::test]
    async fn try_send_preserves_spaces_and_colons() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sock = dir.path().join("finder.sock");
        let (bridge, mut incoming) = FinderBridge::start(Endpoint::Unix(sock.clone())).expect("bridge starts");

        let clicked = PathBuf::from("/home/me/My: Notes/a b.txt");
        let line = ClientMessage::Share(clicked.clone()).to_wire();
        let sock_for_send = sock.clone();
        tokio::task::spawn_blocking(move || try_send(&sock_for_send, &line))
            .await
            .expect("join")
            .expect("send ok");

        let msg = timeout(Duration::from_secs(2), incoming.recv()).await.expect("timeout").expect("closed");
        assert_eq!(msg, ClientMessage::Share(clicked));
        bridge.shutdown();
    }
}
