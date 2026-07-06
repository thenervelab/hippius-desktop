# NetBird VPN for VM Connections — Desktop Integration Plan

**Status:** Planning (2026-06-29). VMs are **not live yet**; this builds the full
client-side capability behind feature gates so it is ready to wire to real VMs
when VM functionality lands.

**Branch base:** `redesign`.

## 1. Goal & scope

Add **opt-in, app-scoped** VPN connectivity so the desktop app can reach
Hippius VMs (hosted on HCCS miners, behind NAT) over a self-hosted NetBird
WireGuard overlay — **without touching any of the app's regular network
traffic** (Hippius API, blockchain `wss://`, hcfs sync, billing) and **without a
system-wide TUN / root / separate binary / privileged helper**.

This is the modern replacement for the removed Nebula VPN feature (the old
`nebula_ip` field on VMs).

### In scope (this plan — desktop client)
- Embed NetBird in **userspace mode** (no OS TUN) inside `src-tauri`.
- Opt-in connect/disconnect to the overlay as a userspace peer.
- Per-VM connections via `start_proxy()` → a **localhost endpoint** the app
  points SSH/console at. Cross-platform (`start_proxy` works on Windows, unlike
  Unix-only `dial()`).
- Feature-gated so default builds need no Go toolchain and ship no VPN code path
  until we flip it on.

### Explicitly NOT in scope here
- **Control-plane orchestration** (minting setup keys, creating per-tenant
  groups/policies, deleting peers on teardown). That lives in the **Hippius
  backend**, not the desktop — see `[[netbird-vpn-vm-connections]]` memory and
  the API surface notes. The desktop only *consumes*: a management URL, a
  desktop-peer credential, and per-VM overlay targets.
- System-wide VPN / routing all OS traffic (`NoUserspace: true`). Not wanted.

## 2. Architecture

```
Desktop (Tauri)                         Hippius self-hosted NetBird        HCCS miner
 app/ (FE, opt-in UI)                     - management / signal / relay      └─ VM (peer)
   └─ invoke vpn_* IPC
 src-tauri/src/vpn/  ← NEW
   ├─ MeshEngine (trait)
   │   ├─ NetbirdEngine  (feature "netbird-vpn", wraps vendored crate)  ──overlay──┐
   │   └─ FakeMeshEngine (tests; localhost echo)                                   │
   ├─ VpnState (in AppState)                                                       │
   └─ commands + events                                                            │
        vpn_open_vm_connection(target) → 127.0.0.1:<port>  ──start_proxy──────────┘
```

Regular app traffic never enters this path — only connections the app
explicitly opens through `start_proxy()` use the overlay.

## 3. Data structures, ownership & error strategy

*(Honors the "name the data structures / ownership / error strategy before Rust"
rule. The `mcp__illu__*` preflight/axioms tooling is unavailable in the current
environment; when implementing, run those gates if illu is present.)*

### Core abstraction — `MeshEngine` trait
The single most important design move for testability without live VMs: hide the
embedded client behind an async trait so the command layer is unit-testable with
a fake, and the heavy Go/cgo impl is swappable + feature-gated.

```rust
#[async_trait::async_trait]
pub(crate) trait MeshEngine: Send + Sync {
    async fn connect(&self, cfg: MeshConfig) -> Result<(), VpnError>;
    async fn disconnect(&self) -> Result<(), VpnError>;
    fn status(&self) -> MeshStatus;
    /// Returns a localhost endpoint forwarding over the mesh to `target`.
    async fn open_proxy(&self, target: MeshTarget) -> Result<LocalEndpoint, VpnError>;
    async fn close_proxy(&self, ep: &LocalEndpoint) -> Result<(), VpnError>;
}
```

- `NetbirdEngine` — `#[cfg(feature = "netbird-vpn")]`, wraps the vendored
  `netbird-embed` crate. The Go client handle is held in
  `tokio::Mutex<Option<Client>>`. **The crate's `Drop` calls Go `Stop()` which
  can block** → disconnect runs via `tokio::task::spawn_blocking`, and we call
  `stop()` explicitly rather than relying on `Drop`.
- `FakeMeshEngine` — always compiled (test + non-feature builds). `open_proxy`
  binds a real `127.0.0.1:0` TCP listener that echoes / forwards to a fixture, so
  command-layer and FE flows are exercisable end-to-end with no Go, no network,
  no VM.

### `VpnState` (new sub-state on `AppState`)
```rust
pub struct VpnState {
    engine: Arc<dyn MeshEngine>,                       // selected at startup
    proxies: Mutex<HashMap<VmConnKey, LocalEndpoint>>, // active per-VM forwards
    status: tokio::sync::watch::Sender<MeshStatus>,    // broadcast to FE via events
}
```
Held as `Arc<VpnState>` on `AppState` (mirrors `preparing` / `credits_exhausted`
sub-state pattern). Lock discipline: `proxies` mutex never held across an
`await` into the engine.

### Error strategy
Follow the typed-error taxonomy (`decision_2026_04_27_error_categories`; the
`wallet/` module is the in-repo exemplar — typed enum, `#[from]`,
`#[non_exhaustive]`, no `AppError::Other`):
- New `VpnError` enum (`#[non_exhaustive]`): `NotConfigured`, `NotConnected`,
  `AlreadyConnected`, `Enrollment(String)`, `Proxy(String)`, `Engine(String)`,
  `UnsupportedBuild` (returned when the `netbird-vpn` feature is off).
- Wire into `AppError` via `#[error(...)] Vpn(#[from] VpnError)` + a `kind()` arm.
- Add `NotReadyKind::VpnNotConnected` for the FE "you must connect first" gate,
  matched structurally like the existing `InsufficientCredits` pattern (never
  substring-matched).

## 4. Module layout — `src-tauri/src/vpn/`
- `mod.rs` — re-exports; `pub mod` declaration added to `main.rs`.
- `engine.rs` — `MeshEngine` trait + `MeshConfig`/`MeshTarget`/`MeshStatus`/`LocalEndpoint`.
- `netbird_engine.rs` — `#[cfg(feature = "netbird-vpn")]` real impl.
- `fake_engine.rs` — test/stub impl (always compiled).
- `state.rs` — `VpnState`.
- `config.rs` — resolve management URL + desktop-peer credential (see §7).
- `commands.rs` — IPC handlers.
- `events.rs` — event-name constants + payload structs (pinned like `sync/events.rs`).
- `error.rs` — `VpnError`.

## 5. IPC commands & events

### Commands (registered in `main.rs`, always present so the FE contract is stable)
| Command | Purpose | Feature off behavior |
|---|---|---|
| `vpn_status` | current `MeshStatus` (disconnected/connecting/connected/error) | returns `Disconnected` + `supported:false` |
| `vpn_connect` | join overlay as userspace peer | `Err(Vpn(UnsupportedBuild))` |
| `vpn_disconnect` | leave overlay; close all proxies | ok no-op |
| `vpn_open_vm_connection` | `(target) -> LocalEndpoint` via `start_proxy` | `Err(NotReady(VpnNotConnected))` |
| `vpn_close_vm_connection` | tear down one proxy | ok no-op |

Always-registered-with-typed-error keeps `app/lib/__tests__/ipcContract.test.ts`
green (move these out of `KNOWN_UNREGISTERED_COMMANDS`) and lets us land FE +
tests before the Go dependency is switched on.

### Events (via `app.emit`, reach every window incl. tray)
- `vpn_status_changed` `{ status }` — driven by the `watch` channel.
- `vpn_connection_ready` `{ vmId, endpoint }`.
- `vpn_error` `{ message, kind }`.

## 6. Feature gating & build pipeline

### Two independent gates
1. **Cargo feature `netbird-vpn`** (default **OFF**) — gates the Go/cgo engine
   and the ~50 MB linked lib. Default builds and existing CI are unaffected and
   need no Go. `NetbirdEngine` and its deps are entirely behind this.
2. **FE flag** — add `VM_VPN_ENABLED` to `app/lib/featureFlags.ts` (default
   `false`), gating the per-VM UI. Keep it independent of the legacy
   `VPN_FEATURE_ENABLED` (that gated the old whole-system Nebula menu — leave it
   alone / eventually retire it). UI also stays behind `VM_FEATURE_ENABLED`
   since VMs aren't live.

### CI
- Existing jobs: unchanged (feature off).
- New job `build-netbird` (`cargo build --features netbird-vpn`) on a runner
  with **Go 1.25** installed, so the engine path is kept compiling. Marked
  non-blocking until we commit to shipping it.
  - **Pin Go 1.25, NOT 1.26.** Verified 2026-06-29: Go 1.26 breaks the gvisor
    revision pinned by NetBird (`WaitReasonSelect redeclared` — gvisor's
    `runtime_constants_go125.go`/`_go126.go` both compile under 1.26). Build
    with `GOTOOLCHAIN=local` so Go doesn't auto-upgrade past 1.25. Lift the pin
    once NetBird's gvisor supports 1.26.
- Release/notarization (when shipping): sign the bundled `.dylib`/`.dll`; add
  `wintun.dll` is **not** needed (userspace mode, no TUN). Document the bundle
  size increase. Windows cgo cross-compile needs MinGW (`CC`).

### Vendoring
Fork/vendor `netbird-embed-rs` into `src-tauri/vendor/netbird-embed/` as a path
dependency (it is immature: 1★, v0.3, no releases). Pin the upstream NetBird Go
rev. We only need `new/start/stop/status/start_proxy` (userspace) — a small,
auditable surface we own. A wire-contract pin test guards the types we cross the
IPC boundary with, mirroring the `tests/hcfs_contract.rs` discipline.

## 7. Config / auth seam (stubbed until control plane is ready)

The desktop peer needs `{ management_url, credential }`. Sourcing options, in
priority order, resolved by `config.rs`:
1. **Hippius backend** (future) — an IPC/API that hands the desktop a
   setup-key/JWT + management URL for the user's tenant. *Not built yet.*
2. **Local config / env** (now) — for dev/testing against the self-hosted
   control plane with a manually-created setup key. Lets us validate the engine
   without any Hippius VM or backend work.

Design `config.rs` around a `resolve_mesh_config()` that tries (1) then (2), so
flipping to real backend auth later is a single implementation, no call-site
changes.

## 8. VM target seam (VMs not live)

`MeshTarget` carries the overlay address/peer identity that will come from the
VM API. Today `infra/vm.rs::VMInstance` already has `ip_addresses` + a flattened
`extra` map — the overlay IP (the `nebula_ip` successor) flows through there. The
FE already types `nebula_ip`. So:
- `vpn_open_vm_connection` takes an explicit `MeshTarget { address, port }`
  rather than reaching into VM state — decoupled from VM availability.
- For testing now: a dev affordance can target an **arbitrary manually-enrolled
  peer** (a test box on the overlay), proving the connect→proxy→reach path with
  zero VM dependency.
- When VMs land: the FE passes the VM's overlay address from the VM API; no
  backend change to the proxy path.
- **Bind to the peer identity Hippius registered, not a miner-claimed IP**; the
  embed API exposes `VerifySSHHostKey` for an extra SSH layer.

## 9. UI (FE)
- Per-VM **opt-in toggle + "Connect"** in VM instance details
  (`app/components/vm/instance-details/`), replacing/augmenting the `nebula_ip`
  row. Behind `VM_VPN_ENABLED && VM_FEATURE_ENABLED`.
- Connect → `invoke("vpn_open_vm_connection", target)` → show the localhost
  endpoint (copyable SSH command / open console).
- A small global status indicator fed by `vpn_status_changed` (optional, can
  mirror the old VPN menu styling that already exists under `vpn-menu/`).
- `useVpn` hook wrapping the IPCs + event listeners (thin; logic stays in Rust).

## 10. Testing strategy (without live VMs)
- **Unit (Rust):** `config.rs` resolution order; `VpnState` proxy registry
  transitions (open/close/idempotent close); error mapping; `MeshTarget`
  validation. Property test any pure parser/normalizer (e.g. endpoint/address
  parsing) per `rust_quality_111`.
- **Command-layer integration with `FakeMeshEngine`:** drive `vpn_connect` →
  `vpn_open_vm_connection` → connect a TCP client to the returned localhost
  endpoint → assert bytes round-trip through the fake. Exercises the whole IPC
  surface, no Go/network/VM.
- **Real-engine integration (opt-in, `#[ignore]`):** behind `--features
  netbird-vpn`, connect to the self-hosted control plane with a test setup key,
  `start_proxy` to a manually-enrolled peer, assert reachability. Run manually /
  in the dedicated CI job; never in the default suite.
- **FE:** add the commands to `ipcContract.test.ts`; unit-test the UI gating
  resolver and `useVpn` state transitions; consider a replay-style test for the
  status event stream.
- **External-edge probing (`rust_quality_110`):** the engine wraps a Go/cgo
  library — fixtures must cover connect-while-already-connected, proxy-before-
  connect, disconnect-with-open-proxies, double-close, and engine error
  surfacing.

## 11. Phasing
- **Phase 0 — Plumbing:** Cargo feature, vendored crate compiles, `build-netbird`
  CI job, `vpn/` module skeleton + `MeshEngine` trait + `FakeMeshEngine`,
  `VpnError`/`AppError` wiring. No real engine calls.
- **Phase 1 — Backend:** `VpnState` on `AppState`, IPC commands + events, config
  seam, full `FakeMeshEngine` command-layer tests. Commands registered, feature
  off → typed errors.
- **Phase 2 — Real engine:** `NetbirdEngine` behind the feature; opt-in
  integration test against self-hosted control plane + a test peer.
- **Phase 3 — FE:** `VM_VPN_ENABLED` flag, VM-view opt-in UI, `useVpn`, status
  indicator, ipcContract update.
- **Phase 4 — VM go-live:** wire real overlay target from VM API, end-to-end
  validation, flip flags. (Depends on Hippius backend control-plane
  orchestration — separate workstream.)

Phases 0–3 are fully deliverable now and leave the feature dormant (flags off)
but real and tested via the fake engine.

## 12. Open decisions
1. **Cargo feature default** — recommend OFF (no Go in default CI) with the
   dedicated build job. (Assumed in this plan.)
2. **Desktop-peer auth source** — confirm whether a Hippius backend endpoint
   will mint the desktop's setup-key/JWT, or whether the management URL + key are
   user-supplied. Affects only `config.rs` (seam already isolates it).
3. **Self-hosted control-plane availability for testing** — is there a reachable
   self-hosted NetBird instance + test setup key we can use for the Phase 2
   opt-in integration test?
4. **Vendoring vs own cgo bridge** — vendor the fork (faster) vs write a minimal
   cgo wrapper directly against `client/embed` (more control). Plan assumes
   vendor-the-fork.
