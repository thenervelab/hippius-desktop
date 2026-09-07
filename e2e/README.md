# macOS WebDriver E2E (sync widget smoke)

This directory is the **smoke** layer — "does the production webview paint
this?" New tests belong here only when a replay harness or unit test cannot
see the failure. Routing table: [`docs/testing-policy.md`](../docs/testing-policy.md).

On-device end-to-end smoke tests that drive the **real** app in a **real macOS
WKWebView** via [`tauri-plugin-webdriver`]. This is the layer the official
`tauri-driver` can't provide on macOS (Apple ships no WKWebView WebDriver); the
plugin works around that by embedding an in-process W3C WebDriver server in the
app process.

It complements — does not replace — the jsdom **replay harness**
(`app/(pages)/__tests__/syncWidgetReplay.*`), which is faster, runs on every
`pnpm test`, and already targets the recurring data-projection bugs. This layer
adds confidence that the production **renderer, CSS, and layout** show the right
thing in the actual webview.

The 2026-08-30 catalog (`docs/plans/2026-08-30-test-suite-audit.md`) found no
second renderer-only failure, so this directory stays at **one spec**. Add
another only when a unit or replay cannot see the bug; stabilize it locally
until it is boring before merging. Never add these to `ci.yml`. Run on macOS
before a UI-renderer change.

## Safety: never ships in production

The plugin exposes **unauthenticated automation over localhost HTTP**. It is
compiled in only under the **off-by-default** Cargo feature `e2e-webdriver`
(`src-tauri/Cargo.toml`), registered behind `#[cfg(feature = "e2e-webdriver")]`
in `main.rs`. A normal `tauri build` / `pnpm tauri:build` enables no features,
so the server can never reach a release artifact. Verified: `cargo tree -i
tauri-plugin-webdriver` finds nothing in the default graph; it only appears with
`--features e2e-webdriver`.

Likewise the frontend driving bridge (`window.__e2ePushSyncFrame` on the
`/e2e/sync-widget` route) installs only when the app is built with
`NEXT_PUBLIC_E2E=1`.

## How it works

1. `app/e2e/sync-widget/page.tsx` mounts the real `SyncStatusHandler` →
   `SyncStatusDialog` and exposes `window.__e2ePushSyncFrame(frame)` — a
   backend-free way to push `SyncSnapshot` frames into the widget. No login,
   funded account, or live hcfs-server needed.
2. `wdio.conf.ts` does two things in `onPrepare`: it launches the feature-built
   debug binary (for the WebDriver server on `127.0.0.1:4445`) **and** starts a
   tiny static server (`127.0.0.1:3101`) for the `out/` export. The plugin gives
   the automation session its own webview, and a raw `cargo build` debug binary
   does **not** serve the app's embedded `tauri://` assets (Tauri debug builds
   expect a dev server) — so the spec navigates that webview to the **HTTP**
   harness page instead. The harness needs no Tauri IPC, so HTTP is sufficient.
3. `e2e/specs/syncWidget.e2e.ts` pushes a mid-transfer frame then a completion
   frame, asserting the same display invariants the replay harness checks — but
   against the real WKWebView: non-zero "transferred/total" at 16% (the
   "0B / 16%" screenshot can't recur), then 100% + "Complete".

## Run it (macOS, GUI session required)

```bash
pnpm install                 # installs the @wdio/* + webdriverio devDeps
pnpm e2e:build               # NEXT_PUBLIC_E2E=1 next build  +  cargo build --features e2e-webdriver
pnpm e2e                     # serves out/, launches the app, runs the WDIO smoke spec
```

Verified green on macOS (`webkit` WKWebView session): both the mid-transfer and
completion assertions pass against the real renderer.

## Troubleshooting

- **`element ("[data-testid=...]") still not displayed`** → use `waitForExist` +
  `toHaveText`, not `waitForDisplayed`. This plugin's `isDisplayed` is unreliable
  even when the element is rendered with visible text.
- **`waitForPort` times out** → another Hippius instance is already running; the
  single-instance plugin forwards the launch and the new process exits without
  binding `4445`. Quit the running app first.
- **`asset not found` in the webview** → expected if you navigate to a `tauri://`
  URL; the harness is served over HTTP precisely because the debug binary doesn't
  serve embedded assets. Navigate to the `http://127.0.0.1:3101` baseUrl instead.

## Config knobs

- **Binary path** (`wdio.conf.ts` `APP_BINARY`) — `target/debug/Hippius` for the
  package name `Hippius`.
- **Ports** — WebDriver `4445` (plugin default), static server `3101`.
- **Capabilities** — `{}` (the plugin accepts but does not process them).

[`tauri-plugin-webdriver`]: https://github.com/Choochmeque/tauri-plugin-webdriver
