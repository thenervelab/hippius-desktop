# Hippius Desktop — Full Code Audit (`redesign` branch)

**Audited at:** `redesign` @ `50dea5f2` (pulled 2026-06-22)
**Scope:** Full Rust backend (`src-tauri/`, ~47k LOC) + TypeScript frontend (`app/`, ~94k LOC) — quality, correctness, security, bugs, and TS-logic-that-belongs-in-Rust.
**Severity tally:** 16 High · 20 Medium · ~27 Low · 1 Info.

---

## ✅ Remediation status (branch `fix/audit-remediation`, 11 commits)

All findings except **H-1** (accepted) and the **bridge port (H-8 Part B / bridge logic-placement)** are fixed and verified (backend `clippy --lib --bins` clean; FE `tsc` at baseline; touched tests pass). Done: PR #13 folded in (H-7/H-8a/H-9/H-10/H-15/M-1/M-3/M-10/M-CRYPTO-1); H-2/3/4/5/6/13/16, H-11, H-12; M-2/4/5/7/8/11/13/14/15/16/17, INFO-1, L-NET-1, NOTIF-1/2/3; RB-3/RB-4.
- **Documented, not code-changed (with reason):** H-1 + M-18 (console/server `state` blocker); M-9 (INDEXER_API_KEY is runtime-read from the bundled resource → server-side key scoping, architectural); RB-1 (default-on binding = product/ADR decision); RB-2 (needs a server read-only existence endpoint).
- **Low-severity items now ALSO fixed (no longer deferred):** NOTIF-4 (credit-notification flags moved to a per-account `credit_notification_flags` table); tray rect-validation (sanitize/clamp the FE-supplied `TrayIconRect`, reset the dismiss timestamp on open); and the three FE-lows (getHcfsConfig failure no longer misroutes to password setup; SubscriptionPlansSection empty catch now logs; splash-screen setup effect gets a cancellation guard + timer cleanup). The two bridge follow-ups are also done: `deposit_request_id` extraction (via the `deposit_nonce` → `get_deposit_request_id_by_nonce` read) and the explorer's Bittensor `bittensor_side` contract cross-ref (via the new `query_contract<T>`). Only the testnet smoke-test of the on-chain bridge paths remains (hardware-gated, not code).
- **Needs reviewer smoke-test (can't be unit-verified):** H-13 tray-panel capability scoping; M-11 entitlements (signed+notarized launch); M-14 re-auth toast flow; the wallet funds paths from #13.
- **Bridge → Rust port (H-8 Part B): COMPLETE.** New `blockchain/bridge/` module (subxt codegen for both chains; conversion/fee math; chain-correct ink! error decode; two-chain client; **deposit + withdraw** write paths; **balances, staked-hotkeys, on-chain explorer, and status-derivation** reads; a Rust-SQLite `bridge_transactions` history table replacing the localStorage tracker) — all compile-verified, every pure part unit-tested. The FE `useBridge` + `BridgeTransactionHistoryTable` now `invoke` the Rust commands; **`local_wallet_sign` (the blind-sign command) is deleted** (H-8's root closed); and **`app/lib/bridge/{service,explorer-api,local-cache,signer}.ts` + the polkadot-api deps are removed** — no bridge domain logic or chain access remains in the renderer. ⚠️ The on-chain paths (both write directions + the explorer storage decode) are compile-verified only and MUST be smoke-tested on a funded Bittensor/Hippius testnet wallet before release (see `bridge/DEPOSIT_PORT_NOTES.md`). Two documented follow-ups (non-blocking): the `deposit_request_id` ink!-topic extraction and the explorer's Bittensor contract cross-ref (`bittensorSide` enrichment) — both best-effort/tracking-only in the original TS.

---

## ⚠️ Reconciliation note — READ FIRST

Two prior audits exist; here is the **corrected** branch reality (verified 2026-06-22):

1. **Sync-engine security/logic audit** (`~/Downloads/AUDIT_MASTER_2026-06-04.md`, IDs `M*`/`SC*`/`D*`/`AR*`). The `sync-engine` branch (HEAD `204a1fd3`) is an **ancestor of `redesign`** — fully contained, nothing to re-merge. Only the ~13 findings it actually *fixed* (e.g. M6 staking, M7 is_paused) are in redesign, and those are **not** in this report. The `M*/SC*/D*/AR*` items tagged below were that audit's **never-actioned tail** — they have **no existing fix on any branch** and must be implemented fresh (H-5/M10, H-11/D1, H-12/SC3, H-16/SC1, M-9/SC2, H-10/AR1).
2. **Wallet security audit** (`WALLET_AUDIT_RECONCILED.md`, IDs `R-NN`). Reviewed fixes live on PR **#13** (`fix/wallet-audit-remediation`), still **OPEN — not merged**, and now **179 commits behind `redesign`** (`mergeable: UNKNOWN`, plus its own blockers: hcfs PR #201 + reviewer smoke tests). Its 24 commits cover the wallet class: **H-7, H-8 (Part A only — fs-scope, not the blind-sign), H-9, H-10 (R-17 chmod), H-15, M-1, M-3, M-10, M-CRYPTO-1 (R-04)**, plus extras (R-07 export gate, R-28 vectors, etc.). Verified absent on `redesign`: `sign_submit_track`, AEAD AAD, `reject_cross_network`, `recovery_lock`, the export password gate.

**Consequence:** most previously-documented findings are **LIVE** on `redesign`. Each finding is tagged:

- **`LIVE (prior-ID)`** — already documented in a prior audit; re-confirmed present at this HEAD. Fix exists on an unmerged branch.
- **`NEW`** — not in either prior audit (or materially expanded here).

If `redesign` is the release target, **merging PR #13 and re-merging the `sync-engine` audit fixes is the single highest-leverage action** — it closes the majority of the High findings below at once.

---

## Executive summary

In absolute terms the codebase is **well-engineered**: crypto-at-rest (Argon2id + ChaCha20-Poly1305 with per-account HKDF key separation), the per-drive sync epoch/commit-lock race model, owner-scoped SQL via the `SessionAccount` newtype, string/u128 money math, and the recent release code (translocation guard, sync-widget retention, `error_notify.rs`, the recovery-binding feature) are all sound and well-tested. The risk concentrates in **trust boundaries that the unmerged fix branches were built to close**, plus a cluster of **genuinely new issues**.

**Top items worth immediate attention regardless of the PR #13 merge (all NEW):**

- **H-3** — `delete_files` falls back to the *default* drive when an explicit label is missing → recursive deletion of a same-named file/folder in the **wrong drive**. (data-loss)
- **H-4** — `allow_asset_scope` is an unauthenticated IPC that grants recursive `asset://` read of **any** directory the renderer names.
- **H-6** — a migration `custom_sync_path` whose basename collides with an existing drive silently binds to the wrong folder/baseline. (data-loss)
- **H-13** — the isolated tray-panel webview inherits `opener:allow-open-path /**/*` and `fs:read $HOME/**`.
- **H-14** — the OAuth callback URL (carrying the JWT) is written to `localStorage` and **deliberately never cleared on logout**.
- **M-CRYPTO-1** — `migrate_if_needed` re-encrypts *other* accounts' drive passwords under the current account's key (cross-account corruption + secret exposure).
- **M-13** — `e instanceof Error ? e.message : String(e)` at ~27 sites drops every IPC error message, so money/upload errors render `[object Object]`.

---

## Methodology & verification

This audit ran as **8 parallel subsystem agents** (Read/Grep — illu MCP was not connected this session), followed by **five hands-on verification passes (no agents)** that read every meaningful module line-by-line and reconciled against the two prior audit deliverables.

- **All 16 High findings were personally line-verified at HEAD and confirmed accurate** (evidence cited inline per finding).
- The hands-on passes added **M-CRYPTO-1**, **L-NET-1**, and **INFO-1**, and refined **H-13** (the `opener` grant carries an `"ask"` prompt — a partial mitigation — but the `fs:read $HOME/**` grant has none, so silent whole-`$HOME` read is the sharper half) and **M-6** (`get_tray_menu_data` fetches credits only for an active session; logged-out it returns the persisted SS58 for display only — a minimal own-address exposure, not a credit leak).
- Passes 4 and 5 yielded only INFO-1 plus clean confirmations, so the **static audit surface is essentially exhausted**.
- **Not independently re-run:** the full `cargo audit`/`cargo deny` dependency-CVE scan (only `rustls-webpki` was checked by hand — H-11) and any runtime/dynamic testing of the funds + recovery flows. These are the highest-value remaining (non-static) steps.

---

## HIGH

### H-1 · OAuth deep-link token injection + stateless CSRF fallback — `LIVE (M1/M2, R-02)` · ⏸️ ACCEPTED / WON'T-FIX (for now)
> **Decision (2026-06-22):** intentional, left as-is for now — the console bridge currently drops the `state` param, so the stateless fallback is load-bearing for OAuth login until that's fixed upstream (server token-verify endpoint + console `state` propagation). Re-open when the server side lands.
>
> **Risk acceptance (2026-06-23):** confirmed deferred after review. The residual risk is narrow: the *cold* deep-link injection is already blocked — `complete_oauth_flow` accepts a stateless (no-`state`) callback ONLY when exactly one OAuth flow is pending (`oauth.rs:194`), so an idle victim's `hippiusapp://auth/callback?token=…` is rejected outright; the attack requires the user to be **mid-login** (one pending flow) AND the attacker to supply a server-valid token. A *forged* token only produces a broken session (the server rejects every subsequent API call). The one genuinely harmful variant — an attacker's **own valid** token+address making the victim operate inside the attacker's account — is racy, targeted, and visibly wrong (different account/address shown). Closure is cross-team and tracked (not blocking this release):
> 1. **Console**: deliver an authorization `code` (already verified via `/api/auth/exchange/`) instead of a pre-minted `token` → desktop then **deletes** the unverified `token` branch.
> 2. **Console**: forward the `state` CSRF param verbatim in the callback → desktop requires `state` unconditionally and **drops** the single-pending-flow fallback.
> 3. **Desktop** (the only unilateral mitigation): add a user-consent prompt before activating a deep-link-initiated session — closes the attacker's-own-valid-token variant without server changes.

`auth/oauth.rs:393-401` consumes the sole pending PKCE state when the callback carries **no `state`** (CSRF defeat); `:414-421` persists a deep-link-supplied `token`/`substrate_address`/`email` **with no server-side exchange or verification**, then activates the session (`:477-507`). The `code` branch *does* round-trip `/api/auth/exchange/`; only the `token` branch is unverified. A crafted `hippiusapp://auth/callback?token=…` deep link can seed an arbitrary identity + bearer token. **Fix (deferred):** require a matching `state` unconditionally; verify any direct token against the server before persisting. *(Confidence: High — verified)*

### H-2 · Session-restore IDOR — trusts FE `substrateAddress`, echoes FE token — `NEW`
`auth/session_restore.rs:263-313` takes `substrateAddress` from FE localStorage and validates only that *some* non-expired token row exists for that address (never that the FE token equals the DB token); `:352` activates that account via `set_active_account`; `:450` returns the FE's own session JSON (incl. its token) verbatim. A tampered renderer can invoke `restore_session` naming any locally-persisted address → cross-account escalation on a multi-account install. **Fix:** resolve and use the DB token for the address; never echo unverified FE session JSON as authoritative. *(Confidence: High — verified)*

### H-3 · `delete_files` wrong-drive recursive delete — `NEW` · data-loss
`sync/files.rs:579-599`: `effective_label = file.label.unwrap_or("default")`, then `label_to_path.get(label).or(default_path)`. When the FE supplies an **explicit** label whose `sync_paths` row no longer exists (drive removed/renamed), the delete retargets to the **default** drive; `ensure_within` validates against that wrong-but-valid root and `remove_dir_all` recursively deletes a same-named entry there. `resolve_rename_root` was specifically fixed to remove exactly this fallback (the comment at `files.rs:797-802` acknowledges delete still carries it). **Fix:** mirror rename — if an explicit label is absent from `label_to_path`, push a `FileDeleteError` and skip; never fall through to `"default"`. *(Confidence: High — verified)*

### H-4 · `allow_asset_scope` — unauthenticated arbitrary-directory read grant — `NEW`
`sync/files.rs:43-47`: the IPC calls `allow_directory(dir, true)` for **any** FE path with no session check and no validation that it's a registered sync path (only `exists()`). A compromised/buggy renderer can `allow_asset_scope("/")` then read any file via `asset://localhost/…`, defeating the `$HOME/.hippius/**` capability scope. **Fix:** verify the path matches a `sync_paths.path` row for the active account (the pattern `export_file` already uses), or remove the command and grant scope only inside `set_sync_path`/`initialize_sync_inner`. *(Confidence: High — verified)*

### H-5 · SSRF + bearer-token exfiltration via `save_hcfs_config` — `LIVE (M10)`
`sync/config.rs:90-132` persists an FE-supplied `server_url` with no scheme/host validation; it becomes `HcfsClientConfig.base_url` and the account's API bearer token is attached as a header on every request (`remote.rs:84-91`). A repointed config exfiltrates the live token to an attacker host / drives SSRF. **Fix:** parse + require `https` (allow `http://localhost` only in debug), ideally allowlist `*-arion.hippius.com` + explicit self-host opt-in. *(Confidence: High — verified)*

### H-6 · Migration label collision → wrong folder/baseline — `NEW` · data-loss
`sync/migration.rs:530` derives the migration drive label from the basename of `custom_sync_path`; `:560-565`: if that label already exists, `complete_migration_transition` only `warn!`s and proceeds against the **existing** drive's path + its `sync_state.json` baseline (`folder_hash`/`derive_folder_mnemonic` are label-keyed). Migrated files reconcile against another drive's tree → possible `local_deletes`/re-uploads; the chosen destination is silently discarded. **Fix:** reject (or numeric-suffix disambiguate) when the derived label exists but a differing path was supplied. *(Confidence: High — verified)*

### H-7 · No genesis-hash / chain-identity pinning on RPC connect — `LIVE (R-11)`
`blockchain/client.rs:94-111,262-286`: the client trusts whatever `wss_endpoint` is stored (user-settable) with no `genesis_hash()` check. Transfers are signature-replay-safe, but **the entire displayed financial state is attacker-controlled** (inflated balances to coax transfers; testnet silently presented as mainnet). **Fix:** compare `client.genesis_hash()` to a compiled-in expected genesis (known: `0x28a6b54823f786c5dd8520ef7bdb0ee2639173815bfbb7719bcf58ef9eb5e1f9`), exempt loopback dev nodes. *(Confidence: High — verified)*

### H-8 · Bridge blind-signs an opaque FE-constructed payload — `LIVE (R-03)` · also logic-placement
`wallet/commands.rs:636-682` (`local_wallet_sign`) signs whatever bytes the renderer sends after only a password + rate-limit check (`:680` `keypair.sign(&payload)`); the **entire bridge extrinsic + signing payload is built in JS** via polkadot-api (`app/lib/bridge/`). Rust signs without decoding recipient/amount/call. A compromised renderer → user's key signs an attacker's extrinsic. **Fix:** build + validate the bridge extrinsic in Rust (as transfers/staking already are), or decode + display the SCALE call before signing. See also the bridge logic-placement item under LOW. *(Confidence: High — verified)*

### H-9 · No idempotency / double-submit guard on transfers + staking — `LIVE (R-01)`
`blockchain/transfers.rs:75-83` and all four `blockchain/staking.rs` submit commands independently call `sign_and_submit_then_watch_default`; subxt fetches a fresh nonce per call, so a double-invoke (double-click / FE retry) broadcasts two distinct valid extrinsics = **double-spend**. **Fix:** per-account in-flight guard keyed on the operation (the `sign_submit_track` fix is on the unmerged PR #13). *(Confidence: High — verified)*

### H-10 · Secrets SQLite DB + `~/.hippius` created world-readable — `LIVE (AR1)`
`main.rs:760,776` + `:587-596`: `~/.hippius` via `create_dir_all` (~`0755`), `hippius.db`/`-wal`/`-shm` at `0644` (no chmod anywhere in the crate except the `recovery.rs` mnemonic sidecars). The DB holds API/S3 tokens, `auth_session.auth_token`, `hcfs_config.drive_password`, `local_wallets.encrypted_mnemonic`/`password_hash`, and share keys. Any local user / world-readable backup can read live tokens + encrypted wallet blobs. This also falsifies the share-keystore's "encrypted DB is the trust boundary" comment (`shares/keystore.rs:99-106`) — the DB is neither encrypted nor perm-restricted. **Fix:** `#[cfg(unix)]` chmod dir `0700` before DB creation and the DB files `0600` after pool open. *(Confidence: High — verified)*

### H-11 · `rustls-webpki 0.103.10` — TLS cert-path DoS (CVE fix is 0.103.13) — `LIVE (D1)`
`Cargo.lock` pins `0.103.10`, in the live TLS path (reqwest + updater). A crafted/MITM'd cert chain triggers algorithmic CPU DoS. **Fix:** `cargo update -p rustls-webpki` to ≥0.103.13; add `cargo-deny`/`cargo-audit` to `ci.yml`. *(Confidence: High — version verified; CVE attribution from the prior audit. The full `cargo audit` was not re-run.)*

### H-12 · Release builds auto-publish signed/notarized updates on push to `main` — `LIVE (SC3)`
`.github/workflows/tauri-build.yml:5-6,288-290`: `push: [main]` → `tauri-action@v0` with `releaseDraft:false`, `prerelease:false`, `overwrite:true`, signing + notarization secrets; the auto-updater serves `releases/latest` to the whole fleet. A single bad commit to `main` ships a signed auto-installed update. Pubkey pinning doesn't help — the legitimate key is applied automatically. **Fix:** trigger on `tags: ['v*']`/`workflow_dispatch`, set `releaseDraft:true`, protect `main`. *(Confidence: High — verified)*

### H-13 · Tray-panel webview inherits full capability set (`opener /**/*` + `fs $HOME/**`) — `NEW`
`capabilities/default.json:5,14-25`: `windows: ["main","tray-panel"]`, and the popover gets `opener:allow-open-path` over `/**/*` recursive, `fs:allow-read-file` over `$HOME/**`, `process:allow-restart`, etc. The popover renders remote-derived data; any injection there = full-app blast radius. The `opener` grant carries an `"ask"` user prompt (a partial mitigation against silent file-open), but `fs:read $HOME/**` has **no** prompt — silent whole-`$HOME` read by either window is the sharper half. **Fix:** dedicated `tray-panel.json` capability scoped to the few commands/events it uses; remove `tray-panel` from `default.json`; narrow `opener` from `/**/*` to sync roots. *(Confidence: High — verified)*

### H-14 · OAuth JWT persisted in cleartext localStorage; token-bearing URL never cleared — `NEW`
`wallet-auth-context.tsx:530-531,276-281`: the full `OAuthSession` incl. the API bearer JWT is `JSON.stringify`'d into `localStorage["hippius_oauth_session"]`. Worse — `LoginForm.tsx:184` writes the **entire OAuth callback URL** (which carries `token` as a query param, confirmed `auth/callback/page.tsx:72`) into `localStorage["last_processed_deep_link"]`, a key **intentionally never cleared on logout**. A full bearer token sits on disk in cleartext indefinitely, surviving logout. **Fix:** keep the token in Rust (keychain/encrypted DB); dedup on the non-secret `state` nonce; strip `token`/`code` before storing; clear on logout. *(Confidence: High — verified)*

### H-15 · Plaintext fallback API token survives logout — `LIVE (R-05/R-30, partial)`
`auth/tokens.rs:62-74` writes the bearer token in plaintext to `objectstore_auth_scoped.temp_auth_key` on keychain-less platforms; logout (`auth/logout.rs:30` → `auth_session_repo::clear`) nulls `auth_session.auth_token` but never that column, and `get_api_token` still resolves it (no `clear_api_token` exists on this branch). A live 30-day token persists post-logout on exactly the platforms with the weakest at-rest protection. **Fix:** NULL `objectstore_auth_scoped.temp_auth_key` (keyed by raw SS58) in the logout clear path. *(Confidence: High — verified)*

### H-16 · Mutable action tags in release workflows holding signing secrets — `LIVE (SC1)`
`tauri-build.yml`/`tauri-dev.yml` use `actions/checkout@v4`, `tauri-apps/tauri-action@v0`, `dtolnay/rust-toolchain@stable`, etc. (mutable tags) in the jobs holding `TAURI_SIGNING_PRIVATE_KEY` + Apple secrets. A retagged/compromised upstream action can exfiltrate the signing key. (`ci.yml`/`hcfs-bump.yml` correctly pin by SHA — mirror that.) **Fix:** pin all release-workflow actions by full commit SHA. *(Confidence: High — verified)*

---

## MEDIUM

### Backend
- **M-1 · `ws://` cleartext RPC accepted — `LIVE (M11/R-11)`.** `blockchain/client.rs:240-245,262-268` + `runtime.rs:71-81` accept `ws://` for the custom endpoint; cleartext, MITM-modifiable (compounds H-7). CSP doesn't help — the RPC connects from Rust, not the webview. **Fix:** `wss://` only, except `localhost`.
- **M-2 · First recovery password has no strength check — `NEW`.** `recovery.rs:637-709` (`seal_and_upload_mnemonic`) sets the *first* password protecting the master-mnemonic server blob with no `reject_if_weak`/non-empty check, unlike `change_recovery_password` (`:735`). Direct-IPC bypass → empty/trivial password on the offline-brute-forceable blob. **Fix:** call `reject_if_weak` at the top.
- **M-3 · `transfer_balance` doesn't re-validate amount/recipient — `LIVE (R-29)`.** `blockchain/transfers.rs:52-90` relies on a separate `validate_send_balance` IPC (TOCTOU; direct-IPC submits a zero-amount/unvalidated transfer, wasting a fee). **Fix:** re-run the cheap guards inline.
- **M-4 · `setup_and_init_sync` skips the credit-eligibility gate — `NEW`.** `sync/lifecycle.rs:82` has no `require_eligible(FolderSync)`, unlike the sibling `add_local_sync_folder:141`; relies on the documented fail-open pre-init balance check (`lifecycle.rs:1063-1086`, backstopped by the per-file 402). A zero-credit user can kick off a large first-sync upload. Inconsistent enforcement, not a hard bypass. **Fix:** add the same gate.
- **M-5 · Ownerless legacy token adopted by arbitrary caller — `NEW`.** `auth/tokens.rs:141-159`: on a cold miss `get_api_token` migrates the single global legacy `objectstore_auth` row (`WHERE id = AUTH_ROW_ID`) into whatever account calls first → cross-account token adoption (bounded to legacy-data installs). **Fix:** don't blind-migrate the ownerless row.
- **M-6 · `toggle_tray_panel` has no backend auth check — `NEW`.** `tray/panel.rs:97-148`: the signed-in gate is FE-only. Verified the popover's data commands withhold sensitive data when logged out (`get_tray_menu_data` returns only the persisted SS58 for display, no credits), so the residual exposure is minimal — but the window-show itself has no backend gate. **Fix:** keep the FE UX gate; ensure all popover data commands enforce auth.
- **M-7 · `share_keystore` has no owner column — `NEW`.** `shares/commands.rs:528-586`, schema `utils/schema.rs:796-807`: the keystore is keyed by `share_token` only (the `share_origin` sidecar has `owner`; the keystore does not). `hcfs_revoke_share`/`reshare` act on an FE-supplied token without proving ownership → cross-account local DoS (clobber a co-resident account's share key). **Fix:** add an `owner` column, scope by `account_key`.
- **M-8 · Support-log redactor misses JSON/quoted secret forms — `NEW`.** `utils/logs.rs:65-69`: the labeled-secret regex requires the key immediately followed by `:`/`=`; `{"password":"…"}` / `{"apiKey":"…"}` bypass it (reproduced). Latent (no secret is logged today). **Fix:** allow an optional quote before the delimiter; add JSON regression tests.
- **M-CRYPTO-1 · `migrate_if_needed` re-encrypts OTHER accounts' drive passwords under the current account's key — `LIVE (R-04)` · data-loss + cross-account secret exposure.** `crypto/store.rs:134-152` selects **all** `hcfs_config` rows with `encryption_version = 0` with **no owner filter** and encrypts each under `derive_key(current_mnemonic, current_account_id, …)`. It runs on every login/restore (`login.rs:131`, `session_restore.rs:345,581`). The in-code "single-user assumption" comment (`:119-125`) is contradicted by the schema — `hcfs_config.owner` is `UNIQUE` (per-account), and `save_hcfs_config` writes `encryption_version = 0` plaintext whenever the mnemonic isn't loaded (`config.rs:109`). **Reachable path:** account B has a version-0 `hcfs_config` row → account A logs in → A's `migrate_if_needed` encrypts B's `drive_password` under A's key. B can no longer decrypt it (drive won't auto-unlock → lockout, recoverable only by re-entering the recovery password), and because `drive_password` mirrors the recovery password, a password-equivalent secret is silently re-encrypted into a form readable by A. The safe pattern exists next door — `auth/contacts.rs::claim_legacy_contacts` self-limits to `owner = ''` rows so it can never clobber another account's data, whereas `migrate_if_needed` filters on *no* owner at all. **Fix:** scope the `SELECT`/`UPDATE` with `AND owner = ?` keyed by `account_key(account_id)` (the one-line R-04 fix on the unmerged PR #13). *(Confidence: High — verified)*

### Config / supply-chain
- **M-9 · `INDEXER_API_KEY` bundled into the shipped app — `LIVE (SC2)`.** `tauri.conf.json:84` ships `.env` as a bundle resource; the key is extractable from every distributed build. **Fix:** treat as public + scope server-side, or proxy indexer calls through a backend.
- **M-10 · CSP `'unsafe-inline'` on script-src — `LIVE (R-31)`.** `tauri.conf.json:57-58` (needed by the boot theme script; `unsafe-eval` is NOT present, and `connect-src` is well-scoped to named `wss`/`https` hosts). Removes the primary XSS mitigation; compounds H-13. **Fix:** move the boot script to a hashed `'sha256-…'` CSP entry, drop `'unsafe-inline'`.
- **M-11 · macOS entitlements broaden attack surface — `NEW`.** `entitlements.plist`: `cs.disable-library-validation` + `cs.allow-unsigned-executable-memory`, `app-sandbox=false`. Lets the notarized process load unsigned dylibs. **Fix:** remove unless a framework requires them.
- **M-12 · `ci.yml` exposes repo secrets to same-repo PR branches — `NEW`.** `.github/workflows/ci.yml:10-13`: `pull_request` + `HCFS_DEPLOY_KEY_B64`/`TAURI_ENV_FILE`. Fork PRs are safe (no secrets by default), but same-repo branches run arbitrary changed code with secret access. Acceptable for a trusted-team private repo; gate behind an `environment` if external contributors are ever in scope.

### Frontend
- **M-13 · `instanceof Error ? e.message : String(e)` drops every IPC error (~27 sites) — `NEW`.** Tauri `invoke()` rejects with `{kind,message}`, not an `Error`, so money/upload/download toasts render `"… failed: [object Object]"`. The repo already has `errorMessage()` (`app/lib/utils/errorUtils.ts:7`) for exactly this. 25 sites use the `String(e)` form; the new `RecoverAccountDialog.tsx:119,149` adds two more (so the backend's specific recovery messages — "feature disabled", auth failure — never reach the user). **Fix:** replace all sites with `errorMessage(e)`. *(Confidence: High — verified)*
- **M-14 · `dispatchSigningError` exists + tested but wired into zero money flows — `NEW`.** `dispatchTauriError.ts:94` detects `NotReady(SIGNING_KEY_UNAVAILABLE)` and offers re-auth; grep confirms no production caller. Staking/transfer catches show a generic (and, per M-13, `[object Object]`) toast with no recovery path. **Fix:** wrap each money-flow catch with it.
- **M-15 · Folder upload ignores structured `INSUFFICIENT_CREDITS`; premature success toast — `NEW`.** `upload-files-flow/index.tsx:363-371` + `FolderUploadDialog.tsx:243-247,213`: the folder path doesn't `isNotReady(err,"INSUFFICIENT_CREDITS")` (the root path does), and a `toast.success` fires before `add_folder` is awaited. **Fix:** add the structured check; move success after the IPC resolves.
- **M-16 · Credits card renders "0" on query error — `NEW`.** `home/available-credits/index.tsx:100,106,113`: gates only on `isLoading`; on `isError`, `credits?.hip ?? "0"` shows a real-looking **0 HIP**. **Fix:** read `isError`, render a distinct "—"/error state.
- **M-17 · Referral generation via raw `fetch()` bypassing IPC — `NEW` · logic-placement.** `referrals/index.tsx:129-137` POSTs the user's address directly; the *read* side (`get_referral_links`) is already a Rust IPC. **Fix:** add a `generate_referral_link` IPC.
- **M-18 · PKCE not implemented despite the type name — `LIVE (R-02)`.** `auth/oauth.rs:83-89,434-437`: the `code_verifier` sent to the exchange is just the provider name. **Fix:** implement real PKCE or record the accepted risk.

### Recovery-binding feature (`recovery_binding.rs`, added in `95083d0f`)
The feature is well-built (domain-separated signing + cross-repo KAT, `safe_join` with a no-escape proptest, `Zeroizing` mnemonics, cancellable best-effort pull, server-enforced authz). These are design/robustness notes.

- **RB-1 · Recovery binding is default-on with no consent and no opt-out — `NEW` · privacy/design (Medium).** `recovery_binding.rs:118-148` is spawned from `initialize_sync_inner` (`sync/lifecycle.rs:1294-1300`) for **every** account, no UI. It registers (server-side) a binding linking the custodial OAuth login SS58 ↔ the self-custodial master-mnemonic SS58, granting that mnemonic identity standing read access to all the account's files. Consequences: (a) the server holds a mapping that **deanonymizes the two identities**; (b) it **amplifies the blast radius of a leaked master mnemonic** — the mnemonic alone now authenticates (`challenge_response`), authorizes the download, and decrypts. **Fix:** make it opt-in (or surface it + provide an unbind) and record the trade-off in the ADR. *(Confidence: High — the spawn is unconditional.)*
- **RB-2 · A recovery probe can create a server account as a side effect — `NEW` (Low).** `list_recoverable_accounts`/`recover_account_files` (`:209-210,363-364`) mint a bearer via `challenge_response(..., None)` for **any** pasted phrase and discard the returned `_is_new` (`auth/service.rs:139` returns it → the server creates on first challenge). Repeated probes with arbitrary phrases spam account creation / allow enumeration. **Fix:** use a read-only existence probe, or rely on server-side rate-limiting + record it. *(Confidence: Med)*
- **RB-3 · `recover_account_files` destination is unvalidated — `NEW` (Low).** `:369-372` `create_dir_all`s the FE-supplied `destination_dir` with no normalization/overlap check; pointing it at an existing sync root would intermix recovered files into a live drive (the per-file `safe_join` only guards *within* that root). **Fix:** canonicalize + reject root/home and any active sync-path ancestor. *(Confidence: High)*
- **RB-4 · Shared cancel flag races across concurrent recoveries — `NEW` (Low).** `recovery_cancel` is a single `AtomicBool`; `recover_account_files` `store(false)` at entry (`:358`) clears any cancel a still-running prior pull is waiting on. **Fix:** per-run token, or reject a second concurrent recovery. *(Confidence: Med)*
- *Note (not a finding):* the three recovery commands are intentionally **not** `require_session_account`-gated — recovery runs when there may be no session and authenticates via the pasted mnemonic; the `HcfsServerCtx::resolve` `ss58 == account_id` assertion is deliberately bypassed at `:217-225`, documented, and bounded to read-only owned-namespace discovery.

---

## LOW

**Bridge logic in TypeScript (logic-placement, `LIVE`/expanded under R-03)** — beyond H-8, the entire `app/lib/bridge/` subsystem is domain logic in the renderer: fee/conversion/gas math (`config.ts`, `service.ts:874-935`, `BridgeDialog.tsx:316-337` `toPlanckString`), ink! contract ABI error decoding + on-chain storage reads (`service.ts:243-353,1086-1242`), renderer-owned WS RPC clients to Bittensor/Hippius (`service.ts:77-91`, `useBridge.ts:128-170`), and localStorage tx-history persistence with hand-rolled BigInt serde (`service.ts:364-430`, `local-cache.ts`). **Suggested:** a Rust `blockchain/bridge.rs` owning construct+dryrun+sign+submit + decoded views; the FE passes only `{amount, recipient, direction, walletId, password}`.

**Notifications (multi-account, `NEW`)** — `notifications/crud.rs`: dedup probes `credit_already_notified`/`low_credit_subtype_exists`/`hippius_version_notification_exists` (`:450-510`) aren't account-scoped (cross-account info leak); `delete_system_notification_by_version` (`:388-400`) and `clear_all/delete_all_notifications` (`:513-521`) have no session/owner filter (cross-account wipe); `notifications/credits.rs` keeps `is_first_time`/`is_above_half_credit` in a global `app_state WHERE id=1` row (NOTIF-4).

**Tray robustness (`NEW`)** — `tray/panel.rs`: `tray_panel_hidden_at` never reset after open (`:119-122,177`); wall-clock not monotonic cooldown (`:76-78`); FE-supplied `TrayIconRect` f64 deserialized + arithmetic with no finite/bounds check → debug-panic on adversarial input (`:61-72,267`, `geometry.rs:28-34`). All self-limiting today.

**L-NET-1 · Cleartext `http://` credits link — `NEW`.** `app/lib/utils/links.ts:10`: `CREDITS: "http://console.hippius.com/dashboard/billing?addCredits=true"` is plain `http://` while the sibling `BILLING` (`:9`) is `https://`. It's opened in the external browser via `openUrl`, so the initial cleartext request to a **billing/add-credits** page is MITM-downgrade / redirect-to-phishing exposed. Almost certainly a typo. **Fix:** change to `https://`. *(Confidence: High — verified)*

**Backend low** — `transfer_balance`/staking accept a zero amount at parse (chain rejects, wastes a fee); chart f64 round-trip is lossy for realistic balances (`billing/charts.rs:301-314` — display only); `get_balance_transfers`/`get_billing_transactions` skip the `INDEXER_MAX_LIMIT` cap siblings enforce (`billing/queries.rs:494`); migration `create_dir_all` runs before overlap validation (`migration.rs:551-559`); `stop_sync` epoch-bump misses inits in their pre-register window (`lifecycle.rs:1372-1378` — tracked follow-up); `prepare_config_dir` overwrites the master mnemonic before the account-binding check (`lifecycle.rs:768-786`, latent); `add_files`/`add_folder` reject any name containing `..` as a substring (over-strict, `files.rs:971,296`); `custom_sync_path` not normalized (`migration.rs:552`); token cache + token flow as bare `String` not `Zeroizing` (`auth/token_keychain.rs:83`); session restore is local-expiry-only with no server-revocation probe (`session_restore.rs`, intentional — record it).

**Frontend low** — `getHcfsConfig` failure conflated with "no password set" → misroutes to password re-entry (`AddLocalFolderDialog.tsx:200`, `MultiFolderSyncManager.tsx:369`, `DriveOnboarding.tsx:288`); empty `.catch(() => {})` on plan-storage enrichment (`SubscriptionPlansSection.tsx:55`); splash-screen effect leaks timers / setState-after-unmount on abrupt unmount (`splash-screen-v2/index.tsx:205-397`).

**New-code low** — future-dated credit event → empty (not crashing) chart (`drive_credits.rs:218`); `normalizeRelPath` strips only leading `/` not `\`/`./` (latent Windows, `relPath.ts:14`); retained completed rows briefly render oldest-first (`mergeUploadFeed.ts`); `hcfs-bump.yml` `sed` unguarded against an empty parsed rev (`:91,103`).

---

## INFO

- **INFO-1 · `derive_keys` uses `parse`, not `parse_normalized` — `NEW`.** `auth/service.rs:48` (`derive_keys`, used by login/refresh/recovery-binding) uses `SubxtMnemonic::parse`, while the wallet/signing paths (`blockchain/helpers.rs`, `recovery_binding.rs`, `wallet/commands.rs`) use `parse_normalized`. For a non-NFKD mnemonic this could derive a different address on the auth path vs the signing path. Negligible in practice (BIP-39 English is ASCII), but worth aligning to `parse_normalized` for consistency.

---

## Verified CLEAN (traced, not bugs) — so the team doesn't re-chase

**Recent commits**
- **`50dea5f2` (sync-widget byte-total fix):** correct. `selectLiveTransferBytes` now reads the single-count `progressBytes`/`bytesExpected` pair (what the percent ring is weighted on) instead of the `combined*` pair that double-counts encrypt+upload (the "324 MB for a 162 MB file" bug); `combined*` still drives speed/ETA where the 2× cancels. The extracted `app/lib/tray/trayProgressText.ts` is pure presentation, well-unit-tested, branch logic correct.
- **`96104819` (`useFilteredFiles` render-loop fix):** correct — switches the criteria identity from unstable reference to value (`JSON.stringify`), drops the `setResult`/`forceRender` from the no-op branch that drove the loop; the `exhaustive-deps` disable is justified; new test added.
- **`95083d0f` (recovery-binding feature):** high-quality (see RB-\* for design notes); supporting wiring (`AppState.recovery_cancel`/`recovery_bound`, the `post_json` helper, main.rs registration, the lifecycle spawn) is clean and the `recovery_bound` mutex is never held across an `.await`.
- **New release code (`545923a6..f5ab57f8`):** no regressions. hcfs API adaptations (`52d1bcd1`, `04f8c1ac`, `b343d747`) mechanically correct; sync-widget cap/ordering underflow-safe + proptest-pinned; `error_notify.rs` per-label edge-latch correct (no double-fire/missed-clear); region-probe skip gates nothing; App Translocation guard component-match + IPC-failure-safe; tray credits prefer active session. New tests genuinely guard their claimed behavior.

**Core subsystems**
- **Money math:** string/u128 divmod throughout; `to_plancks`/`credits_to_planck` float-free + fail-closed; subxt 0.38 defaults to 32-block mortal (no immortal-replay); single-snapshot balance reads.
- **Crypto-at-rest (`crypto/store.rs`):** HKDF-SHA256 per-account key separation (so cross-account decryption already fails on key alone), OsRng nonces, authenticated + length-checked decrypt. Missing AEAD AAD (R-33) is defense-in-depth only here given the key separation.
- **Signing path (`blockchain/helpers.rs`):** per-call signer derivation (never cached), rate-limit gate covering check→verify→record (TOCTOU-closed), anti-oracle error unification, swallowed-but-logged legacy→Argon2id migration.
- **Auth (`auth/service.rs`):** `challenge_response` is EIP-191 personal_sign (domain-separated from real eth txs, not tx-replayable); `refresh_auth_token_internal` serializes per-account via `refresh_locks`. **Keychain (`auth/keychain.rs`):** per-account `Entry`, `Zeroizing` cache, logout's `delete_mnemonic` drops the in-memory cache entry (no lingering seed). **`account_key`:** truncated-64-bit SHA-256 is a *namespacing* key, not the auth boundary (`require_session_account` compares the full SS58) — collision is accidental data-mixing at ~2³² odds (R-22, accept).
- **Eligibility gate:** `require_eligible` is the first line of `add_file`/`add_files`/`add_folder`/`create_vm`, atomic + not FE-cache-bypassable; pricing centralized in `thresholds`; the pre-init balance check's fail-open is backstopped by the per-file 402.
- **Sync safety:** `remove_drive_for_account` drain-then-wipe baseline teardown (closes 17b8e159); cancel notifications dropped via `CANCELLED_MARKER`; epoch/commit-lock race model + lock hierarchy respected; no lock-across-await; `rename_entry`/`validate_new_name` solid; `validate_no_path_overlap` canonicalizes both directions; `selective.rs` `validate_pattern` rejects `..`; mnemonic derivation correct.
- **IDOR backbone:** `SessionAccount` newtype + `require_session_account` validated at IPC-arg extraction; SSH (`key_id: i64`, no URL injection)/VM/support/notification-settings commands conform; shares path-traversal-safe + owner-scoped; SQL parameterized everywhere (the `intent.rs`/schema `format!`s interpolate only placeholder counts / hardcoded identifiers).
- **Other:** `blockchain/subscription.rs` (double-spawn handle leak already fixed; async-mutex correct); `infra/vm.rs` (no process exec, JSON-over-reqwest); `billing/subscriptions.rs` (opaque Stripe-URL passthrough); `sync/failure_repo.rs`/`intent.rs` (owner/account-scoped); `utils/preferences.rs`+`bookmarks.rs` (documented non-sensitive global stores); `sub_accounts` table is dead (never read/written — not an at-rest secret; dropping it is R-35).
- **FE hygiene:** mnemonics never logged/persisted (the seed is held transiently in reveal UI only); listener cleanup strong; feature-flag gating (wallet/VM/referrals) correct, no leaks; tray-panel uses static `import { emit }` and emits only non-sensitive nav events; the sole `dangerouslySetInnerHTML` is the boot theme script over a build-time constant; updater HTTPS + minisign pubkey pinned; hcfs git pin is an immutable SHA; `hcfs-bump.yml` opens a PR only (no auto-merge/publish).

---

## Recommended order of action

0. **H-1 is ACCEPTED / won't-fix for now** (intentional — see the finding; blocked on the console/server `state` work). M-18 shares the same blocker. All other findings are in scope.
1. **Decide the PR #13 overlap** — its 24 reviewed commits already fix the wallet class (H-7, H-8 Part A, H-9, H-10, H-15, M-1, M-3, M-10, M-CRYPTO-1), but it's 179 commits stale. Either refresh+land #13 and scope the new branch to the gaps, or fold its fixes into the new branch. (sync-engine has nothing to merge — it's an ancestor.)
2. **New High fixes not on any branch:** H-3 (delete wrong-drive), H-4 (asset scope), H-6 (migration collision), H-13 (tray capability), H-14 (token at rest), H-2 (restore IDOR).
3. **Cheap high-value FE wins:** M-13 (`errorMessage` swap), M-14 (`dispatchSigningError` wiring), M-15/M-16 (credit error UX), L-NET-1 (`https://` link).
4. **Hardening batch:** M-2, M-5..M-8, M-11, M-12, RB-1..RB-4, then the Low groups and INFO-1.
5. **Non-static follow-ups (highest remaining value):** run `cargo audit`/`cargo deny` for dependency CVEs; dynamic/runtime test the funds + recovery flows.

*All findings carry inline file:line evidence and a confidence level. Items tagged `LIVE` were re-confirmed present at HEAD `50dea5f2`; all 16 High findings plus the listed Mediums were line-verified by hand (no agents) across five verification passes.*
