"use client";
import { TrayIcon } from "@tauri-apps/api/tray";
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { resolveResource } from "@tauri-apps/api/path";
import {
  openAppWindow,
  openFilesPage,
  openVirtualMachinesPage,
} from "@/app/lib/tray/trayWindowActions";

import { lastUpdatedPercentAtom } from "@/app/lib/store/syncAtoms";
import { VM_FEATURE_ENABLED } from "@/app/lib/featureFlags";
import { useAtom } from "jotai";
import type { SyncSnapshot } from "../types/syncSnapshot";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { deriveTrayIconState } from "@/app/lib/tray/trayIconState";
import { isLinuxPlatform as detectLinuxPlatform } from "@/lib/utils/isMacPlatform";

/* ─ IDs ───────────────────────────────────────────────────────── */
// Rust finds the icon by this id (`capture::tray_status::TRAY_ID`): it writes
// a recording's time beside it and decides what a click does mid-recording.
const TRAY_ID = "hippius-tray";

// add cached icon paths + state
const DEFAULT_TRAY_ICON = "icons/TrayIcon.png";
const SYNCING_TRAY_ICON = "icons/SyncingTrayIcon.png";
const SYNC_COMPLETED_TRAY_ICON = "icons/SyncCompletedTrayIcon.png";
let defaultIconPath: string | null = null;
let syncingIconPath: string | null = null;
let completedIconPath: string | null = null;
// "unknown": someone else drew on the icon (Rust's recording mark on
// Windows), so the next request repaints whatever it asks for.
let trayIconState: "default" | "syncing" | "completed" | "unknown" = "default";
// The last icon asked for, re-applied when Rust hands the icon back.
let lastIconRequest = { isSyncing: false, isCompleted: false };

// Rust marks the icon while a recording runs on Windows (its tray has no
// title for the time) and says when it is done; only this page knows which
// sync icon belongs there then.
const TRAY_ICON_RELEASED_EVENT = "capture_tray_icon_released";

/* ─ State kept across React reloads ───────────────────────────── */
// Idempotency guard for the one-time tray creation (a Fast Refresh re-run of
// the init effect must not build a second icon).
let trayInitStarted = false;
// Items shown in the attached right-click context menu, tracked so the
// login-status watcher can enable/disable them as auth changes.
let openFilesItem: MenuItem | null = null;
let openVmItem: MenuItem | null = null;

/* ─ Completion latch — keeps "complete" icon visible after the backend
   resets the snapshot to an empty cycle. Owned by the sync-activity watcher;
   the pure transition logic lives in `tray/trayIconState.ts`. */
let latchedComplete = false;

let latchedSnapshot: SyncSnapshot | null = null;

/* ─ Backend payload types ─────────────────────────────────────── */

// Tray data cache — refreshed via get_tray_menu_data Rust command
let trayDataCache: {
  loggedIn: boolean;
  credits: number | null;
  substrateAddress: string | null;
  timestamp: number;
} | null = null;
const TRAY_CACHE_DURATION = 5000; // 5 seconds

/**
 * Immediately invalidate the tray data cache so the next check re-queries Rust.
 * Call this on logout so the login-status watcher picks up the change instantly.
 */
export function clearLoginStatusCache() {
  trayDataCache = null;
}

/** Fetch tray data from Rust (login status + credits), with caching. */
async function refreshTrayData(): Promise<{
  loggedIn: boolean;
  credits: number | null;
  substrateAddress: string | null;
}> {
  if (
    trayDataCache &&
    Date.now() - trayDataCache.timestamp < TRAY_CACHE_DURATION
  ) {
    return trayDataCache;
  }
  try {
    const data = await invoke<{
      loggedIn: boolean;
      credits: number | null;
      substrateAddress: string | null;
    }>("get_tray_menu_data");
    trayDataCache = { ...data, timestamp: Date.now() };
    return data;
  } catch {
    return { loggedIn: false, credits: null, substrateAddress: null };
  }
}

/** Synchronous login check using cached data. */
function isUserLoggedIn(): boolean {
  return trayDataCache?.loggedIn ?? false;
}

/** Async login check via Rust. */
async function refreshLoginStatus(): Promise<boolean> {
  const data = await refreshTrayData();
  return data.loggedIn;
}

/* ─ Right-click context menu ──────────────────────────────────── */
//
// The tray icon's LEFT click opens the custom popover window (Rust receives
// it: `tray::panel::on_tray_icon_event`). Its RIGHT click shows this small
// native menu:
// Open Files, Open Virtual Machines, Quit Hippius. "Open Hippius" is
// deliberately omitted because the popover already has an Open Hippius
// button. The menu is attached with `showMenuOnLeftClick: false` so it
// never hijacks the left click.
//
// This is the ONLY menu the tray attaches — the old full in-memory menu
// (sync-activity rows + Sync Folders submenu) was never shown and has been
// removed. The builder points the module-level `openFilesItem` / `openVmItem`
// at its items so the login-status watcher (`updateOpenFilesMenuItem` /
// `updateOpenVmMenuItem`) enables/disables the entries the user actually sees.
const CTX_OPEN_HIPPIUS_ID = "tray-ctx-open-hippius";
const CTX_OPEN_FILES_ID = "tray-ctx-open-files";
const CTX_OPEN_VM_ID = "tray-ctx-open-vm";
const CTX_QUIT_ID = "tray-ctx-quit";

// True on Linux. The tray icon emits no left-click `action` event there (a
// `tray-icon` crate limitation), so the native menu — shown on left-click — is
// the only affordance, and it carries an explicit "Open Hippius" entry.
//
// Detected SYNCHRONOUSLY from the webview user-agent (`detectLinuxPlatform`),
// not the async `get_platform_info` IPC: the menu is built off this value, and
// a late/failed async lookup previously left it `false` on Linux — which dropped
// the "Open Hippius" item AND left `showMenuOnLeftClick` off, so a left-click
// did nothing and the menu was missing its only entry point. A synchronous,
// can't-fail check removes that race entirely.
let isLinuxPlatform = false;

/**
 * Linux "Open Hippius" menu action: reveal the MAIN window.
 *
 * The rich popover is a macOS/Windows feature only. On Linux it proved
 * unreliable — the icon fires no left-click event, the app cannot position its
 * own window under Wayland, and there is no native vibrancy — so rather than
 * pop a half-broken, see-through, mis-placed window, the stable behaviour is to
 * just bring up the main app window (exactly what "Open Files"/"Open VM" do).
 */
async function openHippiusFromTray() {
  try {
    await openAppWindow();
  } catch (e) {
    logTrayAction("Failed to open Hippius from tray menu", e);
  }
}

async function buildTrayContextMenu(): Promise<Menu> {
  const loggedIn = await refreshLoginStatus();

  // On Linux the menu is the tray's only affordance (the icon fires no
  // left-click event), so it leads with "Open Hippius" → reveal the main window.
  // macOS/Windows omit it: their left-click already opens the popover, whose
  // header has its own Open Hippius button.
  const leadingItems: MenuItem[] = [];
  if (isLinuxPlatform) {
    leadingItems.push(
      await MenuItem.new({
        id: CTX_OPEN_HIPPIUS_ID,
        text: "Open Hippius",
        action: openHippiusFromTray,
      }),
    );
  }

  const openFiles = await MenuItem.new({
    id: CTX_OPEN_FILES_ID,
    text: "Open Drive",
    enabled: loggedIn,
    action: async () => {
      // Guard against a stale `enabled` if login changed between renders.
      if (!isUserLoggedIn() && !(await refreshLoginStatus())) return;
      await openFilesPage();
    },
  });

  // Omitted entirely while VMs are gated off ("Coming Soon") — the page
  // redirects to the overview anyway, so a menu entry would be a dead end.
  // `openVmItem` stays null in that case; the login-status watcher is
  // already null-safe.
  const openVm = VM_FEATURE_ENABLED
    ? await MenuItem.new({
        id: CTX_OPEN_VM_ID,
        text: "Open Virtual Machines",
        enabled: loggedIn,
        action: async () => {
          if (!isUserLoggedIn() && !(await refreshLoginStatus())) return;
          await openVirtualMachinesPage();
        },
      })
    : null;

  const separator = await PredefinedMenuItem.new({ item: "Separator" });

  const quit = await MenuItem.new({
    id: CTX_QUIT_ID,
    text: "Quit Hippius",
    action: async () => {
      await invoke("app_close");
    },
  });

  // Track the visible (attached) items for the login-status watcher.
  openFilesItem = openFiles;
  openVmItem = openVm;

  return Menu.new({
    items: [
      ...leadingItems,
      openFiles,
      ...(openVm ? [openVm] : []),
      separator,
      quit,
    ],
  });
}

/**
 * Tell Rust whether the app on screen is signed in. Rust receives the tray
 * icon's clicks itself (`tray::panel::on_tray_icon_event`) and uses this to
 * choose between the popover and the main window's sign-in screen. It is the
 * auth context's `isAuthenticated`, the value that decides whether the login
 * screen shows, NOT Rust's `AuthInfo.substrate_address` (that stays set for a
 * session restored from disk while the UI shows the login screen).
 *
 * The click used to come here, through the `action` callback given to
 * `TrayIcon.new`. That callback belongs to this page: after a reload the icon
 * kept calling a callback that no longer existed and the popover stopped
 * opening. Rust's listener belongs to the app and cannot go stale; the page
 * only reports state, which it sends again whenever it loads.
 */
async function reportSignedIn(signedIn: boolean) {
  try {
    await invoke("tray_set_signed_in", { signedIn });
  } catch (e) {
    logTrayAction("Failed to report sign-in to the tray", e);
  }
}

/* ─ Public: create tray once ──────────────────────────────────── */

export function useTrayInit(isAuthenticated: boolean) {
  // Rust decides what a tray click opens; it needs to know who is signed in.
  useEffect(() => {
    void reportSignedIn(isAuthenticated);
  }, [isAuthenticated]);

  // Use atom to watch for sync percentage changes
  const [lastUpdatedPercent, setLastUpdatedPercent] = useAtom(
    lastUpdatedPercentAtom,
  );

  // Effect to update tray when sync state changes — derived entirely from
  // snapshot. Icon management is handled exclusively by
  // `startSyncActivityWatcher` (which latches to prevent flicker on backend
  // snapshot resets). This effect only handles logout cleanup.
  useEffect(() => {
    // When logged out, force the default icon and clear latched sync state so
    // the next account starts fresh.
    if (!isAuthenticated) {
      void setTrayIconSyncing(false, false);
      latchedComplete = false;
      latchedSnapshot = null;
      lastSyncSummarySignature = "";
      if (lastUpdatedPercent !== null) {
        setLastUpdatedPercent(null);
      }
      return;
    }
  }, [isAuthenticated, lastUpdatedPercent, setLastUpdatedPercent]);

  useEffect(() => {
    if (trayInitStarted) return;
    trayInitStarted = true;

    void (async () => {
      // Detect Linux synchronously (no IPC) so the tray is always built with the
      // menu-on-left-click + "Open Hippius" fallback there. Set before the tray
      // is created so the first context menu is correct on every launch.
      isLinuxPlatform = detectLinuxPlatform();

      // resolve all three icons once
      const [defPath, syncPath, completedPath] = await Promise.all([
        resolveResource(DEFAULT_TRAY_ICON),
        resolveResource(SYNCING_TRAY_ICON).catch(() => null),
        resolveResource(SYNC_COMPLETED_TRAY_ICON).catch(() => null),
      ]);
      defaultIconPath = defPath;
      syncingIconPath = syncPath;
      completedIconPath = completedPath;
      logTrayAction("Icon paths resolved", {
        defaultIconPath,
        syncingIconPath,
        completedIconPath,
      });

      const existingTray = await TrayIcon.getById(TRAY_ID);

      if (!existingTray) {
        // macOS/Windows: left-click → the popover, decided and opened by Rust
        // (no `action` here: a callback of this page dies with a reload);
        // right-click → the small native context menu (Open Files / Open VM /
        // Quit). `showMenuOnLeftClick: false` keeps the left click on the
        // popover. Linux: the icon fires no left-click event, so the menu must
        // show on left-click (`showMenuOnLeftClick: isLinuxPlatform`) and it
        // includes an "Open Hippius" entry (added by `buildTrayContextMenu`) as
        // the only way to reach the app there.
        const contextMenu = await buildTrayContextMenu();
        await TrayIcon.new({
          id: TRAY_ID,
          icon: defaultIconPath!,
          iconAsTemplate: false,
          tooltip: "Hippius Cloud",
          menu: contextMenu,
          showMenuOnLeftClick: isLinuxPlatform,
        });
        trayIconState = "default";
      } else {
        // The page reloaded under a live icon. Its context menu's items call
        // back into the page that made them, which is gone: attach a fresh
        // menu so right-click works again.
        try {
          await existingTray.setMenu(await buildTrayContextMenu());
        } catch (e) {
          logTrayAction("Failed to re-attach the tray menu", e);
        }
      }

      // Watch sync snapshots (drives the icon) and login status (enables/
      // disables the context-menu items) after the tray exists.
      startSyncActivityWatcher();
      startLoginStatusWatcher();
      void listen(TRAY_ICON_RELEASED_EVENT, () => {
        trayIconState = "unknown";
        void setTrayIconSyncing(lastIconRequest.isSyncing, lastIconRequest.isCompleted);
      });
    })();
  }, []);
}

// Add these explicit debug logs
function logTrayAction(action: string, details?: unknown) {
  console.log(`[Tray] ${action}`, details ? details : "");
}

async function updateOpenFilesMenuItem() {
  if (!openFilesItem) return;
  try {
    const loggedIn = await refreshLoginStatus();
    await openFilesItem.setEnabled(loggedIn);
  } catch (error) {
    console.error("[Tray] Failed to update Open Files item:", error);
  }
}

async function updateOpenVmMenuItem() {
  if (!openVmItem) return;
  try {
    const loggedIn = await refreshLoginStatus();
    await openVmItem.setEnabled(loggedIn);
  } catch (error) {
    console.error("[Tray] Failed to update Open Virtual Machines item:", error);
  }
}

// helper to toggle tray icon
async function setTrayIconSyncing(
  isSyncing: boolean,
  isCompleted: boolean = false,
) {
  lastIconRequest = { isSyncing, isCompleted };
  try {
    // Force resolve paths every time if they're missing
    if (!defaultIconPath)
      defaultIconPath = await resolveResource(DEFAULT_TRAY_ICON);
    if (syncingIconPath === null) {
      try {
        syncingIconPath = await resolveResource(SYNCING_TRAY_ICON);
      } catch (e) {
        logTrayAction("Failed to load syncing icon", e);
      }
    }
    if (completedIconPath === null) {
      try {
        completedIconPath = await resolveResource(SYNC_COMPLETED_TRAY_ICON);
      } catch (e) {
        logTrayAction("Failed to load completed icon", e);
      }
    }

    // Determine new state based on inputs
    let newState: "default" | "syncing" | "completed";
    if (isCompleted && completedIconPath) {
      newState = "completed";
    } else if (isSyncing && syncingIconPath) {
      newState = "syncing";
    } else {
      newState = "default";
    }

    // If nothing changed, don't update
    if (trayIconState === newState) {
      return;
    }

    // Select icon based on state
    let iconPath: string | null;
    if (newState === "completed") {
      iconPath = completedIconPath;
    } else if (newState === "syncing") {
      iconPath = syncingIconPath;
    } else {
      iconPath = defaultIconPath;
    }

    if (!iconPath) {
      logTrayAction("No icon path available, falling back to default");
      iconPath = defaultIconPath;
      if (!iconPath) {
        logTrayAction("No default icon available either, cannot update tray");
        return;
      }
    }

    logTrayAction(`Changing icon to ${newState}`, { iconPath });
    const tray = await TrayIcon.getById(TRAY_ID);

    // Try to update existing tray
    if (tray) {
      try {
        await tray.setIcon(iconPath);
        trayIconState = newState;
        logTrayAction("Updated icon successfully");
        return;
      } catch (e) {
        logTrayAction("Failed to update icon, will recreate tray", e);
      }
    }

    // Fallback: Recreate the tray completely. Like the initial creation, the
    // only attached menu is the small right-click context menu — left-click
    // toggles the custom popover.
    try {
      logTrayAction("Recreating tray with new icon");
      const currentTray = await TrayIcon.getById(TRAY_ID);

      if (currentTray) await currentTray.close();

      // Rebuild + re-attach the context menu (a fresh menu, since the previous
      // one belonged to the closed icon). Left-click is Rust's on
      // macOS/Windows; on Linux it shows the menu (whose "Open Hippius"
      // entry opens the app), see the creation path.
      const contextMenu = await buildTrayContextMenu();
      await TrayIcon.new({
        id: TRAY_ID,
        icon: iconPath,
        iconAsTemplate: false,
        tooltip: "Hippius Cloud",
        menu: contextMenu,
        showMenuOnLeftClick: isLinuxPlatform,
      });

      trayIconState = newState;
      logTrayAction("Tray recreated successfully");
    } catch (err) {
      logTrayAction("Failed to recreate tray", err);
    }
  } catch (err) {
    logTrayAction("Error in setTrayIconSyncing", err);
  }
}

/* ─ Login status watcher (updates context-menu items on login/logout) ──── */
//
// Polls Rust for login status and toggles the login-gated context-menu rows
// when the user signs in/out. The interval handle is parked on `window` so
// React Fast Refresh can clear the previous instance before the new module run
// starts a fresh one — without that, HMR would leave a stack of intervals
// running.
let lastLoginStatus: boolean | null = null;

function startLoginStatusWatcher() {
  const INTERVAL_MS = 2000;

  const tick = async () => {
    const currentLoginStatus = await refreshLoginStatus();

    if (lastLoginStatus !== currentLoginStatus) {
      const wasLoggedIn = lastLoginStatus;
      lastLoginStatus = currentLoginStatus;
      await updateOpenFilesMenuItem();
      await updateOpenVmMenuItem();

      if (!currentLoginStatus && wasLoggedIn) {
        void setTrayIconSyncing(false, false);
      }
    }
  };

  void tick();
  const h = setInterval(tick, INTERVAL_MS);
  if (typeof window !== "undefined") {
    // The handle is stashed on `window` so an HMR re-run can clear the
    // previous interval. Window has no such property, so widen via a local
    // cast — `@ts-expect-error` comments only cover the next line and left
    // the second access failing `next build`'s type check.
    const w = window as Window & {
      __hippiusLoginWatcher?: ReturnType<typeof setInterval>;
    };
    if (w.__hippiusLoginWatcher) clearInterval(w.__hippiusLoginWatcher);
    w.__hippiusLoginWatcher = h;
  }
}

/* ─ Sync Activity watcher — drives the tray icon from snapshots ─ */
let lastSyncSummarySignature = "";

// Serialize tick() so two rapid `sync_progress_snapshot` events can't race on
// the latch / dedup state. Pending snapshots coalesce to latest-wins, matching
// the idempotent "replace prior state" semantics of snapshots.
let isUpdatingTraySnapshot = false;
let pendingTraySnapshot: SyncSnapshot | null = null;

function startSyncActivityWatcher() {
  // Clear any old watcher from HMR
  if (typeof window !== "undefined") {
    // @ts-expect-error custom watcher handle
    if (window.__hippiusSyncWatcherUnsub) {
      // @ts-expect-error custom watcher handle
      (window.__hippiusSyncWatcherUnsub as () => void)();
    }
  }

  const tick = async (progress: SyncSnapshot) => {
    // Coalesce a second concurrent tick into the next run. The latest snapshot
    // wins because snapshot state is "replace prior" — losing an intermediate
    // frame is fine, but losing the final state (e.g. "Sync Failed") is not.
    if (isUpdatingTraySnapshot) {
      pendingTraySnapshot = progress;
      return;
    }
    isUpdatingTraySnapshot = true;

    try {
      // When logged out, the logout effect already forced the default icon;
      // just reset the dedup signature so the next signed-in snapshot repaints.
      if (!isUserLoggedIn()) {
        lastSyncSummarySignature = "";
        return;
      }

      const { icon, latch, signature } = deriveTrayIconState(progress, {
        complete: latchedComplete,
        snapshot: latchedSnapshot,
      });
      // The latch advances on EVERY snapshot, BEFORE the dedup check — the
      // backend's post-completion empty frame must still flip the latch.
      latchedComplete = latch.complete;
      latchedSnapshot = latch.snapshot;

      if (signature === lastSyncSummarySignature) return;
      lastSyncSummarySignature = signature;

      switch (icon) {
        case "default":
          await setTrayIconSyncing(false, false);
          break;
        case "syncing":
          await setTrayIconSyncing(true, false);
          break;
        case "completed":
          await setTrayIconSyncing(false, true);
          break;
        case "none":
          // isActive while latched-complete — leave the icon as-is.
          break;
      }
    } catch (error) {
      console.error("[TraySync] Error updating tray icon:", errorMessage(error));
    } finally {
      isUpdatingTraySnapshot = false;
      // Drain any snapshot that arrived while we were working. Recursive call is
      // safe — the flag is false again, so the tail runs on the next microtask.
      if (pendingTraySnapshot) {
        const next = pendingTraySnapshot;
        pendingTraySnapshot = null;
        void tick(next);
      }
    }
  };

  // Seed from current state, then subscribe to push events. Push events arrive
  // at ≤4 Hz from the Rust backend, which is more responsive than polling AND
  // eliminates a redundant sp_get_snapshot roundtrip every 2 seconds.
  invoke<SyncSnapshot>("sp_get_snapshot")
    .then((snapshot) => void tick(snapshot))
    .catch((err: unknown) =>
      console.error("[TraySync] Initial snapshot:", err),
    );

  listen<SyncSnapshot>("sync_progress_snapshot", (e) => {
    void tick(e.payload);
  })
    .then((unsub) => {
      if (typeof window !== "undefined") {
        // @ts-expect-error custom watcher handle
        window.__hippiusSyncWatcherUnsub = unsub;
      }
    })
    .catch((err: unknown) => console.error("[TraySync] listen failed:", err));
}
