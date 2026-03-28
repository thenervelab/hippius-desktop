# Defer Nebula Permission Prompts to VPN Enable

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the macOS admin password prompt (osascript) from app startup/splash screen and only request elevated permissions when the user actually enables the VPN.

**Architecture:** Currently, `install_nebula` (splash screen phase) calls `grant_permissions()` which triggers an osascript admin dialog on every fresh install/update. And `verify_nebula_internal` (called at startup via `setup.rs`) also calls `grant_permissions()` if the binary lacks setuid. We'll remove permission granting from both of these paths and instead add it to `toggle_vpn_status` — the only user-initiated VPN enable flow. The binary will be downloaded and extracted normally during splash, but the setuid/chown step is deferred.

**Tech Stack:** Rust (Tauri backend), TypeScript (Next.js frontend), SQLite, osascript/pkexec

---

## Current Permission Escalation Points

There are **three** places where `grant_permissions()` (osascript on macOS, pkexec on Linux) is called:

1. **`install_nebula`** (`nebula.rs:542-561`) — During splash screen, after extracting the binary. Calls `check_permissions` → `grant_permissions` if needed.
2. **`verify_nebula_internal`** (`nebula.rs:636-657`) — Called during startup from `setup.rs:745` and from the `verify_nebula` IPC command (splash screen phase 4). Checks permissions and escalates if VPN is enabled.
3. **`remove_existing_binaries`** (`nebula.rs:1162-1228`) — During `install_nebula`, removes root-owned binaries from prior installs. This one is **legitimate** — you can't overwrite root-owned files without escalation. But it only triggers on updates when old binaries are root-owned (i.e., permissions were previously granted).

## Design Decisions

1. **`install_nebula`**: Remove `grant_permissions()` call entirely. Binary gets 0o755 (user-executable) but NOT setuid-root. It will work fine for everything except creating TUN/TAP devices (which only matters when actually running the VPN).

2. **`verify_nebula_internal`**: Remove the `grant_permissions()` call. This runs at startup and during splash. If VPN is enabled at startup and binary lacks permissions, the VPN simply won't start — the user will need to re-toggle it.

3. **`toggle_vpn_status`**: Add `check_permissions` → `grant_permissions` before starting Nebula. This is where the user explicitly chooses to enable VPN, so prompting for admin access makes sense.

4. **`remove_existing_binaries`**: Keep as-is. This is a legitimate need during updates — can't overwrite root-owned files. But it only triggers when the binary was previously chown'd to root (meaning the user already granted permissions once before for VPN).

5. **New IPC command `ensure_vpn_permissions`**: Exposed for the frontend to call before toggling, enabling the UI to handle the "user cancelled" case gracefully (show a toast instead of a generic toggle failure).

6. **Splash screen text**: Remove the "Enter your password to continue..." message since no password is needed anymore.

7. **Startup `verify_nebula_setup`**: Keep the function but it should only verify binary existence and certificate renewal — no permission escalation.

---

### Task 1: Remove `grant_permissions` from `install_nebula`

**Files:**
- Modify: `src-tauri/src/utils/nebula.rs:538-561`

**Step 1: Remove the permission grant block from `install_nebula`**

In `nebula.rs`, inside `install_nebula`, remove the block that calls `check_permissions` and `grant_permissions` (lines 538-561). The binary already gets 0o755 permissions set on lines 506-530, which is sufficient for non-VPN operations.

Replace the block:

```rust
            // Grant permissions to the binary (required for TUN/TAP device creation)
            let binary_path = get_nebula_binary_path().map_err(|e| e.to_string())?;
            info!("Checking and granting permissions...");

            match check_permissions(&binary_path).await {
                Ok(has_perms) => {
                    if !has_perms {
                        info!("Binary needs permissions, requesting elevated access...");
                        if let Err(e) = grant_permissions(&binary_path).await {
                            warn!(
                                "Failed to grant permissions: {}. You may need to run the app with elevated privileges or grant permissions manually.",
                                e
                            );
                        } else {
                            info!("Permissions granted successfully");
                        }
                    } else {
                        debug!("Binary already has required permissions");
                    }
                }
                Err(e) => {
                    warn!("Failed to check permissions: {}", e);
                }
            }
```

With:

```rust
            debug!("Binary installed with user permissions (0o755). Elevated permissions will be requested when VPN is enabled.");
```

**Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | head -20`
Expected: No errors

**Step 3: Commit**

```bash
git add src-tauri/src/utils/nebula.rs
git commit -m "Remove admin permission prompt from install_nebula

Nebula binary is now installed with user-level 0o755 permissions.
Elevated setuid/capability permissions are deferred to VPN enable."
```

---

### Task 2: Remove `grant_permissions` from `verify_nebula_internal`

**Files:**
- Modify: `src-tauri/src/utils/nebula.rs:636-657`

**Step 1: Remove the permission grant block from `verify_nebula_internal`**

In `verify_nebula_internal`, when VPN IS enabled (`is_enabled == true`), remove the block that checks and grants permissions (lines 636-657). Keep the certificate check that follows it.

Replace:

```rust
    // Check and grant permissions if needed
    info!("Verifying binary permissions...");
    match check_permissions(&binary_path).await {
        Ok(has_perms) => {
            if !has_perms {
                info!("Binary needs permissions, requesting elevated access...");
                if let Err(e) = grant_permissions(&binary_path).await {
                    warn!(
                        "Failed to grant permissions: {}. Nebula may fail to start.",
                        e
                    );
                } else {
                    info!("Permissions granted successfully");
                }
            } else {
                debug!("Binary has required permissions");
            }
        }
        Err(e) => {
            warn!("Failed to check permissions: {}", e);
        }
    }
```

With:

```rust
    // Log permission status but don't escalate at startup.
    // Elevated permissions are requested when the user enables VPN.
    match check_permissions(&binary_path).await {
        Ok(has_perms) => {
            if !has_perms {
                info!("Binary lacks elevated permissions. Will be requested when VPN is enabled.");
            } else {
                debug!("Binary has required permissions");
            }
        }
        Err(e) => {
            warn!("Failed to check permissions: {}", e);
        }
    }
```

**Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | head -20`
Expected: No errors

**Step 3: Commit**

```bash
git add src-tauri/src/utils/nebula.rs
git commit -m "Remove admin permission prompt from verify_nebula_internal

Startup verification now logs permission status without escalating.
Users are prompted only when they enable the VPN."
```

---

### Task 3: Add new `ensure_vpn_permissions` IPC command

**Files:**
- Modify: `src-tauri/src/utils/nebula.rs` (add new public function)
- Modify: `src-tauri/src/main.rs` (register command)

**Step 1: Add the `ensure_vpn_permissions` command to `nebula.rs`**

Add this function after the existing `verify_nebula` command (around line 674):

```rust
/// Ensure the Nebula binary has elevated permissions required for VPN.
/// Called by the frontend before enabling the VPN. Returns Ok if
/// permissions are already present or were successfully granted.
/// Returns Err if the user cancels the authorization dialog.
#[tauri::command]
pub async fn ensure_vpn_permissions() -> Result<(), String> {
    let binary_path = get_nebula_binary_path().map_err(|e| e.to_string())?;

    if !binary_path.exists() {
        return Err(
            "Nebula binary not found. Please restart the app to install it."
                .to_string(),
        );
    }

    let has_perms = check_permissions(&binary_path)
        .await
        .map_err(|e| format!("Failed to check permissions: {e}"))?;

    if has_perms {
        debug!("Binary already has elevated permissions");
        return Ok(());
    }

    info!("Requesting elevated permissions for VPN...");
    grant_permissions(&binary_path)
        .await
        .map_err(|e| format!("{e}"))?;

    info!("VPN permissions granted successfully");
    Ok(())
}
```

**Step 2: Register the command in `main.rs`**

In `src-tauri/src/main.rs`, find the `tauri::generate_handler![]` macro invocation and add `crate::utils::nebula::ensure_vpn_permissions` to the handler list, near the other nebula commands.

**Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | head -20`
Expected: No errors

**Step 4: Commit**

```bash
git add src-tauri/src/utils/nebula.rs src-tauri/src/main.rs
git commit -m "Add ensure_vpn_permissions IPC command

New command checks and requests elevated permissions for the Nebula
binary. Called by the frontend before enabling VPN, so the user sees
the admin prompt only when they choose to turn on the VPN."
```

---

### Task 4: Add permission check to `toggle_vpn_status`

**Files:**
- Modify: `src-tauri/src/commands/vpn_enabled.rs:35-92`

**Step 1: Add permission check before starting Nebula**

In `toggle_vpn_status`, after the certificate check (line 61) and before updating the DB (line 64), add a permission check. This is the safety net — if the frontend didn't call `ensure_vpn_permissions` first, the backend still ensures permissions before starting.

Replace the section from line 54 to line 61:

```rust
    // If enabling, check and update certificate first
    if new_status {
        info!("Checking certificate status before enabling...");
        if let Err(e) = crate::utils::nebula::check_and_update_certificate(pool).await {
            error!("Certificate check failed: {}", e);
            return Err(format!("Failed to verify/renew certificate: {}", e));
        }
    }
```

With:

```rust
    // If enabling, ensure permissions and certificate before starting
    if new_status {
        // Ensure binary has elevated permissions (setuid on macOS,
        // cap_net_admin on Linux) required to create TUN/TAP devices
        info!("Checking VPN binary permissions before enabling...");
        let binary_path = crate::utils::nebula::get_nebula_binary_path()
            .map_err(|e| e.to_string())?;

        let has_perms = crate::utils::nebula::check_permissions(&binary_path)
            .await
            .map_err(|e| format!("Failed to check permissions: {e}"))?;

        if !has_perms {
            info!("Requesting elevated permissions for VPN...");
            crate::utils::nebula::grant_permissions(&binary_path)
                .await
                .map_err(|e| format!("{e}"))?;
        }

        info!("Checking certificate status before enabling...");
        if let Err(e) = crate::utils::nebula::check_and_update_certificate(pool).await {
            error!("Certificate check failed: {}", e);
            return Err(format!("Failed to verify/renew certificate: {}", e));
        }
    }
```

**Step 2: Make `check_permissions` and `grant_permissions` public**

These functions are currently private (`async fn`). Change their visibility in `nebula.rs`:

- Line 1230: Change `async fn check_permissions` → `pub async fn check_permissions`
- Line 1270: Change `async fn grant_permissions` → `pub async fn grant_permissions`
- Line 66: Also verify `get_nebula_binary_path` is already `pub` (it should be since it's used elsewhere; if not, make it `pub`)

**Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | head -20`
Expected: No errors

**Step 4: Commit**

```bash
git add src-tauri/src/commands/vpn_enabled.rs src-tauri/src/utils/nebula.rs
git commit -m "Request VPN permissions in toggle_vpn_status

When enabling VPN, check and grant elevated permissions before
starting Nebula. This is the primary user-facing permission prompt."
```

---

### Task 5: Update frontend VPN toggle to handle permission errors

**Files:**
- Modify: `app/components/dashboard-title-wrapper/vpn-menu/VPNMenuContent.tsx:25-70`

**Step 1: Add permission-aware error handling**

The `handleToggle` function already shows a toast on error. The backend now returns descriptive errors like "User cancelled the authorization dialog". We should detect the cancellation case and show a friendlier message.

Replace the error handling in the catch block (lines 48-66):

```typescript
    } catch (error) {
      let backendMessage: string;
      if (error instanceof Error) {
        backendMessage = error.message;
      } else if (typeof error === "string") {
        backendMessage = error;
      } else {
        try {
          backendMessage = String(error);
        } catch {
          backendMessage = "An unknown error occurred";
        }
      }
      toast.error("Failed to toggle VPN", {
        description: backendMessage,
      });
      console.error("Failed to toggle VPN status:", error);
      // Revert on error
      setIsConnected(!checked);
    } finally {
```

With:

```typescript
    } catch (error) {
      let backendMessage: string;
      if (error instanceof Error) {
        backendMessage = error.message;
      } else if (typeof error === "string") {
        backendMessage = error;
      } else {
        try {
          backendMessage = String(error);
        } catch {
          backendMessage = "An unknown error occurred";
        }
      }

      const isCancelled =
        backendMessage.includes("User cancelled") ||
        backendMessage.includes("user canceled");

      if (isCancelled) {
        toast.info("Permission Required", {
          description:
            "Administrator access is needed to create secure VPN connections. " +
            "Toggle the VPN again to retry.",
        });
      } else {
        toast.error("Failed to toggle VPN", {
          description: backendMessage,
        });
      }
      console.error("Failed to toggle VPN status:", error);
      // Revert on error
      setIsConnected(!checked);
    } finally {
```

**Step 2: Commit**

```bash
git add app/components/dashboard-title-wrapper/vpn-menu/VPNMenuContent.tsx
git commit -m "Show friendly toast when user cancels VPN permission dialog"
```

---

### Task 6: Update splash screen text

**Files:**
- Modify: `app/components/splash-screen/SplashContent.tsx:81-97`

**Step 1: Remove password-related messaging**

The `getPhaseContent` function shows different messages based on `isAlreadyInstalled`. Since we no longer prompt for a password during install, both paths should show the same message.

Replace the `getPhaseContent` function:

```typescript
export function getPhaseContent(
  isAlreadyInstalled: boolean | null
): Record<string, AppSetupPhaseContent> {
  const content = { ...PHASE_CONTENT_BASE };

  // Update the installing_nebula message based on installation state
  if (isAlreadyInstalled) {
    // Tools already installed - show simpler verification message
    content.installing_nebula.subStatus = "Installing Hippius Mesh Tools...";
  } else {
    // Tools not installed - show password requirement message
    content.installing_nebula.subStatus =
      "Installing Hippius Mesh Tools. Enter your password to continue...";
  }

  return content;
}
```

With:

```typescript
export function getPhaseContent(
  isAlreadyInstalled: boolean | null
): Record<string, AppSetupPhaseContent> {
  const content = { ...PHASE_CONTENT_BASE };

  content.installing_nebula.subStatus = "Installing Hippius Mesh Tools...";

  return content;
}
```

**Step 2: Commit**

```bash
git add app/components/splash-screen/SplashContent.tsx
git commit -m "Remove password prompt messaging from splash screen

Admin permissions are no longer requested during install, so the
'Enter your password' message is no longer needed."
```

---

### Task 7: Write tests for the permission flow

**Files:**
- Modify: `src-tauri/tests/` (add or extend a test file)

**Step 1: Write unit tests for the permission check logic**

Since `check_permissions` and `grant_permissions` require OS-level operations (setuid, getcap), we can't easily unit-test them directly. However, we should verify the `toggle_vpn_status` flow handles the permission states correctly through integration-style tests.

Create a test in `src-tauri/src/utils/nebula.rs` (inline module test) that validates the binary path resolution:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_nebula_binary_path_is_deterministic() {
        let path1 = get_nebula_binary_path().unwrap();
        let path2 = get_nebula_binary_path().unwrap();
        assert_eq!(path1, path2);
    }

    #[test]
    fn test_get_nebula_dir_is_deterministic() {
        let dir1 = get_nebula_dir().unwrap();
        let dir2 = get_nebula_dir().unwrap();
        assert_eq!(dir1, dir2);
    }
}
```

Note: The core permission logic is OS-dependent and requires actual binary files. The real validation comes from manual testing (Task 8). The code paths are simple enough (check → grant → start) that the risk of regression is low. The existing integration test infrastructure (`tests/`) doesn't mock the Nebula binary and tests here would be artificial. Focus testing effort on the frontend error handling behavior.

**Step 2: Verify tests pass**

Run: `cd src-tauri && cargo test 2>&1 | tail -20`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src-tauri/src/utils/nebula.rs
git commit -m "Add basic unit tests for nebula path resolution"
```

---

### Task 8: Manual testing checklist

This task is not code — it's a validation checklist to run before merging.

**Fresh install (Nebula not installed):**
1. Delete `~/.hippius/nebula/` directory
2. Launch app → splash screen progresses through all phases
3. **Verify:** No macOS password prompt appears during splash
4. Navigate to VPN page → toggle VPN ON
5. **Verify:** macOS password prompt appears NOW
6. Enter password → VPN connects
7. **Verify:** VPN status shows connected with IP

**Permission cancelled:**
1. Toggle VPN ON → macOS password prompt appears
2. Click Cancel
3. **Verify:** Friendly toast says "Permission Required" (not a raw error)
4. Toggle VPN ON again → enter password → VPN connects

**Already installed + autoconnect:**
1. Enable autoconnect, then quit and relaunch
2. **Verify:** If binary already has permissions from prior grant, VPN auto-starts without prompt
3. If binary lost permissions (e.g., after update), VPN fails silently at startup (logged as warning). User toggles VPN → gets prompted.

**Update scenario:**
1. With VPN previously configured, simulate an update (delete the binary, keep version file different)
2. Relaunch → splash re-downloads and installs
3. **Verify:** `remove_existing_binaries` may prompt if old binary is root-owned (this is expected and unavoidable)
4. Toggle VPN → permission prompt for new binary

---

### Task 9: Update CLAUDE.md documentation

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Document the permission flow change**

Add a note under the Nebula section describing when permissions are requested:

Under the `utils/nebula/` bullet in the Backend Structure section, add:

> **Permission escalation (macOS/Linux):** Admin privileges for the Nebula binary (setuid on macOS, cap_net_admin on Linux) are requested ONLY when the user enables the VPN via `toggle_vpn_status`, never during app startup or splash screen. The `ensure_vpn_permissions` IPC command is available for the frontend to pre-check. The only exception is `remove_existing_binaries` during updates, which may prompt if old binaries are root-owned.

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "Document deferred VPN permission flow in CLAUDE.md"
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `src-tauri/src/utils/nebula.rs` | Remove `grant_permissions` from `install_nebula` and `verify_nebula_internal`. Add `ensure_vpn_permissions` command. Make `check_permissions`/`grant_permissions`/`get_nebula_binary_path` public. Add basic tests. |
| `src-tauri/src/commands/vpn_enabled.rs` | Add permission check+grant before starting Nebula in `toggle_vpn_status`. |
| `src-tauri/src/main.rs` | Register `ensure_vpn_permissions` in handler list. |
| `app/components/dashboard-title-wrapper/vpn-menu/VPNMenuContent.tsx` | Detect permission cancellation and show friendly toast. |
| `app/components/splash-screen/SplashContent.tsx` | Remove "Enter your password" messaging. |
| `CLAUDE.md` | Document the new permission flow. |

## Risk Assessment

- **Low risk:** The binary is still downloaded, extracted, and set to 0o755 during splash. Only the setuid/chown step is deferred.
- **Edge case:** If autoconnect is enabled but permissions were never granted (shouldn't happen in practice — you can't enable autoconnect without first enabling VPN, which grants permissions), the VPN silently fails to start. The user toggles VPN manually → gets prompted.
- **`remove_existing_binaries` still prompts on updates:** This is unavoidable — you can't overwrite root-owned files without admin access. But it only happens when updating a binary that was previously chown'd to root (meaning the user already granted permission before for VPN use).
