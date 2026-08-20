//! Transport server bridging the file-manager extension and the app.
//!
//! Built on the pure [`super::protocol`] codec — one message per line. The
//! address is platform-specific ([`super::endpoint`]): a Unix-domain socket on
//! macOS/Linux, a named pipe on Windows. Everything else here — the accept →
//! per-connection read/write loop, the broadcast/mpsc fan-out, and cooperative
//! shutdown — is shared and generic over any `AsyncRead + AsyncWrite` stream, so
//! every CI `rust` job (macOS, Linux, Windows) exercises the framing/broadcast
//! logic against its native transport.
//!
//! ## Concurrency model
//! - **App → extensions**: a `tokio::sync::broadcast`. Every connection
//!   subscribes; a lagging extension drops intermediate frames, which is
//!   recoverable because the registered roots are replayed on each new
//!   connection and badge updates are idempotent.
//! - **Extension → app**: an **unbounded** `mpsc`. Volume is one message per
//!   user menu click (rare), and a click is a discrete user intent we must not
//!   silently drop, so backpressure is unnecessary — the unbounded choice is
//!   deliberate, not accidental (axiom `rust_quality_172`).
//! - **Shutdown**: a `CancellationToken` observed by the accept loop and every
//!   connection task, so teardown is cooperative and lets in-flight writes
//!   finish rather than an abrupt `abort()` (axiom `rust_quality_129`).

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

#[cfg(unix)]
use tokio::net::UnixListener;
#[cfg(windows)]
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

use crate::finder_bridge::endpoint::Endpoint;
use crate::finder_bridge::error::FinderBridgeError;
use crate::finder_bridge::protocol::{BadgeState, ClientMessage, ServerMessage};

/// Bounded capacity for the app→extension broadcast. Updates are small; a slow
/// extension that lags merely misses intermediate frames, recovered by the
/// on-connect root replay plus the next badge resync.
const OUTGOING_CAPACITY: usize = 256;

/// The desktop end of the file-manager-extension channel.
#[derive(Debug)]
pub struct FinderBridge {
    outgoing: broadcast::Sender<ServerMessage>,
    roots: Arc<Mutex<BTreeSet<PathBuf>>>,
    cancel: CancellationToken,
}

impl FinderBridge {
    /// Bind the transport at `endpoint`, spawn the accept loop, and return the
    /// bridge handle plus the receiver of inbound [`ClientMessage`]s (user menu
    /// actions the consumer drains). Must be called from within a Tokio runtime.
    ///
    /// # Errors
    /// [`FinderBridgeError::Io`] if the parent directory cannot be created, a
    /// stale socket cannot be removed, or the bind/pipe-create fails.
    pub fn start(endpoint: Endpoint) -> Result<(Arc<Self>, mpsc::UnboundedReceiver<ClientMessage>), FinderBridgeError> {
        let (outgoing, _) = broadcast::channel(OUTGOING_CAPACITY);
        let (incoming_tx, incoming_rx) = mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        let bridge = Arc::new(Self {
            outgoing: outgoing.clone(),
            roots: Arc::new(Mutex::new(BTreeSet::new())),
            cancel: cancel.clone(),
        });

        spawn_accept_loop(endpoint, outgoing, incoming_tx, bridge.roots.clone(), cancel)?;
        Ok((bridge, incoming_rx))
    }

    /// Register a sync root for the extension to monitor; idempotent. Broadcast
    /// to connected extensions and replayed to future connections.
    pub fn register_root(&self, path: PathBuf) {
        if lock(&self.roots).insert(path.clone()) {
            // A send error means no extension is connected yet; the root is
            // already stored, so the next connection's replay covers it.
            let _ = self.outgoing.send(ServerMessage::RegisterPath(path));
        }
    }

    /// Stop monitoring a sync root (drive removed); idempotent.
    pub fn unregister_root(&self, path: &PathBuf) {
        if lock(&self.roots).remove(path) {
            let _ = self.outgoing.send(ServerMessage::UnregisterPath(path.clone()));
        }
    }

    /// Set (or clear) the file-manager badge for a single path. Best-effort: with
    /// no extension connected the broadcast is simply dropped.
    pub fn set_badge(&self, state: BadgeState, path: PathBuf) {
        let _ = self.outgoing.send(ServerMessage::Status { state, path });
    }

    /// Signal the accept loop and every connection task to wind down cleanly.
    pub fn shutdown(&self) {
        self.cancel.cancel();
    }
}

impl Drop for FinderBridge {
    fn drop(&mut self) {
        // Tear the accept loop + connection tasks down if the bridge is dropped
        // without an explicit shutdown() (e.g. process exit / logout teardown).
        self.cancel.cancel();
    }
}

/// Lock the roots mutex, recovering from poisoning. The guard is only ever held
/// inside synchronous helpers (never across an `.await`), so a panicked holder
/// left the `BTreeSet` in a consistent state and `into_inner` is safe.
fn lock(roots: &Mutex<BTreeSet<PathBuf>>) -> MutexGuard<'_, BTreeSet<PathBuf>> {
    roots.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Snapshot the current roots into an owned `Vec` so the connection writer can
/// replay them without holding the lock across its `.await` writes.
fn snapshot_roots(roots: &Mutex<BTreeSet<PathBuf>>) -> Vec<PathBuf> {
    lock(roots).iter().cloned().collect()
}

/// Bind the platform transport (synchronously, so bind errors surface from
/// [`FinderBridge::start`]) and spawn its accept loop.
#[cfg(unix)]
fn spawn_accept_loop(
    endpoint: Endpoint,
    outgoing: broadcast::Sender<ServerMessage>,
    incoming_tx: mpsc::UnboundedSender<ClientMessage>,
    roots: Arc<Mutex<BTreeSet<PathBuf>>>,
    cancel: CancellationToken,
) -> Result<(), FinderBridgeError> {
    // On Unix the endpoint has only the `Unix` variant (the `Pipe` arm is
    // compiled out), so this destructure is irrefutable.
    let Endpoint::Unix(socket_path) = endpoint;
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // A stale socket file from a prior run makes `bind` fail with `EADDRINUSE`.
    match std::fs::remove_file(&socket_path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let listener = UnixListener::bind(&socket_path)?;
    tokio::spawn(accept_loop_unix(listener, outgoing, incoming_tx, roots, cancel, socket_path));
    Ok(())
}

/// Windows counterpart: create the first named-pipe instance (owning the name)
/// and spawn the pipe accept loop.
#[cfg(windows)]
fn spawn_accept_loop(
    endpoint: Endpoint,
    outgoing: broadcast::Sender<ServerMessage>,
    incoming_tx: mpsc::UnboundedSender<ClientMessage>,
    roots: Arc<Mutex<BTreeSet<PathBuf>>>,
    cancel: CancellationToken,
) -> Result<(), FinderBridgeError> {
    let Endpoint::Pipe(pipe_name) = endpoint;
    // `first_pipe_instance(true)` fails if another process already owns the
    // name, so a second app instance surfaces the collision instead of two
    // servers racing on the same pipe.
    let server = ServerOptions::new().first_pipe_instance(true).create(&pipe_name)?;
    tokio::spawn(accept_loop_windows(server, pipe_name, outgoing, incoming_tx, roots, cancel));
    Ok(())
}

/// Accept Unix-socket connections until cancelled, spawning a task per
/// connection. Best-effort cleanup removes the socket file so a future
/// [`FinderBridge::start`] can rebind the same path.
#[cfg(unix)]
async fn accept_loop_unix(
    listener: UnixListener,
    outgoing: broadcast::Sender<ServerMessage>,
    incoming_tx: mpsc::UnboundedSender<ClientMessage>,
    roots: Arc<Mutex<BTreeSet<PathBuf>>>,
    cancel: CancellationToken,
    socket_path: PathBuf,
) {
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _addr)) => spawn_connection(stream, &outgoing, &incoming_tx, &roots, &cancel),
                Err(e) => warn!(error = %e, "finder bridge: accept failed; continuing"),
            },
            () = cancel.cancelled() => break,
        }
    }
    let _ = std::fs::remove_file(&socket_path);
    debug!("finder bridge: accept loop stopped");
}

/// Accept named-pipe connections until cancelled. The tokio idiom: after a
/// client connects, build the *next* server instance before handing the
/// connected one to its task, so a concurrent connect is never refused while we
/// service this client.
#[cfg(windows)]
async fn accept_loop_windows(
    mut server: NamedPipeServer,
    pipe_name: String,
    outgoing: broadcast::Sender<ServerMessage>,
    incoming_tx: mpsc::UnboundedSender<ClientMessage>,
    roots: Arc<Mutex<BTreeSet<PathBuf>>>,
    cancel: CancellationToken,
) {
    loop {
        tokio::select! {
            connected = server.connect() => {
                if let Err(e) = connected {
                    warn!(error = %e, "finder bridge: pipe connect failed; continuing");
                    continue;
                }
                let next = match ServerOptions::new().create(&pipe_name) {
                    Ok(next) => next,
                    Err(e) => {
                        // Can't prepare another instance; service this client then
                        // stop accepting (the running app is still reachable via
                        // the connection it already has).
                        warn!(error = %e, "finder bridge: cannot create next pipe instance; stopping accept");
                        spawn_connection(server, &outgoing, &incoming_tx, &roots, &cancel);
                        break;
                    }
                };
                let connected_server = std::mem::replace(&mut server, next);
                spawn_connection(connected_server, &outgoing, &incoming_tx, &roots, &cancel);
            }
            () = cancel.cancelled() => break,
        }
    }
    debug!("finder bridge: accept loop stopped");
}

/// Subscribe + snapshot roots and spawn the per-connection handler. Subscribing
/// BEFORE snapshotting the roots means a registration racing this accept is
/// never missed (it arrives via the subscription); a root in both the snapshot
/// and a broadcast is a harmless duplicate `REGISTER_PATH` (idempotent).
fn spawn_connection<S>(
    stream: S,
    outgoing: &broadcast::Sender<ServerMessage>,
    incoming_tx: &mpsc::UnboundedSender<ClientMessage>,
    roots: &Arc<Mutex<BTreeSet<PathBuf>>>,
    cancel: &CancellationToken,
) where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let sub = outgoing.subscribe();
    let snapshot = snapshot_roots(roots);
    tokio::spawn(handle_connection(stream, incoming_tx.clone(), sub, snapshot, cancel.clone()));
}

/// Drive one connection: read inbound lines and write outbound broadcasts
/// concurrently, both observing `cancel` so neither half is dropped mid-write.
/// Generic over the transport stream ([`tokio::io::split`] works for both a
/// `UnixStream` and a `NamedPipeServer`).
async fn handle_connection<S>(
    stream: S,
    incoming_tx: mpsc::UnboundedSender<ClientMessage>,
    sub: broadcast::Receiver<ServerMessage>,
    initial_roots: Vec<PathBuf>,
    cancel: CancellationToken,
) where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (read_half, write_half) = tokio::io::split(stream);
    tokio::join!(
        read_task(read_half, incoming_tx, cancel.clone()),
        write_task(write_half, sub, initial_roots, cancel),
    );
}

/// Read newline-framed [`ClientMessage`]s and forward them to the consumer.
async fn read_task<R: AsyncRead + Unpin>(read_half: R, incoming_tx: mpsc::UnboundedSender<ClientMessage>, cancel: CancellationToken) {
    let mut lines = BufReader::new(read_half).lines();
    loop {
        tokio::select! {
            // `next_line` is cancellation-safe (a partial line stays in the
            // BufReader's buffer); on cancel we are tearing the conn down anyway.
            line = lines.next_line() => match line {
                Ok(Some(line)) => match ClientMessage::parse(&line) {
                    Ok(msg) => {
                        if incoming_tx.send(msg).is_err() {
                            break; // consumer gone — nothing will read further
                        }
                    }
                    Err(e) => warn!(error = %e, "finder bridge: dropping unparseable line"),
                },
                Ok(None) => break,                                 // EOF: extension disconnected
                Err(e) => {
                    warn!(error = %e, "finder bridge: read error; closing connection");
                    break;
                }
            },
            () = cancel.cancelled() => break,
        }
    }
}

/// Replay the current roots, then stream subsequent app→extension messages.
async fn write_task<W: AsyncWrite + Unpin>(
    mut write_half: W,
    mut sub: broadcast::Receiver<ServerMessage>,
    initial_roots: Vec<PathBuf>,
    cancel: CancellationToken,
) {
    // Replay the known roots so a freshly-connected extension learns which
    // folders to monitor without waiting for the next change.
    for root in initial_roots {
        if write_line(&mut write_half, &ServerMessage::RegisterPath(root).to_wire()).await.is_err() {
            return;
        }
    }
    loop {
        tokio::select! {
            // broadcast::recv is cancellation-safe: a dropped recv future does
            // not consume the pending message.
            received = sub.recv() => match received {
                Ok(msg) => {
                    if write_line(&mut write_half, &msg.to_wire()).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    warn!(skipped, "finder bridge: extension lagged; some updates skipped");
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            () = cancel.cancelled() => break,
        }
    }
}

/// Write one wire line plus its terminating newline and flush.
async fn write_line<W: AsyncWrite + Unpin>(write_half: &mut W, line: &str) -> std::io::Result<()> {
    write_half.write_all(line.as_bytes()).await?;
    write_half.write_all(b"\n").await?;
    write_half.flush().await
}

#[cfg(test)]
#[cfg(unix)]
mod unix_tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;
    use tokio::net::UnixStream;
    use tokio::time::timeout;

    const TIMEOUT: Duration = Duration::from_secs(2);

    fn unix_endpoint(path: &std::path::Path) -> Endpoint {
        Endpoint::Unix(path.to_path_buf())
    }

    /// Connect to the bridge socket. The listener is bound synchronously inside
    /// `start`, so the connection is accepted by the kernel immediately; a short
    /// retry covers the window before the first poll of the accept loop.
    async fn connect(path: &std::path::Path) -> UnixStream {
        for _ in 0..100 {
            if let Ok(stream) = UnixStream::connect(path).await {
                return stream;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("could not connect to finder bridge socket at {}", path.display());
    }

    /// Read one parsed `ServerMessage` line from the client side.
    async fn read_server_msg(lines: &mut tokio::io::Lines<BufReader<UnixStream>>) -> ServerMessage {
        let line = timeout(TIMEOUT, lines.next_line()).await.expect("timeout").expect("io").expect("eof");
        ServerMessage::parse(&line).expect("parse")
    }

    #[tokio::test]
    async fn share_click_arrives_on_incoming() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("finder.sock");
        let (bridge, mut incoming) = FinderBridge::start(unix_endpoint(&sock)).expect("bridge starts");

        let mut client = connect(&sock).await;
        client.write_all(b"SHARE:/Users/me/x.txt\n").await.unwrap();
        client.flush().await.expect("flush");

        let msg = timeout(TIMEOUT, incoming.recv()).await.expect("timeout").expect("closed");
        assert_eq!(msg, ClientMessage::Share(PathBuf::from("/Users/me/x.txt")));
        bridge.shutdown();
    }

    #[tokio::test]
    async fn registered_root_is_replayed_on_connect() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("finder.sock");
        let (bridge, _incoming) = FinderBridge::start(unix_endpoint(&sock)).expect("bridge starts");
        bridge.register_root(PathBuf::from("/Users/me/Hippius"));

        let client = connect(&sock).await;
        let mut lines = BufReader::new(client).lines();
        assert_eq!(
            read_server_msg(&mut lines).await,
            ServerMessage::RegisterPath(PathBuf::from("/Users/me/Hippius"))
        );
        bridge.shutdown();
    }

    #[tokio::test]
    async fn badge_update_reaches_connected_extension() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("finder.sock");
        let (bridge, _incoming) = FinderBridge::start(unix_endpoint(&sock)).expect("bridge starts");
        bridge.register_root(PathBuf::from("/r"));

        let client = connect(&sock).await;
        let mut lines = BufReader::new(client).lines();
        // Reading the replayed root proves the writer is live AND the broadcast
        // subscription exists, so a badge sent now cannot race ahead of it.
        assert_eq!(read_server_msg(&mut lines).await, ServerMessage::RegisterPath(PathBuf::from("/r")));

        bridge.set_badge(BadgeState::Syncing, PathBuf::from("/r/a.txt"));
        assert_eq!(
            read_server_msg(&mut lines).await,
            ServerMessage::Status {
                state: BadgeState::Syncing,
                path: PathBuf::from("/r/a.txt")
            }
        );
        bridge.shutdown();
    }

    #[tokio::test]
    async fn shutdown_closes_open_connections() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("finder.sock");
        let (bridge, _incoming) = FinderBridge::start(unix_endpoint(&sock)).expect("bridge starts");

        let client = connect(&sock).await;
        let mut lines = BufReader::new(client).lines();
        bridge.shutdown();

        // After shutdown the server drops both stream halves, so the client's
        // read must COMPLETE (not hang). It yields a clean EOF (`Ok(None)`) on
        // macOS, but Linux can surface the abrupt server-side close as a
        // `ConnectionReset` error instead — both mean "the connection closed",
        // which is the property under test. We only reject a hang (timeout) or
        // the connection somehow delivering more data.
        let closed = timeout(TIMEOUT, lines.next_line()).await.expect("read hung after shutdown");
        match closed {
            Ok(None) | Err(_) => {} // EOF (macOS) or connection reset (Linux)
            Ok(Some(line)) => panic!("expected the connection to close after shutdown, got a line: {line:?}"),
        }
    }
}

#[cfg(test)]
#[cfg(windows)]
mod windows_tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;
    use tokio::net::windows::named_pipe::ClientOptions;
    use tokio::time::timeout;

    const TIMEOUT: Duration = Duration::from_secs(2);

    /// A unique pipe name per test so parallel tests don't collide on the
    /// machine-global pipe namespace (the test index disambiguates).
    fn pipe_endpoint(tag: &str) -> (Endpoint, String) {
        let name = format!(r"\\.\pipe\hippius-finder-test-{tag}");
        (Endpoint::Pipe(name.clone()), name)
    }

    /// Connect a named-pipe client, retrying while the server is between
    /// instances (`ERROR_PIPE_BUSY`).
    async fn connect(name: &str) -> tokio::net::windows::named_pipe::NamedPipeClient {
        for _ in 0..100 {
            match ClientOptions::new().open(name) {
                Ok(client) => return client,
                Err(_) => tokio::time::sleep(Duration::from_millis(5)).await,
            }
        }
        panic!("could not connect to finder bridge pipe at {name}");
    }

    #[tokio::test]
    async fn share_click_arrives_on_incoming() {
        let (endpoint, name) = pipe_endpoint("share");
        let (bridge, mut incoming) = FinderBridge::start(endpoint).expect("bridge starts");

        let mut client = connect(&name).await;
        client.write_all(b"SHARE:C:\\Users\\me\\x.txt\n").await.expect("write share line");
        client.flush().await.expect("flush");

        let msg = timeout(TIMEOUT, incoming.recv()).await.expect("timeout").expect("closed");
        assert_eq!(msg, ClientMessage::Share(PathBuf::from(r"C:\Users\me\x.txt")));
        bridge.shutdown();
    }

    #[tokio::test]
    async fn registered_root_is_replayed_on_connect() {
        let (endpoint, name) = pipe_endpoint("replay");
        let (bridge, _incoming) = FinderBridge::start(endpoint).expect("bridge starts");
        bridge.register_root(PathBuf::from(r"C:\Users\me\Hippius"));

        let client = connect(&name).await;
        let mut lines = BufReader::new(client).lines();
        let line = timeout(TIMEOUT, lines.next_line()).await.expect("timeout").expect("io").expect("eof");
        assert_eq!(
            ServerMessage::parse(&line).expect("parse"),
            ServerMessage::RegisterPath(PathBuf::from(r"C:\Users\me\Hippius"))
        );
        bridge.shutdown();
    }
}
