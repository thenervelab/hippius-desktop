# Testing policy

Hippius Desktop is a Tauri app: Rust owns business logic, the frontend is UI,
and there is no type codegen across IPC. Tests follow that split.

A new test goes in the **lowest layer that can fail for the same reason a user
would notice**. A failure at a higher layer is a missing lower-level test —
add or fix that first, then keep the higher layer as smoke.

Suite inventory, live-lane env, replay harnesses, and wire-pin tables live in
[`.claude/rules/testing.md`](../.claude/rules/testing.md). The 2026-08-30
catalog of every current test (keep / gap / skip) is
[`docs/plans/2026-08-30-test-suite-audit.md`](plans/2026-08-30-test-suite-audit.md).
This file is only the routing rule.

## Routing (first match wins)

| If the thing under test is… | Put it here | Gate |
| --- | --- | --- |
| Signing, notarization, Finder `.appex` embed, updater `.sig`, `latest.json` keys | Release verify (`macos/verify-macos-artifacts.sh`, `scripts/verify-release-manifest.sh`) | Release workflows, before publish on `main`/`beta` |
| How a **live** `hcfs-server` / `hcfs-client` actually behaves (status codes, revocation, real ciphertext, billing 402) | `src-tauri/tests/*_real_backend.rs` (`#[ignore]`) | `e2e-live.yml` — **not** a required check; **must** run on every hcfs pin bump |
| Domain rules, IPC inners, SQLite, mock-HTTP *client* shapes, source/wiring pins, crypto KATs | `cargo test` (in-module or `src-tauri/tests/`) | `ci.yml` rust jobs — required |
| An `hcfs-client` type that crosses `invoke` / `app.emit` | Wire-contract pin next to the crossing site; KATs in `tests/hcfs_contract.rs` | Same rust job |
| Stateful frontend projection over a **stream** of snapshots/events | Replay harness (`syncWidgetReplay`, `uploadFeedReplay`) | `pnpm test:coverage` — required |
| Pure UI: classifiers, formatters, gating, a component with mocked `invoke` | Vitest next to the code (`__tests__/`, `*.test.ts(x)`) | `pnpm test:coverage` — required |
| "Does the **production webview** paint this?" | `e2e/` WebdriverIO, Cargo feature `e2e-webdriver` | Local / manual; never in a release binary |
| Finder Sync, tray, TCC, dogfood of a packaged `.app` | [`docs/release-checklist.md`](release-checklist.md) | Human, on the freeze |

A Rust test that touches `$HOME` takes `crate::test_helpers::HOME_LOCK`.

## Mocks vs live

Mocks are allowed only for **this client's** behavior: retry ladders, concurrency
windows, the wire shape of *our* request, a frontend listening to a fixture
event.

They are not coverage for **the service**: endpoint semantics, conflict/OCC,
revocation, sealed-blob decrypt against real ciphertext. That belongs in
`*_real_backend.rs`. Hermetic HTTP doubles are named `*_server_mock.rs`. Live
suites are named `*_real_backend.rs` and stay `#[ignore]` so a plain
`cargo test` remains hermetic.

## What not to do

- Do not put eligibility, path validation, credit math, or sync rules in
  TypeScript tests. Rust owns them; the frontend calls IPC.
- Do not grow `e2e/` to cover a bug a replay or unit test can catch. WDIO is a
  handful of smokes (today: the sync-widget renderer). Stabilize a smoke until
  it is boring before adding another.
- Do not drive Finder, the tray, or TCC from WebdriverIO. Wrong process.
- Do not compile `e2e-webdriver` into a release build. The plugin is an
  unauthenticated localhost automation server.
- Do not make `e2e-live` a required GitHub check. A red live run can mean "the
  server is down"; that must not block unrelated PRs.
- Do not treat a green `pnpm test` as proof the packaged Mac app works.

## When a higher-level test fails

Reproduce at the lowest layer that sees it, land that test, then leave or shrink
the higher one. Example: widget "0B / 16%" → replay invariant `BYTE_SOURCE`, not
a new WDIO spec.

## Flakes

A new test that is not hermetic (live, WDIO, anything talking to disk/OS without
a lock) is the author's until it is boring. Do not retry-to-green in CI.
Quarantine (`#[ignore]` plus a comment naming the owner and the missing seam)
rather than delete. A silent skip on the live lane is forbidden: the workflow
sets `HCFS_DESKTOP_E2E_REQUIRE=1` so a missing secret panics instead of
shipping a bump untested.

## Commands

```bash
pnpm test:coverage           # Vitest + coverage floors (what CI runs)
cd src-tauri && cargo test   # hermetic Rust (live suites skip)
gh workflow run e2e-live.yml --ref <branch> -f suite=both   # every hcfs pin bump
pnpm e2e:build && pnpm e2e   # macOS WDIO smoke; needs a GUI session
```
