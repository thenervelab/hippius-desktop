//! [`VpnState`] — the async orchestration layer over a [`MeshEngine`].
//!
//! Held as `Arc<VpnState>` on [`crate::app_state::AppState`]. Owns the connection
//! status and the registry of active per-VM localhost forwards. All blocking
//! engine calls are run on `tokio::task::spawn_blocking`, since the real engine
//! drives a Go/cgo client that blocks the calling thread.
//!
//! Status is a `tokio::sync::watch` channel: it is the single source of
//! connection-state transitions. A bridge task (spawned in `main.rs`) subscribes
//! and forwards changes to the `VPN_STATUS_CHANGED` Tauri event from one place —
//! regardless of which command (or error path) caused the transition, and the
//! commands themselves never emit status. Because `watch` coalesces, the FE
//! always converges on the LATEST state but is not guaranteed to observe every
//! intermediate one (a fast `Connecting`→`Connected` may collapse); this is fine
//! because the FE consumes status as a level (`resolveVmVpnView`), not an edge
//! stream.
//!
//! Lock discipline (acquisition order `lifecycle → proxies`):
//! - `lifecycle` is a `tokio::sync::Mutex` that serializes the whole
//!   connect/disconnect lifecycle, so their two terminal `set_status` writes can
//!   never interleave — a concurrent disconnect must not land between connect's
//!   engine call and its `set_status(Connected)` and leave status `Connected`
//!   while the engine is torn down. It is held across the blocking `await` by
//!   design: tokio's guard is `Send`, unlike a `std` guard (axiom 74).
//! - `proxies` (a `std::sync::Mutex`) is NEVER held across an `await`: we
//!   read/clone under it, drop it, do the blocking engine call, then re-acquire
//!   to record the result. It carries a monotonic `generation` epoch alongside
//!   the forward map so an `open` whose connection was torn down mid-flight
//!   discards its result instead of caching a forward to a now-dead session.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::watch;

use crate::vpn::engine::{LocalEndpoint, MeshConfig, MeshEngine, MeshStatus, MeshTarget};
use crate::vpn::error::VpnError;

/// An active localhost forward: which VM target it reaches and the loopback
/// endpoint the app connects to. Stored so connections can be re-listed (the FE
/// rehydrates its endpoint view on remount via `vpn_list_connections`).
#[derive(Clone)]
struct ProxyEntry {
    target: MeshTarget,
    endpoint: LocalEndpoint,
}

/// The active-forward registry plus a monotonic connection epoch, guarded as a
/// unit by the `proxies` mutex.
///
/// `generation` is bumped on every teardown (`disconnect`): an `open` snapshots
/// it before its blocking `open_proxy` call and re-checks it before inserting,
/// so a forward opened against a connection that was torn down mid-flight is
/// discarded rather than cached as a live endpoint pointing at a dead session.
/// Keeping the epoch and the map under one lock is what makes the snapshot →
/// blocking-call → re-check → insert sequence atomic against `disconnect`'s
/// clear+bump.
struct ProxyRegistry {
    /// Bumped (wrapping) on each teardown; invalidates in-flight opens.
    generation: u64,
    /// Active forwards, keyed by [`MeshTarget::key`].
    entries: HashMap<String, ProxyEntry>,
}

/// Per-session VPN state. One instance lives on `AppState`.
pub struct VpnState {
    engine: Arc<dyn MeshEngine>,
    /// Serializes the connect/disconnect lifecycle so their terminal status
    /// writes cannot interleave (see the module-level lock discipline). A
    /// `tokio` mutex because it is held across the blocking `await`.
    lifecycle: tokio::sync::Mutex<()>,
    /// Single source of connection-state transitions; the bridge task forwards
    /// changes to the FE. `send_replace`/`send_if_modified` are the only writers.
    status: watch::Sender<MeshStatus>,
    /// Active forwards + connection epoch; see [`ProxyRegistry`].
    proxies: Mutex<ProxyRegistry>,
}

impl VpnState {
    /// Construct with the given engine. Production uses
    /// [`crate::vpn::engine::default_engine`]; tests inject a fake.
    pub(crate) fn new(engine: Arc<dyn MeshEngine>) -> Self {
        VpnState {
            engine,
            lifecycle: tokio::sync::Mutex::new(()),
            status: watch::channel(MeshStatus::Disconnected).0,
            proxies: Mutex::new(ProxyRegistry {
                generation: 0,
                entries: HashMap::new(),
            }),
        }
    }

    /// Current connection state (cheap clone).
    pub(crate) fn status_snapshot(&self) -> MeshStatus {
        self.status.borrow().clone()
    }

    /// Subscribe to status transitions. Consumed by the `main.rs` bridge task to
    /// forward changes to the `VPN_STATUS_CHANGED` Tauri event. `pub` (not
    /// `pub(crate)`) because its only non-test caller is the binary crate, which
    /// re-compiles this module separately — a `pub(crate)` method would read as
    /// dead code in the library build.
    pub fn subscribe(&self) -> watch::Receiver<MeshStatus> {
        self.status.subscribe()
    }

    fn set_status(&self, s: MeshStatus) {
        // `send_replace` updates + notifies even with no live receivers (true at
        // startup before the bridge subscribes), unlike `send`.
        self.status.send_replace(s);
    }

    /// Enroll + connect the desktop peer.
    ///
    /// The `Disconnected → Connecting` transition is an atomic compare-and-set
    /// (`send_if_modified` under the watch lock): two racing callers can't both
    /// pass the guard and double-enroll — the loser gets
    /// [`VpnError::AlreadyConnected`].
    pub(crate) async fn connect(&self, cfg: MeshConfig) -> Result<(), VpnError> {
        // Serialize against `disconnect` for the whole call so the terminal
        // `set_status(Connected)` below can't be overtaken by a concurrent
        // disconnect's `set_status(Disconnected)` (which would leave status
        // Connected while the engine is torn down). Held across the `await`.
        let _lifecycle = self.lifecycle.lock().await;

        let transitioned = self.status.send_if_modified(|s| {
            if matches!(s, MeshStatus::Connected | MeshStatus::Connecting) {
                false
            } else {
                *s = MeshStatus::Connecting;
                true
            }
        });
        if !transitioned {
            return Err(VpnError::AlreadyConnected);
        }

        let engine = self.engine.clone();
        let result = match tokio::task::spawn_blocking(move || engine.connect(cfg)).await {
            Ok(inner) => inner,
            Err(join_err) => Err(VpnError::Engine(format!("connect task panicked: {join_err}"))),
        };

        match result {
            Ok(()) => {
                self.set_status(MeshStatus::Connected);
                Ok(())
            }
            Err(e) => {
                self.set_status(MeshStatus::Error { message: e.to_string() });
                Err(e)
            }
        }
    }

    /// Leave the overlay and forget all forwards. Idempotent — safe to call
    /// when already disconnected (used by logout/teardown paths).
    pub(crate) async fn disconnect(&self) -> Result<(), VpnError> {
        let _lifecycle = self.lifecycle.lock().await;

        let engine = self.engine.clone();
        let result = match tokio::task::spawn_blocking(move || engine.disconnect()).await {
            Ok(inner) => inner,
            Err(join_err) => Err(VpnError::Engine(format!("disconnect task panicked: {join_err}"))),
        };
        // Clear the registry AND bump the generation regardless: the engine tore
        // the forwards down (or we abandon them), so stale entries must not
        // linger, and the bump makes any `open` still in flight discard its
        // result instead of inserting an orphan into the just-cleared map.
        {
            let mut registry = self.proxies.lock().expect("vpn proxies lock");
            registry.entries.clear();
            registry.generation = registry.generation.wrapping_add(1);
        }
        self.set_status(MeshStatus::Disconnected);
        result
    }

    /// Open (or reuse) a localhost forward to a VM service over the mesh.
    ///
    /// Returns [`VpnError::NotConnected`] if the peer isn't connected — the
    /// command layer maps that to `NotReady(VpnNotConnected)`. Idempotent per
    /// target: a second call for the same address+port returns the existing
    /// endpoint rather than opening a duplicate forward.
    pub(crate) async fn open_vm_connection(&self, target: &MeshTarget) -> Result<LocalEndpoint, VpnError> {
        target.validate()?;
        if !matches!(self.status_snapshot(), MeshStatus::Connected) {
            return Err(VpnError::NotConnected);
        }

        // Snapshot the idempotent-reuse check and the connection epoch under one
        // lock so both observe the same generation.
        let key = target.key();
        let generation = {
            let registry = self.proxies.lock().expect("vpn proxies lock");
            if let Some(existing) = registry.entries.get(&key) {
                return Ok(existing.endpoint.clone());
            }
            registry.generation
        };

        let engine = self.engine.clone();
        let target_owned = target.clone();
        let endpoint = match tokio::task::spawn_blocking(move || engine.open_proxy(&target_owned)).await {
            Ok(inner) => inner?,
            Err(join_err) => return Err(VpnError::Engine(format!("open_proxy task panicked: {join_err}"))),
        };

        // Commit only if no `disconnect` bumped the generation while we were in
        // `open_proxy`. Otherwise the forward we just opened belongs to a
        // torn-down session: caching it would serve a dead endpoint forever
        // (idempotent reuse would keep returning it), so discard it instead.
        {
            let mut registry = self.proxies.lock().expect("vpn proxies lock");
            if registry.generation == generation {
                registry.entries.insert(
                    key,
                    ProxyEntry {
                        target: target.clone(),
                        endpoint: endpoint.clone(),
                    },
                );
                return Ok(endpoint);
            }
        }

        // Superseded: best-effort reap the orphan forward (a no-op on the real
        // engine, which has no per-proxy stop; the fake stops its echo thread),
        // then report the session as gone.
        let engine = self.engine.clone();
        let orphan = endpoint;
        let _ = tokio::task::spawn_blocking(move || engine.close_proxy(&orphan)).await;
        Err(VpnError::NotConnected)
    }

    /// Tear down a previously opened forward. Idempotent — closing an unknown
    /// target is a no-op `Ok`.
    pub(crate) async fn close_vm_connection(&self, target: &MeshTarget) -> Result<(), VpnError> {
        let key = target.key();
        let entry = self.proxies.lock().expect("vpn proxies lock").entries.remove(&key);
        let Some(entry) = entry else {
            return Ok(());
        };

        let engine = self.engine.clone();
        let endpoint = entry.endpoint;
        match tokio::task::spawn_blocking(move || engine.close_proxy(&endpoint)).await {
            Ok(inner) => inner,
            Err(join_err) => Err(VpnError::Engine(format!("close_proxy task panicked: {join_err}"))),
        }
    }

    /// Snapshot the active forwards (target + loopback endpoint), so the FE can
    /// rehydrate its endpoint view on remount. Order is unspecified.
    pub(crate) fn list_connections(&self) -> Vec<(MeshTarget, LocalEndpoint)> {
        self.proxies
            .lock()
            .expect("vpn proxies lock")
            .entries
            .values()
            .map(|e| (e.target.clone(), e.endpoint.clone()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    use super::*;
    use crate::vpn::engine::DisabledEngine;
    use crate::vpn::fake_engine::FakeMeshEngine;

    fn fake_state() -> VpnState {
        VpnState::new(Arc::new(FakeMeshEngine::new()))
    }

    fn cfg() -> MeshConfig {
        MeshConfig {
            management_url: "https://netbird.example.com".into(),
            credential: "test-setup-key".into(),
            device_name: "hippius-desktop-test".into(),
        }
    }

    fn target(port: u16) -> MeshTarget {
        MeshTarget {
            address: "100.64.0.5".into(),
            port,
        }
    }

    #[tokio::test]
    async fn connect_transitions_to_connected() {
        let state = fake_state();
        assert_eq!(state.status_snapshot(), MeshStatus::Disconnected);
        state.connect(cfg()).await.expect("connect");
        assert_eq!(state.status_snapshot(), MeshStatus::Connected);
    }

    #[tokio::test]
    async fn double_connect_is_rejected() {
        let state = fake_state();
        state.connect(cfg()).await.expect("first connect");
        let err = state.connect(cfg()).await.expect_err("second connect must fail");
        assert!(matches!(err, VpnError::AlreadyConnected));
    }

    #[tokio::test]
    async fn connect_while_connecting_is_rejected() {
        // The Disconnected→Connecting compare-and-set is atomic, so a second
        // connect that lands while the first is mid-flight (status == Connecting)
        // is rejected rather than double-enrolling. Simulate the mid-flight state
        // directly by driving the watch into Connecting.
        let state = fake_state();
        state.set_status(MeshStatus::Connecting);
        let err = state.connect(cfg()).await.expect_err("connect during Connecting must fail");
        assert!(matches!(err, VpnError::AlreadyConnected));
    }

    #[tokio::test]
    async fn open_before_connect_is_not_connected() {
        let state = fake_state();
        let err = state.open_vm_connection(&target(22)).await.expect_err("must require connect");
        assert!(matches!(err, VpnError::NotConnected));
    }

    #[tokio::test]
    async fn invalid_target_is_rejected_even_when_connected() {
        let state = fake_state();
        state.connect(cfg()).await.expect("connect");
        let bad = MeshTarget { address: "  ".into(), port: 22 };
        assert!(matches!(state.open_vm_connection(&bad).await, Err(VpnError::InvalidTarget(_))));
        let zero = MeshTarget { address: "100.64.0.5".into(), port: 0 };
        assert!(matches!(state.open_vm_connection(&zero).await, Err(VpnError::InvalidTarget(_))));
    }

    /// The whole point of the fake: the returned endpoint is a real loopback
    /// socket that round-trips bytes — proving connect → open_proxy → reach.
    #[tokio::test]
    async fn open_connection_yields_a_reachable_loopback_endpoint() {
        let state = fake_state();
        state.connect(cfg()).await.expect("connect");
        let ep = state.open_vm_connection(&target(22)).await.expect("open");
        assert_eq!(ep.host, "127.0.0.1");

        let mut sock = TcpStream::connect((ep.host.as_str(), ep.port)).expect("dial loopback");
        sock.write_all(b"ping").expect("write");
        let mut buf = [0u8; 4];
        sock.read_exact(&mut buf).expect("read echo");
        assert_eq!(&buf, b"ping");
    }

    #[tokio::test]
    async fn open_is_idempotent_per_target() {
        let state = fake_state();
        state.connect(cfg()).await.expect("connect");
        let first = state.open_vm_connection(&target(22)).await.expect("first");
        let second = state.open_vm_connection(&target(22)).await.expect("second");
        assert_eq!(first, second, "same target must reuse the same forward");
    }

    #[tokio::test]
    async fn list_connections_reflects_open_and_close() {
        let state = fake_state();
        state.connect(cfg()).await.expect("connect");
        assert!(state.list_connections().is_empty());

        state.open_vm_connection(&target(22)).await.expect("open 22");
        state.open_vm_connection(&target(2222)).await.expect("open 2222");
        let mut ports: Vec<u16> = state.list_connections().iter().map(|(t, _)| t.port).collect();
        ports.sort_unstable();
        assert_eq!(ports, vec![22, 2222]);

        state.close_vm_connection(&target(22)).await.expect("close 22");
        let remaining: Vec<u16> = state.list_connections().iter().map(|(t, _)| t.port).collect();
        assert_eq!(remaining, vec![2222]);
    }

    #[tokio::test]
    async fn close_unknown_target_is_ok() {
        let state = fake_state();
        state.connect(cfg()).await.expect("connect");
        state.close_vm_connection(&target(2222)).await.expect("closing unknown is a no-op");
    }

    #[tokio::test]
    async fn close_then_reopen_allocates_again() {
        let state = fake_state();
        state.connect(cfg()).await.expect("connect");
        let ep1 = state.open_vm_connection(&target(22)).await.expect("open1");
        state.close_vm_connection(&target(22)).await.expect("close");
        // After close the registry no longer has the entry, so reopening goes
        // through the engine again (a fresh loopback port).
        let ep2 = state.open_vm_connection(&target(22)).await.expect("open2");
        assert_ne!(ep1.port, ep2.port, "a reopened forward should be a fresh port");
    }

    #[tokio::test]
    async fn disconnect_clears_proxies_and_status() {
        let state = fake_state();
        state.connect(cfg()).await.expect("connect");
        state.open_vm_connection(&target(22)).await.expect("open");
        state.disconnect().await.expect("disconnect");
        assert_eq!(state.status_snapshot(), MeshStatus::Disconnected);
        assert!(state.list_connections().is_empty());
        // Reconnect + reopen works (registry was cleared, not left stale).
        state.connect(cfg()).await.expect("reconnect");
        state.open_vm_connection(&target(22)).await.expect("reopen after reconnect");
    }

    #[tokio::test]
    async fn disabled_engine_reports_unsupported() {
        let state = VpnState::new(Arc::new(DisabledEngine));
        let err = state.connect(cfg()).await.expect_err("disabled build must refuse connect");
        assert!(matches!(err, VpnError::UnsupportedBuild));
        assert_eq!(state.status_snapshot(), MeshStatus::Error { message: "VPN is not available in this build".into() });
    }

    #[tokio::test]
    async fn status_transitions_are_observable_via_subscribe() {
        // The bridge task relies on `subscribe()` seeing each transition. Assert
        // a subscriber observes Connecting then Connected across one connect.
        let state = fake_state();
        let mut rx = state.subscribe();
        state.connect(cfg()).await.expect("connect");
        // The receiver coalesces to the latest value; the terminal state must be
        // Connected, and the channel must have registered a change.
        assert!(rx.has_changed().expect("channel open"));
        assert_eq!(rx.borrow_and_update().clone(), MeshStatus::Connected);
    }

    /// An engine whose `open_proxy` blocks until the test releases a gate, so a
    /// `disconnect` can be made to land *while an open is in flight* — the exact
    /// interleaving that, before the generation guard, cached a forward into a
    /// torn-down session and served it forever (the reviewed P2 race).
    struct GatedOpenEngine {
        gate: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    }

    impl GatedOpenEngine {
        fn new(gate: std::sync::mpsc::Receiver<()>) -> Self {
            GatedOpenEngine {
                gate: Mutex::new(Some(gate)),
            }
        }
    }

    impl MeshEngine for GatedOpenEngine {
        fn connect(&self, _cfg: MeshConfig) -> Result<(), VpnError> {
            Ok(())
        }
        fn disconnect(&self) -> Result<(), VpnError> {
            Ok(())
        }
        fn open_proxy(&self, _target: &MeshTarget) -> Result<LocalEndpoint, VpnError> {
            // Block until the test releases the gate, simulating a slow open
            // during which a disconnect can land. Take the receiver out so the
            // std lock isn't held across the blocking `recv`.
            if let Some(rx) = self.gate.lock().expect("gate lock").take() {
                let _ = rx.recv();
            }
            Ok(LocalEndpoint {
                host: "127.0.0.1".into(),
                port: 40000,
            })
        }
        fn close_proxy(&self, _endpoint: &LocalEndpoint) -> Result<(), VpnError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn open_superseded_by_disconnect_is_discarded() {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let state = Arc::new(VpnState::new(Arc::new(GatedOpenEngine::new(rx))));
        state.connect(cfg()).await.expect("connect");

        let opener = state.clone();
        let open = tokio::spawn(async move { opener.open_vm_connection(&target(22)).await });

        // Let the open task reach `open_proxy` and park on the gate. The
        // assertion holds for either interleaving — if the disconnect somehow
        // wins the race first, the open just fails its `Connected` precheck
        // instead — but this exercises the in-flight commit path deterministically.
        tokio::time::sleep(Duration::from_millis(50)).await;

        state.disconnect().await.expect("disconnect");
        tx.send(()).expect("release gate");

        let result = open.await.expect("join open task");
        assert!(
            matches!(result, Err(VpnError::NotConnected)),
            "an open superseded by disconnect must be discarded, got {result:?}"
        );
        assert!(
            state.list_connections().is_empty(),
            "the superseded forward must not be cached"
        );
    }
}
