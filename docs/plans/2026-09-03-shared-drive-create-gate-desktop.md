# Shared-drive create gate — desktop upgrade prompt

**Date:** 2026-09-03
**Repo:** `thenervelab/hippius-desktop`
**Branch:** `feat/shared-drive-not-entitled` from `origin/staging`
**Server half:** HCFS PR #386 (`feat/shared-drive-create-gate`) — merged/dark.

## Goal

When the HCFS server refuses a shared-drive **mint** because the drive owner's
plan is not Plus/Max/Scale, it returns:

```
HTTP 403  { "error": "shared_drives_not_entitled", "message": "..." }
```

Desktop must turn that one slug into an upgrade prompt in the Share-drive modal.
Everything else about shared drives is unchanged. **Joining** an invite is never
gated, so nothing on the accept path changes.

This mapper is **inert until the slug is live in prod** (the HCFS gate ships
dark, flipped on in Rancher only after this and the console prompt ship), so it
can land on `staging` any time after #386.

## Non-goals / do not touch

- **Do not** plan-gate the "Share drive…" menu. `showShareDrive` stays
  `flags.sharedDrivesEnabled && !member`
  (`app/components/page-sections/settings/multi-folder-sync/folderMenuGating.ts`).
  An owner who downgraded still needs the Members panel (remove); the server
  gates growth, not the menu. The upsell surfaces at **mint time**, inside the
  modal.
- **Do not** touch `add_shared_drive`, `SharedWithMeSection`, `leave_shared_drive`.
- **Do not** match on the English `message` — match the `error` **slug**.

## Wire contract (consumed, not defined here)

`POST /v1/drive-invites` → `403 { error: "shared_drives_not_entitled", message }`
(flat body, not the `NetworkResponse` envelope) when the owner's plan is not
entitled. The gate keys on the **owner**, so a manager can hit it on a Free
owner's drive — the prompt copy must not say "your plan".

---

## Task 2.1 — Map the 403 slug → `NotReady(SharedDrivesNotEntitled)`

Today every 401/403 collapses to `AppError::Auth` and the slug is dropped
(`error` is `#[expect(dead_code)]`). That is the line that makes the server gate
invisible to desktop.

**`src-tauri/src/shared_drives/commands.rs`** — `classify_error_status` (~140-158).
Add an arm **before** the fused `(401 | 403, env)` arm:

```rust
(403, Some(env)) if env.error == "shared_drives_not_entitled" => {
    AppError::NotReady(NotReadyKind::SharedDrivesNotEntitled)
}
(401 | 403, env) => AppError::Auth(...), // account_suspended, forbidden stay Auth
```

**Gotcha:** the `error` field carries `#[expect(dead_code, reason = "...")]`.
Reading `env.error` fulfills the field, so that attribute becomes an
unfulfilled-expectation lint error — **remove the `#[expect(dead_code)]`** on
`error` in the same edit.

**`src-tauri/src/error.rs`** — `NotReadyKind` (~97-171) has **no serde derive**;
serialization is a hand-written `wire_name()` + `Serialize` + `Display`. A new
variant `SharedDrivesNotEntitled => "SHARED_DRIVES_NOT_ENTITLED"` touches **five**
spots:
1. the enum definition,
2. `wire_name()` (~179-197),
3. the `Display` impl (~200+),
4. the `expected_wire_name` match in the exhaustive test
   `not_ready_kind_all_variants_serialize_screaming_snake` (~668-711),
5. the `for kind in [ ... ]` array in that same test.

`SharedDrivesUnavailable` / `SHARED_DRIVES_UNAVAILABLE` is the twin to clone.
(That one is the feature-off bare-404 discriminator; keep the two distinct.)

**`app/lib/utils/dispatchTauriError.ts`** — add `"SHARED_DRIVES_NOT_ENTITLED"` to
the `NotReadyKind` string-literal union (~10-25).

**Tests:**
- `commands.rs` unit: 403 `shared_drives_not_entitled` → `NotReady`; 403
  `account_suspended` still `Auth`; bare 404 still `Unavailable`.
- `error.rs` exhaustive wire-name test (fails to compile until the new variant is
  added in all five spots).

**Commit:** `fix(shared-drives): map mint 403 slug to NotReady`

## Task 2.2 — Invite-tab upgrade state

- **`app/lib/utils/links.ts`** — `APP_LINKS` (typed `any`, keys `BILLING`/`CREDITS`)
  gains `PLANS: "https://console.hippius.com/dashboard/storage/drive/plans"`.
  (The prod page 404s until console ships `DRIVE_SUBSCRIPTION_PLANS`; same
  known-gap class as the invite links. Do **not** point at hippicode in prod
  builds.)
- **`app/lib/tauri/sharedDrives.ts`** — `isSharedDrivesNotEntitled(error)` =
  `isNotReady(error, "SHARED_DRIVES_NOT_ENTITLED")`, twin of
  `isSharedDrivesUnavailable`.
- **`app/components/page-sections/drive/shareDriveModalState.ts`** — add
  `| { kind: "notEntitled" }` to the `InviteState` union (~14-19).
- **`app/components/page-sections/drive/ShareDriveModal.tsx`** — `mintInvite`
  catch (~125-132) already drives inline `InviteState` (no toast). Add, before
  the generic `error` fallback:
  ```ts
  else if (isSharedDrivesNotEntitled(err)) setInvite({ kind: "notEntitled" });
  ```
  and a `notEntitled` render arm beside the `unavailable`/`error` arms (~230-234).
- **Chrome** — copy `InsufficientCreditsDialog.tsx`'s visual (FramedDialog + two
  stacked buttons): heading **"Shared drives need Plus, Max, or Scale"**, primary
  **Upgrade plan** → `openLinkByKey("PLANS")`, secondary **Close**. No "Try again".

**Tests:**
- `ShareDriveModal.test.tsx` — `{ kind: "NotReady", subkind: "SHARED_DRIVES_NOT_ENTITLED" }`
  renders the upgrade copy, no Try-again, CTA present.
- `sharedDrives.test.ts` — helper matches only that subkind.
- `folderMenuGating.test.ts` — unchanged (Share still visible on Free).

**Commit:** `feat(shared-drives): upgrade prompt when mint is not entitled`

## Task 2.3 — Battery

FE unit tests for the files above + `cargo test` in `src-tauri` for `shared_drives`
and `error`. No live-backend test (the slug is not in prod yet).

## Verification

- Share still visible on a Free fixture (menu gating unchanged).
- A mocked 403 `shared_drives_not_entitled` shows the upgrade prompt, not the
  generic Auth/error toast.
- `add_shared_drive` / accept tests unchanged.
