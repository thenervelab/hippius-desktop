"use client";
import { TrayIcon } from "@tauri-apps/api/tray";
import {
  Menu,
  MenuItem,
  PredefinedMenuItem,
} from "@tauri-apps/api/menu";
import { useEffect } from "react";
import { logger } from "@/lib/utils/logger";
import { invoke } from "@tauri-apps/api/core";
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
import { useAtom, useSetAtom } from "jotai";
import { vpnConnectedAtom } from "@/components/dashboard-title-wrapper/vpn-menu/vpnAtoms";
import type { SyncSnapshot } from "../types/syncSnapshot";
import { formatBytes } from "@/app/lib/utils/formatBytes";

/* ─ IDs ───────────────────────────────────────────────────────── */
const TRAY_ID = "hippius-tray";
const QUIT_ID = "quit";
const SYNC_ID = "sync";
const INSTALL_UPDATE = "install-update";
const VPN_TOGGLE_ID = "vpn-toggle";
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
let vpnToggleItem: MenuItem | null = null;
let openItemsSeparator: PredefinedMenuItem | null = null;
let syncSectionSeparator: PredefinedMenuItem | null = null;
let openFilesItem: MenuItem | null = null;
let openVmItem: MenuItem | null = null;
const syncRowItems = new Map<string, MenuItem>(); // legacy rows (cleaned up on init)
let syncProgressItem: MenuItem | null = null; // "X of Y files synced" row
let syncSizeItem: MenuItem | null = null; // "208 MB / 1 GB" row
let syncDeleteItem: MenuItem | null = null; // "X files deleted" row

/* ─ Latching state — keeps completed info visible after backend resets snapshot */
let latchedComplete = false;
let latchedSnapshot: SyncSnapshot | null = null;

/* ─ Backend payload types ─────────────────────────────────────── */

interface VpnStatus {
  is_enabled: boolean;
}

interface OAuthSession {
  token: string;
  userId: string;
  username: string;
  substrateAddress: string;
  provider: string;
  expiresAt: string;
}

interface CreditsApiResponse {
  balance: string; // String representation of the credit balance
}

const MINIMUM_CREDITS = 10;
const OAUTH_SESSION_KEY = "hippius_oauth_session";
const CREDITS_CACHE_DURATION = 30000; // Cache credits for 30 seconds

// Cache for credits to avoid repeated API calls
let creditsCache: {
  credits: number;
  timestamp: number;
  isLoading: boolean;
  error?: string;
} | null = null;

// Cache for async login check
let loginStatusCache: { loggedIn: boolean; timestamp: number } | null = null;
const LOGIN_STATUS_CACHE_DURATION = 5000; // 5 seconds

/**
 * Immediately invalidate the login status cache so the next
 * `isUserLoggedIn()` / `refreshLoginStatus()` call re-checks.
 * Call this on logout so the VPN watcher picks up the change instantly.
 */
export function clearLoginStatusCache() {
  loginStatusCache = null;
}

// Helper to check if user is logged in (synchronous, uses cache)
function isUserLoggedIn(): boolean {
  if (typeof window === "undefined") return false;

  // Use cache if fresh
  if (loginStatusCache && Date.now() - loginStatusCache.timestamp < LOGIN_STATUS_CACHE_DURATION) {
    return loginStatusCache.loggedIn;
  }

  try {
    // Check localStorage for OAuth session
    const storedSession = localStorage.getItem(OAUTH_SESSION_KEY);
    const storedExpiry = localStorage.getItem("hippius_oauth_session_expiry");

    if (storedSession && storedExpiry) {
      const expiryTime = new Date(storedExpiry).getTime();
      if (Date.now() < expiryTime) {
        const session: OAuthSession = JSON.parse(storedSession);
        if (session.token) {
          loginStatusCache = { loggedIn: true, timestamp: Date.now() };
          return true;
        }
      } else {
        logger.debug("[Tray] Session expired");
      }
    }

    // Fall back to cached result while async check runs
    if (loginStatusCache) return loginStatusCache.loggedIn;
    return false;
  } catch (error) {
    console.error("[Tray] Failed to check login status:", error);
    return false;
  }
}

// Async login check that also queries Rust backend (for mnemonic logins
// that don't store an OAuth session in localStorage).
async function refreshLoginStatus(): Promise<boolean> {
  // First check localStorage (fast path)
  if (isUserLoggedIn()) return true;

  // Fall back to Rust backend session check
  try {
    const session = await invoke<{ authToken?: string | null; tokenExpiry?: number | null } | null>("get_last_auth_session");
    if (session?.authToken) {
      const isValid = !session.tokenExpiry || session.tokenExpiry > Date.now();
      loginStatusCache = { loggedIn: isValid, timestamp: Date.now() };
      return isValid;
    }
  } catch {
    // DB not ready yet — ignore
  }

  loginStatusCache = { loggedIn: false, timestamp: Date.now() };
  return false;
}

// Helper to fetch credits via Rust backend with caching
async function fetchUserCredits(forceRefresh = false): Promise<{
  credits: number;
  isLoading: boolean;
  error?: string;
}> {
  // Return cached result if available and not expired
  if (!forceRefresh && creditsCache) {
    const now = Date.now();
    if (now - creditsCache.timestamp < CREDITS_CACHE_DURATION) {
      return {
        credits: creditsCache.credits,
        isLoading: creditsCache.isLoading,
        error: creditsCache.error,
      };
    }
  }

  try {
    // Get substrate address from localStorage session
    const storedSession = localStorage.getItem(OAUTH_SESSION_KEY);
    if (!storedSession) {
      const result = { credits: 0, isLoading: true, error: "Loading credits" };
      creditsCache = { ...result, timestamp: Date.now() };
      return result;
    }
    const session: OAuthSession = JSON.parse(storedSession);
    if (!session.substrateAddress) {
      const result = { credits: 0, isLoading: true, error: "Loading credits" };
      creditsCache = { ...result, timestamp: Date.now() };
      return result;
    }

    const data = await invoke<CreditsApiResponse>("get_user_credits_balance", {
      accountId: session.substrateAddress,
    });
    const balanceStr = data.balance || "0";
    const credits = parseFloat(balanceStr);

    const result = { credits, isLoading: false };
    creditsCache = { ...result, timestamp: Date.now() };
    return result;
  } catch (error) {
    console.error("[Tray] Failed to fetch credits:", error);
    const result = { credits: 0, isLoading: true, error: "Loading credits" };
    creditsCache = { ...result, timestamp: Date.now() };
    return result;
  }
}

// Helper to check if user has sufficient credits
async function checkUserCredits(): Promise<{
  hasEnough: boolean;
  isLoading: boolean;
  error?: string;
  notLoggedIn?: boolean;
}> {
  // First check if user is logged in
  if (!isUserLoggedIn()) {
    return {
      hasEnough: false,
      isLoading: false,
      notLoggedIn: true,
      error: "Login required",
    };
  }

  const result = await fetchUserCredits();

  if (result.isLoading) {
    return {
      hasEnough: false,
      isLoading: true,
      error: result.error || "Loading credits",
    };
  }

  const hasEnough = result.credits >= MINIMUM_CREDITS;

  return {
    hasEnough,
    isLoading: false,
    error: hasEnough ? undefined : "Insufficient credits",
  };
}

/* ─ Public: create tray once ──────────────────────────────────── */

export function useTrayInit(isAuthenticated: boolean) {
  // Use atom to watch for sync percentage changes
  const [lastUpdatedPercent, setLastUpdatedPercent] = useAtom(
    lastUpdatedPercentAtom,
  );
  const setVpnConnected = useSetAtom(vpnConnectedAtom);

  // Effect to update tray when sync state changes — derived entirely from snapshot.
  // Icon and label management is handled exclusively by the startSyncActivityWatcher
  // (which has latching logic to prevent flickering on backend snapshot resets).
  // This effect only handles logout cleanup.
  useEffect(() => {
    // When logged out, force default icon and clear sync label
    if (!isAuthenticated) {
      void setTrayIconSyncing(false, false);
      void updateTraySyncLabel(null);
      if (lastUpdatedPercent !== null) {
        setLastUpdatedPercent(null);
      }
      return;
    }
  }, [isAuthenticated, lastUpdatedPercent, setLastUpdatedPercent]);

  useEffect(() => {
    if (menuPromise) return;

    menuPromise = (async (setVpnState: (enabled: boolean) => void) => {
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

      // VPN toggle item
      const isVpnEnabled = await getVpnStatus();
      const creditCheck = await checkUserCredits();
      const shouldDisable =
        !isVpnEnabled && (!creditCheck.hasEnough || creditCheck.isLoading);

      let text = isVpnEnabled ? "VPN: Turn Off" : "VPN: Turn On";
      if (shouldDisable && creditCheck.error) {
        text = `VPN: ${creditCheck.error}`;
      }

      vpnToggleItem = await MenuItem.new({
        id: VPN_TOGGLE_ID,
        text,
        enabled: !shouldDisable,
        action: async () => {
          try {
            const newStatus = await toggleVpnStatus();
            setVpnState(newStatus); // Update Jotai atom
            // Immediately update with known status for fast response
            await updateVpnMenuItem(newStatus);
          } catch (error) {
            console.error("[Tray] VPN toggle failed:", error);
            await updateVpnMenuItem();
          }
        },
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
          vpnToggleItem,
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
      startLoginStatusWatcher(setVpnState);

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
    })(setVpnConnected);
  }, [setVpnConnected]);
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

/* ─ VPN Helper Functions ──────────────────────────────────────── */
async function getVpnStatus(): Promise<boolean> {
  try {
    const status = await invoke<VpnStatus>("get_vpn_status");
    return status.is_enabled;
  } catch (error) {
    console.error("[Tray] Failed to get VPN status:", error);
    return false;
  }
}

async function toggleVpnStatus(): Promise<boolean> {
  try {
    const status = await invoke<VpnStatus>("toggle_vpn_status");
    logTrayAction("VPN toggled", { is_enabled: status.is_enabled });
    return status.is_enabled;
  } catch (error) {
    console.error("[Tray] Failed to toggle VPN:", error);
    throw error;
  }
}

async function updateVpnMenuItem(knownStatus?: boolean) {
  try {
    const menu = await (menuPromise ?? Promise.resolve<Menu | null>(null));
    if (!menu) return;

    // Use provided status or fetch from backend
    const isEnabled =
      knownStatus !== undefined ? knownStatus : await getVpnStatus();

    let label: string;
    let shouldEnable = true;

    if (isEnabled) {
      label = "VPN: Turn Off";
      shouldEnable = true;
    } else {
      // Check credits when VPN is off (use cached value for fast updates)
      const creditCheck = await checkUserCredits();
      if (!creditCheck.hasEnough || creditCheck.isLoading) {
        label = creditCheck.error
          ? `VPN: ${creditCheck.error}`
          : "VPN: Turn On";
        shouldEnable = false;
      } else {
        label = "VPN: Turn On";
        shouldEnable = true;
      }
    }

    logTrayAction("Updating VPN menu item", {
      isEnabled,
      label,
      shouldEnable,
    });

    // Remove old item if exists
    if (vpnToggleItem) {
      try {
        await menu.remove(vpnToggleItem);
        logTrayAction("Removed old VPN menu item");
      } catch (error) {
        logTrayAction("Failed to remove old VPN item", error);
      }
    }

    // Recreate the menu item with new text and enabled state
    const newVpnItem = await MenuItem.new({
      id: VPN_TOGGLE_ID,
      text: label,
      enabled: shouldEnable,
      action: async () => {
        try {
          const newStatus = await toggleVpnStatus();
          if (vpnStateSetter) {
            vpnStateSetter(newStatus);
          }
          // Immediately update with known status for fast response
          await updateVpnMenuItem(newStatus);
        } catch (error) {
          console.error("[Tray] VPN toggle failed:", error);
          await updateVpnMenuItem();
        }
      },
    });

    // Insert after Open and Update items (if present)
    const items = await menu.items();
    const updateItemIndex = items.findIndex((i) => i.id === INSTALL_UPDATE);
    const openAppIndex = items.findIndex((i) => i.id === OPEN_APP_ID);
    const openFilesIndex = items.findIndex((i) => i.id === OPEN_FILES_ID);
    const openVmIndex = items.findIndex((i) => i.id === OPEN_VM_ID);
    const syncIndex = items.findIndex((i) => i.id === SYNC_ID);
    const anchorIndex = Math.max(
      updateItemIndex,
      openAppIndex,
      openFilesIndex,
      openVmIndex,
      syncIndex,
    );
    const insertPosition = anchorIndex >= 0 ? anchorIndex + 1 : 0;

    await menu.insert(newVpnItem, insertPosition);
    vpnToggleItem = newVpnItem;

    logTrayAction("VPN menu item recreated successfully", {
      label,
      position: insertPosition,
      enabled: shouldEnable,
    });
  } catch (error) {
    console.error("[Tray] Failed to update VPN menu item:", error);
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

/* ─ Public: keep your existing percent label behavior ─────────── */
async function updateTraySyncPercent(percent: number | null) {
  // Use the same mutex as updateTraySyncLabel
  if (isUpdatingTrayLabel) {
    logger.debug("[TraySync] Skipping percent update - already in progress");
    return;
  }
  isUpdatingTrayLabel = true;
  
  try {
    const menu = await (menuPromise ?? Promise.resolve<Menu | null>(null));
    if (!menu) {
      isUpdatingTrayLabel = false;
      return;
    }

    const items = await menu.items();

    // ALWAYS search for existing sync items in the menu
    const existingItems = items.filter((i) => i.id === SYNC_ID);
    if (existingItems.length > 1) {
      for (let i = 1; i < existingItems.length; i++) {
        await menu.remove(existingItems[i]);
      }
    }
    syncItem = existingItems[0] as MenuItem | null;

    // If percent is null, we want to remove the sync item
    if (percent === null) {
      if (syncItem) {
        await menu.remove(syncItem);
        syncItem = null;
      }
      await setTrayIconSyncing(false, false);
      return;
    }

    const isCompleted = percent >= 100;
    
    let label: string;
    if (isCompleted) {
      label = "✓ Sync: Completed";
    } else {
      label = `⟳ Sync: ${Math.round(percent)}%`;
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

    // Updated to pass both syncing and completed status
    await setTrayIconSyncing(percent < 100, percent >= 100);
  } finally {
    isUpdatingTrayLabel = false;
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


// Deprecated: Keep for backwards compatibility but don't use internally
export async function setTraySyncPercent(percent: number | null) {
  // logTrayAction("setTraySyncPercent is deprecated, use syncPercentAtom instead", { percent });
  // Just forward to the internal implementation for now
  await updateTraySyncPercent(percent);
}

/* ─ Login status watcher (updates tray menu on login/logout) ──── */
let vpnStateSetter: ((enabled: boolean) => void) | null = null;
let lastLoginStatus: boolean | null = null;

function startLoginStatusWatcher(setVpnState?: (enabled: boolean) => void) {
  if (setVpnState) {
    vpnStateSetter = setVpnState;
  }

  const INTERVAL_MS = 2000;

  const tick = async () => {
    const currentLoginStatus = await refreshLoginStatus();

    if (lastLoginStatus !== currentLoginStatus) {
      const wasLoggedIn = lastLoginStatus;
      lastLoginStatus = currentLoginStatus;
      await updateVpnMenuItem();
      await updateOpenFilesMenuItem();
      await updateOpenVmMenuItem();

      if (!currentLoginStatus && wasLoggedIn) {
        if (vpnStateSetter) {
          vpnStateSetter(false);
        }
        void setTrayIconSyncing(false, false);
        void updateTraySyncLabel(null);
      }
    }
  };

  void tick();
  const h = setInterval(tick, INTERVAL_MS);
  if (typeof window !== "undefined") {
    // @ts-expect-error custom watcher handle
    if (window.__hippiusVpnWatcher) clearInterval(window.__hippiusVpnWatcher);
    // @ts-expect-error custom watcher handle
    window.__hippiusVpnWatcher = h;
  }
}

/* ─ Sync Activity watcher (polls localStorage for summary rows) ─ */
let lastSyncSummarySignature = "";

function startSyncActivityWatcher() {
  const INTERVAL_MS = 2000;

  // Clear any old watcher from HMR
  if (typeof window !== "undefined") {
    // @ts-expect-error custom watcher handle
    if (window.__hippiusSyncWatcher) clearInterval(window.__hippiusSyncWatcher);
  }

  const tick = async () => {
    try {
      const menu = await (menuPromise ?? Promise.resolve<Menu | null>(null));
      if (!menu) return;

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

      // Read progress snapshot directly from Rust backend
      const progress = await invoke<SyncSnapshot>("sp_get_snapshot");
      const inProgressCount = progress.files.filter(
        (f) => f.status === "inProgress" || f.status === "pending"
      ).length;
      const isActive = progress.isActive ||
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
      // Unlatch when a new MEANINGFUL session starts (different startedAt AND
      // has actual files). The totalFiles > 0 guard prevents sync-loop probes
      // (which briefly create an empty active session) from wiping the latch.
      // Fast operations that complete before the watcher catches them active
      // are handled by the latch-update condition above (updates latchedSnapshot
      // directly when a new completed session is detected).
      if (isActive && progress.totalFiles > 0 && latchedComplete && progress.startedAt !== latchedSnapshot?.startedAt) {
        latchedComplete = false;
        latchedSnapshot = null;
      }

      // Use latched state if backend has reset the snapshot
      const effectiveCompleted = isCompleted || (latchedComplete && !isActive);
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
        // No sync activity and no recent deletes — remove summary rows and reset icon
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
      if (isActive && !latchedComplete && progress.totalFiles > 0) {
        const percent = progress.overallPercent;
        if (percent === 0 && progress.completedFiles === 0 && progress.progressBytes === 0) {
          await updateTraySyncLabel(`⟳ Preparing sync…`);
        } else {
          await updateTraySyncLabel(`⟳ Syncing: ${percent}%`);
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
          if (progress.bytesExpected > 0) {
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
      // aren't already reflected in the progress row. When all completed
      // files are deletes (or a mix), the progressText already says
      // "3 files deleted" or "2 synced · 1 deleted", so a separate row
      // would be duplicate.
      const deletesAlreadyInProgress = effectiveCompleted && !hasFailed;
      if (effectiveDeleteCount > 0 && !deletesAlreadyInProgress) {
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
      console.error("[TraySync] Error updating sync summary:", error);
    }
  };

  void tick();
  const h = setInterval(tick, INTERVAL_MS);
  if (typeof window !== "undefined") {
    // @ts-expect-error custom watcher handle
    window.__hippiusSyncWatcher = h;
  }
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
