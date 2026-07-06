//! Test-only [`MeshEngine`] backed by real localhost echo servers.
//!
//! `open_proxy` binds an actual `127.0.0.1:0` TCP listener and spawns a thread
//! that echoes bytes back, so the full `connect → open_proxy → reach` flow is
//! exercisable over real loopback sockets with no Go, no network, and no VM.
//! This lets [`crate::vpn::state::VpnState`] be tested as the app runs it,
//! rather than against a mock that the same author could misread.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::vpn::engine::{LocalEndpoint, MeshConfig, MeshEngine, MeshTarget};
use crate::vpn::error::VpnError;

/// A running echo server's stop flag, keyed by its loopback port.
type Servers = Mutex<HashMap<u16, Arc<AtomicBool>>>;

pub(crate) struct FakeMeshEngine {
    servers: Servers,
}

impl FakeMeshEngine {
    pub(crate) fn new() -> Self {
        FakeMeshEngine {
            servers: Mutex::new(HashMap::new()),
        }
    }
}

impl MeshEngine for FakeMeshEngine {
    fn connect(&self, _cfg: MeshConfig) -> Result<(), VpnError> {
        Ok(())
    }

    fn disconnect(&self) -> Result<(), VpnError> {
        // Signal every echo server to stop, then drop the flags.
        let mut servers = self.servers.lock().expect("fake servers lock");
        for stop in servers.values() {
            stop.store(true, Ordering::SeqCst);
        }
        servers.clear();
        Ok(())
    }

    fn open_proxy(&self, _target: &MeshTarget) -> Result<LocalEndpoint, VpnError> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| VpnError::Proxy(e.to_string()))?;
        listener.set_nonblocking(true).map_err(|e| VpnError::Proxy(e.to_string()))?;
        let port = listener.local_addr().map_err(|e| VpnError::Proxy(e.to_string()))?.port();

        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_thread = stop.clone();
        std::thread::spawn(move || {
            // Non-blocking accept loop: poll for connections, honour the stop
            // flag so `close_proxy`/`disconnect` actually shut the server down
            // (a blocking accept would never notice the flag).
            loop {
                if stop_for_thread.load(Ordering::SeqCst) {
                    break;
                }
                match listener.accept() {
                    Ok((mut sock, _peer)) => {
                        // Echo each accepted connection on its own thread.
                        std::thread::spawn(move || {
                            let mut buf = [0u8; 1024];
                            loop {
                                match sock.read(&mut buf) {
                                    Ok(0) | Err(_) => break,
                                    Ok(n) => {
                                        if sock.write_all(&buf[..n]).is_err() {
                                            break;
                                        }
                                    }
                                }
                            }
                        });
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
        });

        self.servers.lock().expect("fake servers lock").insert(port, stop);
        Ok(LocalEndpoint {
            host: "127.0.0.1".to_string(),
            port,
        })
    }

    fn close_proxy(&self, endpoint: &LocalEndpoint) -> Result<(), VpnError> {
        if let Some(stop) = self.servers.lock().expect("fake servers lock").remove(&endpoint.port) {
            stop.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
}

impl Drop for FakeMeshEngine {
    fn drop(&mut self) {
        // Reap every echo thread when the engine (and the VpnState that owns it)
        // is dropped, even if a test opened a forward without calling
        // close/disconnect — otherwise the 10ms-poll accept loops would run for
        // the rest of the test binary.
        if let Ok(servers) = self.servers.lock() {
            for stop in servers.values() {
                stop.store(true, Ordering::SeqCst);
            }
        }
    }
}
