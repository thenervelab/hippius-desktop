"use client";
import { TrayIcon } from "@tauri-apps/api/tray";
import {
  Menu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
} from "@tauri-apps/api/menu";
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { resolveResource } from "@tauri-apps/api/path";
import {
  openAppWindow,
  openFilesPage,
  openVirtualMachinesPage,
} from "@/app/lib/tray/trayWindowActions";
import {
  checkForUpdates,
  getAvailableUpdate,
} from "@/components/updater/checkForUpdates";

import {
  lastUpdatedPercentAtom,
} from "@/app/lib/store/syncAtoms";
import { useAtom, useAtomValue } from "jotai";
import {
  driveStatusesAtom,
  type DriveEntry,
} from "@/app/lib/global-atoms/unpinAtoms";
import { appStore } from "@/lib/store/jotaiStore";
import { toast } from "sonner";
import type { SyncSnapshot } from "../types/syncSnapshot";
import { formatBytes } from "@/app/lib/utils/formatBytes";
import { errorMessage } from "@/app/lib/utils/errorUtils";

/* ─ IDs ───────────────────────────────────────────────────────── */
const TRAY_ID = "hippius-tray";
const QUIT_ID = "quit";
const SYNC_ID = "sync";
const INSTALL_UPDATE = "install-update";
const OPEN_APP_ID = "open-app";
const OPEN_FILES_ID = "open-files";
const OPEN_VM_ID = "open-vm";
const SYNC_ITEM_PREFIX = "sync-activity-item:";
const SYNC_PROGRESS_ID = "sync-progress-summary";
const SYNC_SIZE_ID = "sync-size-info";
const SYNC_DELETE_ID = "sync-delete-summary";

// add cached icon paths + state
const DEFAULT_TRAY_ICON = "icons/TrayIcon.png";
const SYNCING_TRAY_ICON = "icons/SyncingTrayIcon.png";
const SYNC_COMPLETED_TRAY_ICON = "icons/SyncCompletedTrayIcon.png";
let defaultIconPath: string | null = null;
let syncingIconPath: string | null = null;
let completedIconPath: string | null = null;
let trayIconState: "default" | "syncing" | "completed" = "default";

/* ─ State kept across React reloads ───────────────────────────── */
let menuPromise: Promise<Menu> | null = null;
let syncItem: MenuItem | null = null;
let openItemsSeparator: PredefinedMenuItem | null = null;
let syncSectionSeparator: PredefinedMenuItem | null = null;
let openFilesItem: MenuItem | null = null;
let openVmItem: MenuItem | null = null;
const syncRowItems = new Map<string, MenuItem>(); // legacy rows (cleaned up on init)
let syncProgressItem: MenuItem | null = null; // "X of Y files synced" row
let syncSizeItem: MenuItem | null = null; // "208 MB / 1 GB" row
let syncDeleteItem: MenuItem | null = null; // "X files deleted" row

/* ─ Per-drive submenu — Sync Folders ─────────────────────────── */
//
// The "Sync Folders" submenu lists every configured drive with a
// per-drive Pause / Resume action. It's appended to the main tray
// menu after the menu is built (see useTrayInit), and updated
// incrementally whenever `driveStatusesAtom` changes via the effect
// at the bottom of useTrayInit.
//
// Item identity: each drive's submenu item is keyed by label in
// `driveSubmenuItems` so a status flip becomes a single setText()
// call against the existing item, preserving its click handler.
// This is hot-path code (every per-drive event triggers a
// reconciliation), so the diff/patch pattern below is worth the
// complexity over the previous full-rebuild approach.
let driveSubmenu: Submenu | null = null;
const driveSubmenuItems = new Map<string, MenuItem>();
// Cached rendered text per label so we can detect when a row needs
// a setText() (folder rename or status flip). Both kinds of change
// are visible in the rendered string, so a single cache covers both.
const driveSubmenuRenderedText = new Map<string, string>();
const DRIVE_SUBMENU_ID = "drive-submenu";
const DRIVE_SUBMENU_EMPTY_ID = "drive-submenu-empty";
let driveSubmenuEmptyItem: MenuItem | null = null;

// Serialization for rebuildDriveSubmenu. Two events firing in quick
// succession (e.g. pause + status refresh) used to interleave their
// `submenu.items()` calls and could miss rows. The flag below makes
// rebuilds run one at a time; the slot coalesces multiple incoming
// updates while a rebuild is in flight into a single tail call so
// the latest state is always rendered.
let isRebuildingDriveSubmenu = false;
let pendingDriveSubmenuStatuses: Map<string, DriveEntry> | null = null;

/* ─ Latching state — keeps completed info visible after backend resets snapshot */
let latchedComplete = false;
let latchedSnapshot: SyncSnapshot | null = null;

/* ─ Backend payload types ─────────────────────────────────────── */

// Tray data cache — refreshed via get_tray_menu_data Rust command
let trayDataCache: { loggedIn: boolean; credits: number | null; substrateAddress: string | null; timestamp: number } | null = null;
const TRAY_CACHE_DURATION = 5000; // 5 seconds

/**
 * Immediately invalidate the tray data cache so the next check re-queries Rust.
 * Call this on logout so the login-status watcher picks up the change instantly.
 */
export function clearLoginStatusCache() {
  trayDataCache = null;
}

/** Fetch tray data from Rust (login status + credits), with caching. */
async function refreshTrayData(): Promise<{ loggedIn: boolean; credits: number | null; substrateAddress: string | null }> {
  if (trayDataCache && Date.now() - trayDataCache.timestamp < TRAY_CACHE_DURATION) {
    return trayDataCache;
  }
  try {
    const data = await invoke<{ loggedIn: boolean; credits: number | null; substrateAddress: string | null }>("get_tray_menu_data");
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

/* ─ Public: create tray once ──────────────────────────────────── */

export function useTrayInit(isAuthenticated: boolean) {
  // Use atom to watch for sync percentage changes
  const [lastUpdatedPercent, setLastUpdatedPercent] = useAtom(
    lastUpdatedPercentAtom,
  );

  // Effect to update tray when sync state changes — derived entirely from snapshot.
  // Icon and label management is handled exclusively by the startSyncActivityWatcher
  // (which has latching logic to prevent flickering on backend snapshot resets).
  // This effect only handles logout cleanup.
  useEffect(() => {
    // When logged out, force default icon and clear sync label
    if (!isAuthenticated) {
      void setTrayIconSyncing(false, false);
      void updateTraySyncLabel(null);
      // Clear latched sync state so the next account starts fresh
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
    if (menuPromise) return;

    menuPromise = (async () => {
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

      // Optional update menu item
      const update = await getAvailableUpdate();
      let installUpdateMenuItem: MenuItem | undefined;
      if (update) {
        installUpdateMenuItem = await MenuItem.new({
          id: INSTALL_UPDATE,
          text: "Install Update",
          action: async () => {
            await checkForUpdates();
          },
        });
      }

      const openAppItem = await MenuItem.new({
        id: OPEN_APP_ID,
        text: "Open Hippius",
        action: async () => {
          await openAppWindow();
        },
      });

      // Check login status asynchronously (covers both OAuth and mnemonic logins)
      const loggedIn = await refreshLoginStatus();

      const openFilesMenuItem = await MenuItem.new({
        id: OPEN_FILES_ID,
        text: "Open Files",
        enabled: loggedIn,
        action: async () => {
          if (!isUserLoggedIn() && !(await refreshLoginStatus())) return;
          await openFilesPage();
        },
      });
      openFilesItem = openFilesMenuItem;

      const openVmMenuItem = await MenuItem.new({
        id: OPEN_VM_ID,
        text: "Open Virtual Machines",
        enabled: loggedIn,
        action: async () => {
          if (!isUserLoggedIn() && !(await refreshLoginStatus())) return;
          await openVirtualMachinesPage();
        },
      });
      openVmItem = openVmMenuItem;

      openItemsSeparator = await PredefinedMenuItem.new({
        item: "Separator",
      });

      // Quit item - create this early but add it last
      const quit = await MenuItem.new({
        id: QUIT_ID,
        text: "Quit Hippius",
        action: async () => {
          await invoke("app_close");
        },
      });

      // Separator between sync section (top) and nav section
      syncSectionSeparator = await PredefinedMenuItem.new({
        item: "Separator",
      });

      // Build the initial menu — sync items will be inserted at position 0 dynamically
      // Navigation + action links come after the sync section separator
      const menu = await Menu.new({
        items: [
          syncSectionSeparator,
          openAppItem,
          openFilesMenuItem,
          openVmMenuItem,
          ...(installUpdateMenuItem ? [installUpdateMenuItem] : []),
        ],
      });

      if (!existingTray) {
        await TrayIcon.new({
          id: TRAY_ID,
          icon: defaultIconPath!,
          iconAsTemplate: false,
          tooltip: "Hippius Cloud",
          menu,
          menuOnLeftClick: true,
        });
        trayIconState = "default";
      }

      // Start watcher for sync activity after menu exists
      startSyncActivityWatcher();
      
      // Clear any stale file entries from previous sessions
      void clearTrayFileEntries();

      // Start login status watcher (updates tray menu on login/logout)
      startLoginStatusWatcher();

      // Build the per-drive Sync Folders submenu. Initially shows
      // a placeholder "(no folders)" entry; the effect at the bottom
      // of useTrayInit subscribes to `driveStatusesAtom` and rebuilds
      // the contents whenever drive statuses change.
      driveSubmenuEmptyItem = await MenuItem.new({
        id: DRIVE_SUBMENU_EMPTY_ID,
        text: "(no sync folders)",
        enabled: false,
      });
      driveSubmenu = await Submenu.new({
        id: DRIVE_SUBMENU_ID,
        text: "Sync Folders",
        items: [driveSubmenuEmptyItem],
      });
      await menu.append(driveSubmenu);

      // Drain any driveStatusesAtom updates that landed while the
      // menu-builder was awaiting resource resolution / IPCs above.
      // The rebuild effect at the bottom of useTrayInit bails when
      // `driveSubmenu` is still null, so updates that arrive during
      // startup (e.g. the first `hcfs_drive_status_changed` from
      // `add_local_sync_folder`) can be missed. Reading the atom
      // directly here catches them, and serialization in
      // `rebuildDriveSubmenu` handles the race with a concurrent
      // rebuild from the effect.
      void rebuildDriveSubmenu(appStore.get(driveStatusesAtom));

      // Add separator before quit
      if (!openItemsSeparator) {
        openItemsSeparator = await PredefinedMenuItem.new({
          item: "Separator",
        });
      }
      await menu.append(openItemsSeparator);

      // Add quit item at the end
      await menu.append(quit);

      return menu;
    })();
  }, []);

  // Subscribe to per-drive status changes and rebuild the Sync Folders
  // submenu whenever the map changes. Mounted in the same hook so the
  // submenu lifecycle stays tied to the tray itself.
  const driveStatuses = useAtomValue(driveStatusesAtom);
  useEffect(() => {
    void rebuildDriveSubmenu(driveStatuses);
  }, [driveStatuses]);
}

/**
 * Reconcile the Sync Folders submenu with the current per-drive
 * status map. Called from a useAtomValue effect on every change to
 * `driveStatusesAtom`.
 *
 * Strategy: incremental diff against `driveSubmenuItems`:
 *   - Status flip on existing row → setText() in place. Cheap, the
 *     existing click handler stays alive.
 *   - Folder rename on existing row → setText() in place.
 *   - Drive removed → submenu.remove() the item.
 *   - Drive added → create a new MenuItem at the alphabetically
 *     correct position. Maintaining sort order on insert means
 *     removing every item from the insertion point onward and
 *     re-appending them along with the new item; that's still
 *     cheaper than the previous full-rebuild approach because the
 *     common case (status flip) is now a single setText().
 *
 * Click handlers read the current status from `appStore` at click
 * time rather than capturing it from the outer scope, so setText-
 * only updates can't leave a stale `needsResume` value behind.
 *
 * Concurrency: serialized via `isRebuildingDriveSubmenu`. If a
 * second update arrives mid-rebuild, the latest one is recorded in
 * `pendingDriveSubmenuStatuses` and processed as a tail call once
 * the in-flight rebuild commits. This both (a) prevents two
 * `submenu.items()` calls from interleaving and (b) coalesces a
 * burst of N events into a single rebuild for the final state.
 */
async function rebuildDriveSubmenu(
  statuses: Map<string, DriveEntry>
): Promise<void> {
  if (!driveSubmenu) return;

  // Coalesce rapid updates into the in-flight rebuild's tail call.
  if (isRebuildingDriveSubmenu) {
    pendingDriveSubmenuStatuses = statuses;
    return;
  }
  isRebuildingDriveSubmenu = true;

  try {
    await reconcileDriveSubmenu(statuses);
  } catch (err) {
    console.error("[Tray] Failed to reconcile drive submenu:", err);
  } finally {
    isRebuildingDriveSubmenu = false;
  }

  // Drain any state that arrived during the rebuild. Recursive call
  // is safe — `isRebuildingDriveSubmenu` is false again by now and
  // we're past the await boundary.
  if (pendingDriveSubmenuStatuses) {
    const next = pendingDriveSubmenuStatuses;
    pendingDriveSubmenuStatuses = null;
    void rebuildDriveSubmenu(next);
  }
}

/**
 * Pure-ish reconciliation step: assumes the rebuild lock is held by
 * the caller. Mutates `driveSubmenu`, `driveSubmenuItems`, and
 * `driveSubmenuRenderedText` to converge on `statuses`.
 */
async function reconcileDriveSubmenu(
  statuses: Map<string, DriveEntry>
): Promise<void> {
  if (!driveSubmenu) return;

  // Empty case: tear down everything and restore the placeholder.
  // This intentionally short-circuits even if we were already in the
  // empty state — checking for the placeholder's presence costs an
  // extra round-trip and the empty case is rare enough not to matter.
  if (statuses.size === 0) {
    for (const item of driveSubmenuItems.values()) {
      await driveSubmenu.remove(item);
    }
    driveSubmenuItems.clear();
    driveSubmenuRenderedText.clear();
    if (driveSubmenuEmptyItem) {
      // Make sure no stale placeholder lingers in the submenu.
      try {
        await driveSubmenu.remove(driveSubmenuEmptyItem);
      } catch {
        // Already removed — fine.
      }
    }
    driveSubmenuEmptyItem = await MenuItem.new({
      id: DRIVE_SUBMENU_EMPTY_ID,
      text: "(no sync folders)",
      enabled: false,
    });
    await driveSubmenu.append(driveSubmenuEmptyItem);
    return;
  }

  // We're transitioning out of (or staying out of) the empty state.
  // Drop the placeholder if it's still attached.
  if (driveSubmenuEmptyItem) {
    try {
      await driveSubmenu.remove(driveSubmenuEmptyItem);
    } catch {
      // Already removed — fine.
    }
    driveSubmenuEmptyItem = null;
  }

  // Remove drives that no longer exist in the map.
  for (const [label, item] of Array.from(driveSubmenuItems.entries())) {
    if (!statuses.has(label)) {
      await driveSubmenu.remove(item);
      driveSubmenuItems.delete(label);
      driveSubmenuRenderedText.delete(label);
    }
  }

  // Update text on rows whose folder name or status changed. We
  // compare against the cached rendered text — setText only fires
  // when the displayed string actually needs to change.
  for (const [label, entry] of statuses) {
    const item = driveSubmenuItems.get(label);
    if (!item) continue;
    const desiredText = renderDriveSubmenuText(entry);
    if (driveSubmenuRenderedText.get(label) !== desiredText) {
      try {
        await item.setText(desiredText);
        driveSubmenuRenderedText.set(label, desiredText);
      } catch (err) {
        console.error(
          `[Tray] Failed to update drive row '${label}':`,
          err
        );
      }
    }
  }

  // Add drives that aren't in the submenu yet. To preserve
  // alphabetical order on insert, we remove all items that should
  // appear after the new one and re-append them along with the
  // new item. Status flips and renames hit the cheap path above;
  // only true adds pay this cost, and adding a drive is rare.
  const sortedLabels = Array.from(statuses.entries())
    .sort(([, a], [, b]) => a.folderName.localeCompare(b.folderName))
    .map(([label]) => label);

  const missing: string[] = sortedLabels.filter(
    (label) => !driveSubmenuItems.has(label)
  );
  if (missing.length === 0) return;

  // Find the earliest insertion point: the first label in the
  // sorted list that's missing from the current submenu. Everything
  // at or after that index needs to come off so we can re-append
  // in order.
  const firstMissingIndex = sortedLabels.findIndex(
    (label) => !driveSubmenuItems.has(label)
  );
  const labelsToReappend = sortedLabels.slice(firstMissingIndex);

  // Remove existing items from the tail (those that are already in
  // the submenu but need to come after a new sibling).
  for (const label of labelsToReappend) {
    const existingItem = driveSubmenuItems.get(label);
    if (existingItem) {
      await driveSubmenu.remove(existingItem);
      driveSubmenuItems.delete(label);
      driveSubmenuRenderedText.delete(label);
    }
  }

  // Re-append everything from the insertion point in alphabetical
  // order. New items are created here; previously-existing items
  // are recreated (their old MenuItem references were dropped from
  // the submenu above and the click handlers go with them, but the
  // new handlers below capture the same label and read the current
  // status from appStore at click time).
  for (const label of labelsToReappend) {
    const entry = statuses.get(label);
    if (!entry) continue;
    const item = await createDriveRowItem(label, entry);
    driveSubmenuItems.set(label, item);
    driveSubmenuRenderedText.set(label, renderDriveSubmenuText(entry));
    await driveSubmenu.append(item);
  }
}

function renderDriveSubmenuText(entry: DriveEntry): string {
  // Only `active` drives get the "Pause" action — `paused` and the new
  // `error` variant (emitted on per-drive init failure) both surface
  // "Resume", which triggers the re-init retry path in Rust.
  return entry.status.kind === "active"
    ? `${entry.folderName} — Pause`
    : `${entry.folderName} — Resume`;
}

/**
 * Build a single drive row MenuItem. Click handler reads the current
 * status from `appStore.get(driveStatusesAtom)` at click time so
 * setText-only updates above don't leave a stale `needsResume` capture.
 */
async function createDriveRowItem(
  label: string,
  entry: DriveEntry
): Promise<MenuItem> {
  const text = renderDriveSubmenuText(entry);
  return MenuItem.new({
    id: `drive-row:${label}`,
    text,
    action: async () => {
      // Read the current entry from the atom at click time. setText
      // updates above keep the menu text in sync but don't replace
      // the click handler, so capturing `needsResume` from the outer
      // scope would let the user click "Pause" on a row whose
      // current text says "Resume" if Rust raced ahead.
      const currentMap = appStore.get(driveStatusesAtom);
      const current = currentMap.get(label);
      if (!current) {
        // Drive disappeared between rebuild and click. Nothing to
        // do; the next rebuild will drop the row.
        return;
      }
      const folderName = current.folderName;
      // Both `paused` and `error` take the resume branch — resume_drive
      // re-invokes initialize_sync_inner, which is the correct retry
      // action for an errored drive.
      const needsResume = current.status.kind !== "active";
      try {
        if (needsResume) {
          // Mnemonic is intentionally not passed: the tray has no
          // access to wallet auth context (would create a circular
          // import). The Rust resume path falls back to the
          // persisted master mnemonic for the active account, so
          // resume from the tray works for any drive that's been
          // unlocked at least once in this session.
          await invoke("resume_drive", { label, mnemonic: null });
          toast.success(`Sync resumed for "${folderName}"`);
        } else {
          await invoke("pause_drive", { label });
          toast.success(`Sync paused for "${folderName}"`);
        }
      } catch (err) {
        console.error(
          `[Tray] Failed to ${needsResume ? "resume" : "pause"} drive '${label}':`,
          err
        );
        if (needsResume) {
          toast.error(
            `Failed to resume "${folderName}". Open the Settings page and try from there.`
          );
        } else {
          toast.error(`Failed to pause "${folderName}".`);
        }
      }
    },
  });
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
// Replace setTrayIconSyncing with a more robust implementation
async function setTrayIconSyncing(
  isSyncing: boolean,
  isCompleted: boolean = false,
) {
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
      // logTrayAction("Skipping icon update - already in correct state", { isSyncing, isCompleted, state: trayIconState });
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

    // Fallback: Recreate the tray completely
    try {
      logTrayAction("Recreating tray with new icon");
      const currentTray = await TrayIcon.getById(TRAY_ID);
      const menu = await (menuPromise || Promise.resolve(null));

      if (currentTray) await currentTray.close();

      await TrayIcon.new({
        id: TRAY_ID,
        icon: iconPath,
        iconAsTemplate: false,
        tooltip: "Hippius Cloud",
        menu: menu || undefined,
        menuOnLeftClick: true,
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

/* ─ Update tray sync label (simpler version without percentage) ─── */
// Mutex to prevent concurrent updates causing duplicates
let isUpdatingTrayLabel = false;
let pendingTrayLabel: string | null | undefined = undefined; // undefined = no pending, null = clear label

async function updateTraySyncLabel(label: string | null) {
  // If already updating, queue this label for when current update finishes
  if (isUpdatingTrayLabel) {
    pendingTrayLabel = label;
    return;
  }
  isUpdatingTrayLabel = true;
  
  try {
    const menu = await (menuPromise ?? Promise.resolve<Menu | null>(null));
    if (!menu) {
      isUpdatingTrayLabel = false;
      // Process pending if any
      if (pendingTrayLabel !== undefined) {
        const nextLabel = pendingTrayLabel;
        pendingTrayLabel = undefined;
        void updateTraySyncLabel(nextLabel);
      }
      return;
    }

    const items = await menu.items();

    // ALWAYS search for existing sync items in the menu (don't rely on stale syncItem reference)
    const existingItems = items.filter((i) => i.id === SYNC_ID);
    
    // If there are multiple, remove all but keep track of first one
    if (existingItems.length > 1) {
      console.log(`[TraySync] Found ${existingItems.length} sync items, removing duplicates`);
      for (let i = 1; i < existingItems.length; i++) {
        await menu.remove(existingItems[i]);
      }
    }
    
    syncItem = existingItems[0] as MenuItem | null;

    // If label is null, we want to remove the sync item
    if (label === null) {
      if (syncItem) {
        await menu.remove(syncItem);
        syncItem = null;
      }
      return;
    }

    // If sync item doesn't exist yet, create it and add it to the menu
    if (!syncItem) {
      syncItem = await MenuItem.new({
        id: SYNC_ID,
        text: label,
        enabled: false,
      });

      // Insert at position 0 — sync info goes at the very top of the menu
      await menu.insert(syncItem, 0);
    } else {
      await syncItem.setText(label);
    }
  } finally {
    isUpdatingTrayLabel = false;
    // Process pending label if any
    if (pendingTrayLabel !== undefined) {
      const nextLabel = pendingTrayLabel;
      pendingTrayLabel = undefined;
      void updateTraySyncLabel(nextLabel);
    }
  }
}

/* ─ ID prefix for file entry rows ────────────────────────────── */
const FILE_ENTRY_PREFIX = "file-entry:";
const fileEntryItems = new Map<string, MenuItem>();

/* ─ Update tray menu with file entries ───────────────────────── */
// NOTE: File entries are no longer shown in tray menu.
// This function now only clears any stale entries and returns.
async function clearTrayFileEntries() {
  const menu = await (menuPromise ?? Promise.resolve<Menu | null>(null));
  if (!menu) return;

  try {
    // Remove existing file entry items
    for (const [, item] of fileEntryItems.entries()) {
      try {
        await menu.remove(item);
      } catch { }
    }
    fileEntryItems.clear();

    // Also remove any orphaned items
    const items = await menu.items();
    for (const item of items) {
      if (typeof item.id === 'string' && item.id.startsWith(FILE_ENTRY_PREFIX)) {
        try {
          await menu.remove(item);
        } catch { }
      }
    }
  } catch (error) {
    console.error("Error clearing tray file entries:", error);
  }
}


/* ─ Login status watcher (updates tray menu on login/logout) ──── */
//
// Polls Rust for login status and resets login-gated tray rows when the user
// signs out. This is an INTENTIONAL process-lifetime singleton: it is started
// exactly once (via the `menuPromise` guard) and is deliberately NOT torn down
// on logout, because this poll IS the logout-detection mechanism for the tray —
// stopping it on logout would defeat its purpose. The tray menu lives at the OS
// level (not under the React auth boundary), so it has no unmount to hook into.
// The `window.__hippiusLoginWatcher` handle is purely an HMR guard (clear the
// previous Fast-Refresh instance so dev reloads don't stack intervals) — it is
// NOT a lifecycle teardown handle. The steady-state cost is one ~2s SQLite read.
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
        void updateTraySyncLabel(null);
      }
    }
  };

  void tick();
  const h = setInterval(tick, INTERVAL_MS);
  if (typeof window !== "undefined") {
    // @ts-expect-error custom watcher handle
    if (window.__hippiusLoginWatcher) clearInterval(window.__hippiusLoginWatcher);
    // @ts-expect-error custom watcher handle
    window.__hippiusLoginWatcher = h;
  }
}

/* ─ Sync Activity watcher (polls localStorage for summary rows) ─ */
let lastSyncSummarySignature = "";

// Serialize tick() so two rapid `sync_progress_snapshot` events can't both
// observe `syncProgressItem === null` and each insert a duplicate row. Each
// tick has several `await` points (menu.items(), MenuItem.new(), menu.insert())
// against Tauri IPC, so concurrent runs are the common case under a failure
// storm — the backend emits a snapshot per file-failure + per byte-progress
// tick. Pending snapshots are coalesced to latest-wins, matching the
// idempotent "replace prior state" semantics of snapshots. Mirrors the
// `isUpdatingTrayLabel` pattern used by `updateTraySyncLabel` above.
let isUpdatingTraySnapshot = false;
let pendingTraySnapshot: SyncSnapshot | null = null;

/**
 * Reconcile module-level refs for the sync summary rows against the
 * current menu contents. If the menu has drifted (duplicate inserts
 * from a previous concurrent-tick race, or module state lost to HMR
 * while the menu survived), keep the first matching item and remove
 * the rest. Runs once per tick; cheap because it reuses a single
 * `menu.items()` call that the tick needs anyway.
 */
async function reconcileSummaryRowRefs(menu: Menu): Promise<void> {
  const items = await menu.items();

  for (const [id, assignRef] of [
    [SYNC_PROGRESS_ID, (it: MenuItem | null) => { syncProgressItem = it; }],
    [SYNC_SIZE_ID, (it: MenuItem | null) => { syncSizeItem = it; }],
    [SYNC_DELETE_ID, (it: MenuItem | null) => { syncDeleteItem = it; }],
  ] as const) {
    const matches = items.filter((i) => i.id === id);
    if (matches.length === 0) {
      assignRef(null);
      continue;
    }
    assignRef(matches[0] as MenuItem);
    if (matches.length > 1) {
      console.log(
        `[TraySync] Found ${matches.length} '${id}' items, removing duplicates`,
      );
      for (let i = 1; i < matches.length; i++) {
        try {
          await menu.remove(matches[i]);
        } catch {
          /* already removed */
        }
      }
    }
  }
}

function startSyncActivityWatcher() {
  // Like the login-status watcher, this is an intentional process-lifetime
  // singleton (started once via the `menuPromise` guard, never torn down on
  // logout — the OS tray has no React unmount). The `__hippiusSyncWatcherUnsub`
  // handle below is an HMR guard only (clear the prior Fast-Refresh listener so
  // dev reloads don't stack `sync_progress_snapshot` subscriptions), NOT a
  // logout/lifecycle teardown.
  if (typeof window !== "undefined") {
    // @ts-expect-error custom watcher handle
    if (window.__hippiusSyncWatcherUnsub) {
      // @ts-expect-error custom watcher handle
      (window.__hippiusSyncWatcherUnsub as () => void)();
    }
  }

  const tick = async (progress: SyncSnapshot) => {
    // Coalesce a second concurrent tick into the next run. The latest
    // snapshot wins because snapshot state is "replace prior" — losing
    // an intermediate frame is fine, but losing the final state (e.g.
    // "Sync Failed") is not.
    if (isUpdatingTraySnapshot) {
      pendingTraySnapshot = progress;
      return;
    }
    isUpdatingTraySnapshot = true;

    try {
      const menu = await (menuPromise ?? Promise.resolve<Menu | null>(null));
      if (!menu) return;

      // Align module refs with the current menu before deciding whether
      // to insert anything new. Catches orphaned duplicate rows from any
      // prior race and stops the tick from re-inserting alongside them.
      await reconcileSummaryRowRefs(menu);

      // When logged out, clear sync rows and skip updates.
      // The data stays in the Rust backend so it can be shown after re-login.
      if (!isUserLoggedIn()) {
        if (syncProgressItem) {
          try { await menu.remove(syncProgressItem); } catch { /* already removed */ }
          syncProgressItem = null;
        }
        if (syncSizeItem) {
          try { await menu.remove(syncSizeItem); } catch { /* already removed */ }
          syncSizeItem = null;
        }
        if (syncDeleteItem) {
          try { await menu.remove(syncDeleteItem); } catch { /* already removed */ }
          syncDeleteItem = null;
        }
        lastSyncSummarySignature = "";
        return;
      }

      // Clean up any legacy per-file rows from old implementation
      await removeAllSyncActivityRows(menu);
      const inProgressCount = progress.files.filter(
        (f) => f.status === "inProgress" || f.status === "pending"
      ).length;
      // Prefer `effectiveInProgress` over raw `isActive`: the Rust
      // `fixup_stalled_completion` flips `effectiveInProgress=false`
      // (but leaves `isActive=true` alone) when hcfs-client's file
      // watcher detects its own writes and leaves the session stuck
      // at 100%. Reading `isActive` here would pin the tray at
      // "⟳ Syncing: 100%" forever in that state. The widget already
      // uses `effectiveInProgress` / `effectiveCompleted` for the same
      // reason — see `SyncStatusDialog.test.tsx:215` and the design
      // note in `CLAUDE.md` ("Stalled completion fixup").
      //
      // `isPreparing` covers the file-watcher-triggered window between
      // `SyncStarted` and the first session-populated snapshot. Rust
      // sets `widgetState="preparing"` in `progress.rs::apply_preparing_override`;
      // including it in `isActive` here makes the tray icon switch to
      // syncing immediately when the user drops a folder via Finder,
      // not only after `on_sync_plan_ready` fires several seconds later.
      const isPreparing = progress.widgetState === "preparing";
      const isActive = isPreparing ||
        progress.effectiveInProgress ||
        inProgressCount > 0 ||
        (progress.totalFiles > 0 && progress.completedFiles < progress.totalFiles && progress.failedFiles === 0);
      const hasFailed = progress.failedFiles > 0;
      const isCompleted = !isActive && (progress.completedFiles > 0 || hasFailed);

      // Count delete actions in the current file list
      const recentDeleteCount = progress.files.filter(
        (f) => f.action === "local_delete" || f.action === "remote_delete"
      ).length;

      // Latch: when we detect completion, capture the snapshot so a subsequent
      // snapshot reset (new empty cycle) doesn't hide the tray rows.
      // Also update the latch when a NEW session completes (different startedAt).
      if (isCompleted && (!latchedComplete || progress.startedAt !== latchedSnapshot?.startedAt)) {
        latchedComplete = true;
        latchedSnapshot = progress;
      }
      // Unlatch when a NEW session becomes active AND has real files,
      // OR when we enter preparing (file-watcher-initiated cycles flip
      // straight from completed-latched to preparing with no
      // intermediate files-present state; without this branch the tray
      // would stay on "Sync Complete" until plan_ready fires several
      // seconds later instead of immediately switching to
      // "Preparing sync…"). For preparing the startedAt check is
      // skipped — the snapshot's session may not have any startedAt
      // yet at the moment of the preparing flip, so requiring a
      // distinct value would block the unlatch.
      if (isActive && latchedComplete && (isPreparing
        || (progress.startedAt !== null && progress.startedAt !== latchedSnapshot?.startedAt && progress.totalFiles > 0))) {
        latchedComplete = false;
        latchedSnapshot = null;
      }

      // Use latched state if backend has reset the snapshot
      // Don't switch away from latched snapshot for empty active sessions
      // (totalFiles=0, before on_sync_plan_ready) — they'd cause a brief
      // flicker in the tray between "Sync Complete" and an empty state.
      // Preparing is the one empty-session shape we DO want to surface
      // (the user just dropped a folder; they need feedback now).
      const isNewSessionWithFiles = isActive && progress.startedAt !== null
        && progress.startedAt !== latchedSnapshot?.startedAt && progress.totalFiles > 0;
      const effectiveCompleted = isCompleted || (latchedComplete && !isPreparing && !isNewSessionWithFiles);
      const effectiveSnapshot = effectiveCompleted && !isCompleted && latchedSnapshot
        ? latchedSnapshot
        : progress;
      const effectiveDeleteCount = effectiveCompleted && !isCompleted && latchedSnapshot
        ? latchedSnapshot.files.filter(
            (f) => f.action === "local_delete" || f.action === "remote_delete"
          ).length
        : recentDeleteCount;

      // Build signature to avoid redundant updates.
      // Include startedAt so different sessions with identical metrics still trigger updates.
      const signature = `${isActive}:${effectiveCompleted}:${hasFailed}:${effectiveSnapshot.completedFiles}/${effectiveSnapshot.totalFiles}:${effectiveSnapshot.failedFiles}:${effectiveSnapshot.overallPercent}:${effectiveSnapshot.progressBytes}:del${effectiveDeleteCount}:sa${effectiveSnapshot.startedAt}`;
      if (signature === lastSyncSummarySignature) return;
      lastSyncSummarySignature = signature;

      if (!isActive && !effectiveCompleted && effectiveDeleteCount === 0) {
        // No sync activity and no recent deletes — remove summary rows,
        // the sync header, and reset the icon.
        //
        // Clearing the header (SYNC_ID item) here is load-bearing: a
        // no-op periodic cycle emits SyncStarted → a ~1s "preparing"
        // snapshot that sets the header to "⟳ Preparing sync…", then
        // SyncCompleted whose idle snapshot lands here. Without this
        // updateTraySyncLabel(null) the header text is never cleared
        // (the detail-row removals below don't touch SYNC_ID), so the
        // tray is frozen on "Preparing sync…" forever even though
        // nothing is syncing. Mirrors the logout-cleanup path.
        await updateTraySyncLabel(null);
        if (syncProgressItem) {
          try { await menu.remove(syncProgressItem); } catch { /* already removed */ }
          syncProgressItem = null;
        }
        if (syncSizeItem) {
          try { await menu.remove(syncSizeItem); } catch { /* already removed */ }
          syncSizeItem = null;
        }
        if (syncDeleteItem) {
          try { await menu.remove(syncDeleteItem); } catch { /* already removed */ }
          syncDeleteItem = null;
        }
        await setTrayIconSyncing(false, false);
        return;
      }

      // Update the header label and icon to reflect the watcher's view.
      // This is the SINGLE source of truth for tray icon/label state.
      if (isActive && !latchedComplete) {
        if (progress.totalFiles > 0) {
          const percent = progress.overallPercent;
          if (percent === 0 && progress.completedFiles === 0 && progress.progressBytes === 0) {
            await updateTraySyncLabel(`⟳ Preparing sync…`);
          } else {
            await updateTraySyncLabel(`⟳ Syncing: ${percent}%`);
          }
        } else {
          await updateTraySyncLabel(`⟳ Preparing sync…`);
        }
        await setTrayIconSyncing(true, false);
      } else if (effectiveCompleted && hasFailed) {
        await updateTraySyncLabel(`⚠ Sync Failed`);
        // Use default icon for failed state (not syncing, not completed)
        await setTrayIconSyncing(false, false);
      } else if (effectiveCompleted) {
        await updateTraySyncLabel(`✓ Sync Complete`);
        await setTrayIconSyncing(false, true);
      }

      // Build progress + size rows only when there's an active or completed sync session
      if (isActive || effectiveCompleted) {
        let progressText: string;
        let sizeText: string | null = null;

        if (isActive && !latchedComplete) {
          // In-progress: show current progress
          if (progress.totalFiles > 0 && progress.overallPercent === 0 && progress.completedFiles === 0 && progress.progressBytes === 0) {
            progressText = `${progress.totalFiles} ${progress.totalFiles === 1 ? 'file' : 'files'} pending`;
          } else {
            progressText = progress.totalFiles > 0
              ? `${progress.completedFiles} of ${progress.totalFiles} ${progress.totalFiles === 1 ? 'file' : 'files'} synced`
              : "Preparing files…";
          }
          // Prefer the intent overlay's "X of Y" while the user-dragged
          // batch is in flight — this matches what the user expects to
          // see ("I added 10 GB; 5 GB done"), unlike the per-cycle bytes
          // which restart each sync attempt. `??` (not `||`) preserves
          // the 0-vs-undefined distinction: an explicit `intentTotalBytes: 0`
          // fails the `> 0` guard and we fall through to the per-cycle line.
          if (progress.intentActive && (progress.intentTotalBytes ?? 0) > 0) {
            sizeText = `${formatBytes(progress.intentCompletedBytes ?? 0)} of ${formatBytes(progress.intentTotalBytes ?? 0)}`;
          } else if (progress.bytesExpected > 0) {
            sizeText = `${formatBytes(progress.progressBytes)} / ${formatBytes(progress.bytesExpected)}`;
          }
        } else if (effectiveCompleted && (effectiveSnapshot.failedFiles > 0)) {
          // Failed: show failure counts
          const totalFiles = effectiveSnapshot.completedFiles + effectiveSnapshot.failedFiles;
          progressText = `${effectiveSnapshot.failedFiles} of ${totalFiles} ${totalFiles === 1 ? 'file' : 'files'} failed`;
          if (effectiveSnapshot.bytesExpected > 0) {
            sizeText = `${formatBytes(effectiveSnapshot.progressBytes)} / ${formatBytes(effectiveSnapshot.bytesExpected)}`;
          }
        } else {
          // Completed successfully: show final counts
          const syncedFiles = effectiveSnapshot.completedFiles;
          const deletedInSession = effectiveSnapshot.files.filter(
            (f) => (f.action === "local_delete" || f.action === "remote_delete") && f.status === "completed"
          ).length;
          const nonDeleteSynced = syncedFiles - deletedInSession;

          if (deletedInSession > 0 && nonDeleteSynced <= 0) {
            progressText = `${deletedInSession} ${deletedInSession === 1 ? 'file' : 'files'} deleted`;
          } else if (deletedInSession > 0 && nonDeleteSynced > 0) {
            progressText = `${nonDeleteSynced} synced · ${deletedInSession} deleted`;
          } else {
            const totalFiles = effectiveSnapshot.completedFiles + effectiveSnapshot.failedFiles;
            progressText = `${effectiveSnapshot.completedFiles} of ${totalFiles} ${totalFiles === 1 ? 'file' : 'files'} synced`;
          }
          if (effectiveSnapshot.bytesExpected > 0) {
            sizeText = formatBytes(effectiveSnapshot.bytesExpected);
          }
        }

        // Find insert position: right after the sync header (SYNC_ID)
        const items = await menu.items();
        let insertPos = items.findIndex((i) => i.id === SYNC_ID);
        insertPos = insertPos >= 0 ? insertPos + 1 : 0;

        // Update or create progress row
        if (!syncProgressItem) {
          syncProgressItem = await MenuItem.new({
            id: SYNC_PROGRESS_ID,
            text: progressText,
            enabled: false,
          });
          await menu.insert(syncProgressItem, insertPos);
        } else {
          await syncProgressItem.setText(progressText);
        }

        // Update or create size row
        if (sizeText) {
          const itemsAfterProgress = await menu.items();
          const progressIdx = itemsAfterProgress.findIndex((i) => i.id === SYNC_PROGRESS_ID);
          const sizeInsertPos = progressIdx >= 0 ? progressIdx + 1 : insertPos + 1;

          if (!syncSizeItem) {
            syncSizeItem = await MenuItem.new({
              id: SYNC_SIZE_ID,
              text: sizeText,
              enabled: false,
            });
            await menu.insert(syncSizeItem, sizeInsertPos);
          } else {
            await syncSizeItem.setText(sizeText);
          }
        } else if (syncSizeItem) {
          try { await menu.remove(syncSizeItem); } catch { /* already removed */ }
          syncSizeItem = null;
        }
      } else {
        // No active/completed sync — remove progress/size rows if they exist
        if (syncProgressItem) {
          try { await menu.remove(syncProgressItem); } catch { /* already removed */ }
          syncProgressItem = null;
        }
        if (syncSizeItem) {
          try { await menu.remove(syncSizeItem); } catch { /* already removed */ }
          syncSizeItem = null;
        }
      }

      // Show delete summary row only if there are recent deletions that
      // aren't already reflected in the progress row. During active sync,
      // the progress text already uses the right label ("deleted" vs "synced").
      // On completion, the progress text handles mixed/delete-only cases.
      const deletesInProgressText = (effectiveCompleted && !hasFailed) || (isActive && !latchedComplete);
      if (effectiveDeleteCount > 0 && !deletesInProgressText) {
        const deleteText = `${effectiveDeleteCount} ${effectiveDeleteCount === 1 ? 'file' : 'files'} deleted`;

        // Find insert position: after size row, or after progress row, or after sync header
        const itemsForDelete = await menu.items();
        let deleteInsertPos: number;
        const sizeIdx = itemsForDelete.findIndex((i) => i.id === SYNC_SIZE_ID);
        const progIdx = itemsForDelete.findIndex((i) => i.id === SYNC_PROGRESS_ID);
        const headerIdx = itemsForDelete.findIndex((i) => i.id === SYNC_ID);
        if (sizeIdx >= 0) {
          deleteInsertPos = sizeIdx + 1;
        } else if (progIdx >= 0) {
          deleteInsertPos = progIdx + 1;
        } else if (headerIdx >= 0) {
          deleteInsertPos = headerIdx + 1;
        } else {
          deleteInsertPos = 0;
        }

        if (!syncDeleteItem) {
          syncDeleteItem = await MenuItem.new({
            id: SYNC_DELETE_ID,
            text: deleteText,
            enabled: false,
          });
          await menu.insert(syncDeleteItem, deleteInsertPos);
        } else {
          await syncDeleteItem.setText(deleteText);
        }

        // If there's no active sync or completed sync but we have deletes,
        // ensure the sync header and icon reflect the delete activity
        if (!isActive && !effectiveCompleted) {
          await updateTraySyncLabel(`✓ Sync Complete`);
          await setTrayIconSyncing(false, true);
        }
      } else if (syncDeleteItem) {
        try { await menu.remove(syncDeleteItem); } catch { /* already removed */ }
        syncDeleteItem = null;
      }
    } catch (error) {
      console.error("[TraySync] Error updating sync summary:", errorMessage(error));
    } finally {
      isUpdatingTraySnapshot = false;
      // Drain any snapshot that arrived while we were working. Recursive
      // call is safe — the flag is false again, so the tail runs on the
      // next microtask without re-entering this frame.
      if (pendingTraySnapshot) {
        const next = pendingTraySnapshot;
        pendingTraySnapshot = null;
        void tick(next);
      }
    }
  };

  // Seed from current state, then subscribe to push events.
  // Replaces the old 2s polling loop — push events arrive at ≤4 Hz
  // from the Rust backend, which is more responsive AND eliminates
  // a redundant sp_get_snapshot IPC roundtrip every 2 seconds.
  invoke<SyncSnapshot>("sp_get_snapshot")
    .then((snapshot) => void tick(snapshot))
    .catch((err: unknown) => console.error("[TraySync] Initial snapshot:", err));

  listen<SyncSnapshot>("sync_progress_snapshot", (e) => {
    void tick(e.payload);
  }).then((unsub) => {
    if (typeof window !== "undefined") {
      // @ts-expect-error custom watcher handle
      window.__hippiusSyncWatcherUnsub = unsub;
    }
  }).catch((err: unknown) => console.error("[TraySync] listen failed:", err));
}

/* ─ Remove all sync-activity rows ────────────────────────────── */
async function removeAllSyncActivityRows(menu: Menu) {
  try {
    for (const [, item] of [...syncRowItems.entries()]) {
      try {
        await menu.remove(item);
      } catch { }
    }
    syncRowItems.clear();

    const items = await menu.items();
    for (const item of items) {
      if (typeof item.id === "string" && item.id.startsWith(SYNC_ITEM_PREFIX)) {
        try {
          await menu.remove(item);
        } catch { }
      }
    }
  } catch (error) {
    console.error("Failed to purge sync-activity rows:", error);
  }
}
