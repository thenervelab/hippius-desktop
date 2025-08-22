"use client";
import { TrayIcon } from "@tauri-apps/api/tray";
import {
  Menu,
  MenuItem,
  IconMenuItem as TauriIconMenuItem,
} from "@tauri-apps/api/menu";
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { resolveResource } from "@tauri-apps/api/path";
import {
  checkForUpdates,
  getAvailableUpdate,
} from "@/components/updater/checkForUpdates";

/* ─ IDs ───────────────────────────────────────────────────────── */
const TRAY_ID = "hippius-tray";
const QUIT_ID = "quit";
const SYNC_ID = "sync";
const INSTALL_UPDATE = "install-update";
const SYNC_ITEM_PREFIX = "sync-activity-item:";

/* ─ State kept across React reloads ───────────────────────────── */
let menuPromise: Promise<Menu> | null = null;
let syncItem: MenuItem | null = null;
const syncRowItems = new Map<string, MenuItem>(); // rows under header

// Cache last rendered "rows signature" to avoid flicker
let lastRowsSignature = "";

// Runtime check for icon rows
const hasIconMenuItems =
  typeof (TauriIconMenuItem as unknown as { new?: unknown })?.new === "function";

/* ─ Backend payload types ─────────────────────────────────────── */
type BackendActivityItem = {
  name: string;
  path: string;
  scope: string; // "public" | "private" | etc.
  action: "uploaded" | "deleted" | "uploading";
  kind: "file" | "folder" | string;
};

type BackendActivityResponse = {
  recent?: BackendActivityItem[];
  uploading?: BackendActivityItem[];
};

// Internal normalized row
type SyncActivityRow = {
  id: string;
  fileName: string;            // possibly shortened for display
  rawName: string;             // full name
  scope: string;               // public/private
  status: "uploading" | "uploaded";
  progress?: number;
  iconPath?: string;           // final icon/thumbnail to show if supported
  rawPath?: string;            // original file path (for click actions later)
};

/* ─ Public: create tray once ──────────────────────────────────── */
export function useTrayInit() {
  useEffect(() => {
    if (menuPromise) return;

    menuPromise = (async () => {
      const iconPath = await resolveResource("icons/trayIcon.png");
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

      // Quit item - create this early but add it last
      const quit = await MenuItem.new({
        id: QUIT_ID,
        text: "Quit Hippius",
        action: async () => {
          await invoke("app_close");
        },
      });

      // Build the initial menu
      const menu = await Menu.new({
        items: [
          ...(installUpdateMenuItem ? [installUpdateMenuItem] : []),
          // We'll add the quit item at the end after sync items
        ],
      });

      if (!existingTray) {
        await TrayIcon.new({
          id: TRAY_ID,
          icon: iconPath,
          iconAsTemplate: false,
          tooltip: "Hippius Cloud",
          menu,
          menuOnLeftClick: true,
        });
      }

      // Start watcher for sync activity after menu exists
      startSyncActivityWatcher();

      // Add quit item at the end
      await menu.append(quit);

      return menu;
    })();
  }, []);
}

/* ─ Public: keep your existing percent label behavior ─────────── */
export async function setTraySyncPercent(percent: number | null) {
  const menu = await (menuPromise ?? Promise.resolve<Menu | null>(null));
  if (!menu) return;

  const items = await menu.items();
  if (!syncItem) {
    syncItem =
      (items.find((i) => i.id === SYNC_ID) as MenuItem | null) || null;
  }

  if (percent === null) {
    if (syncItem) {
      await menu.remove(syncItem);
      syncItem = null;
    }
    return;
  }

  const label =
    percent >= 100 ? "Sync: Completed" : `Sync: ${Math.round(percent)} %`;
  const update = await getAvailableUpdate();

  // Insert once near the top; keep your original logic
  if (!syncItem && (items.length < 2 || (update && items.length < 3))) {
    syncItem = await MenuItem.new({
      id: SYNC_ID,
      text: label,
      enabled: false,
    });
    await menu.insert(syncItem, 0);
  } else {
    await syncItem!.setText(label);
  }
}

/* ─ Sync Activity watcher (debounced & diffed) ────────────────── */
function startSyncActivityWatcher() {
  const INTERVAL_MS = 1500;

  const tick = async () => {
    try {
      const menu = await (menuPromise ?? Promise.resolve<Menu | null>(null));
      if (!menu) return;

      const resp = (await invoke(
        "get_sync_activity"
      )) as BackendActivityResponse | null;

      const rows = await normalizeActivityToRows(resp ?? {});

      // Build a compact signature to detect "no change"
      const signature = JSON.stringify(
        rows.map((r) => ({
          id: r.id,
          text: formatRowText(r),
          icon: r.iconPath || "",
        }))
      );

      if (signature === lastRowsSignature) {
        return;
      }
      lastRowsSignature = signature;

      await updateSyncRowsDirectly(menu, rows);
    } catch (error) {
      console.error("Error updating sync activity in tray:", error);
    }
  };

  void tick();
  const h = setInterval(tick, INTERVAL_MS);

  // Avoid duplicate intervals on HMR
  if (typeof window !== "undefined") {
    // @ts-expect-error: window.__hippiusSyncWatcher is a custom property for sync watcher
    if (window.__hippiusSyncWatcher) clearInterval(window.__hippiusSyncWatcher);
    // @ts-expect-error: window.__hippiusSyncWatcher is a custom property for sync watcher
    window.__hippiusSyncWatcher = h;
  }
}

/* ─ Normalize backend shape to rows ───────────────────────────── */
async function normalizeActivityToRows(
  resp: BackendActivityResponse
): Promise<SyncActivityRow[]> {
  // Get icons for different file types
  const videoIcon = await safeResolve("icons/generic-video.png");
  const fileIcon = await safeResolve("icons/generic-file.png");
  const folderIcon = await safeResolve("icons/generic-folder.png");

  const rows: SyncActivityRow[] = [];

  const addItem = async (it: BackendActivityItem) => {
    // Simplify status to just "uploading" or "uploaded"
    const status = it.action === "uploading" ? "uploading" : "uploaded";

    const rawName = it.name || "Unknown";
    const fileName = shortenName(rawName);

    // Always try to get a thumbnail regardless of file type
    let iconPath: string | undefined;

    try {
      // Try to get thumbnail from backend
      iconPath = (await invoke("get_thumbnail_for_path", {
        path: it.path,
        size: 32, // Smaller size for menu items
      })) as string;

      console.log(`Got thumbnail for ${fileName}: ${iconPath ? "✓" : "✗"}`);
    } catch (error) {
      console.log(`Failed to get thumbnail for ${fileName}, using fallbacks`);
      console.log(error);
    }

    // Fallback icons if no thumbnail
    if (!iconPath) {
      if (it.kind === "folder") {
        iconPath = folderIcon || fileIcon;
      } else if (isImagePath(it.path)) {
        iconPath = it.path; // many platforms allow raw file path as icon
      } else if (isVideoPath(it.path)) {
        iconPath = videoIcon || fileIcon;
      } else {
        iconPath = fileIcon;
      }
    }

    rows.push({
      id: hashId(it),
      rawName,
      fileName,
      scope: it.scope || "",
      status,
      iconPath: iconPath,
      rawPath: it.path,
    });
  };

  // Process uploading files first, then recent files
  for (const it of resp.uploading ?? []) await addItem(it);
  for (const it of resp.recent ?? []) await addItem(it);

  // Limit to reasonable number to keep menu clean
  return rows.slice(0, 5);
}

/* ─ Add rows directly after sync percentage ─────────────────── */
async function updateSyncRowsDirectly(menu: Menu, rows: SyncActivityRow[]) {
  try {
    const items = await menu.items();

    // Find position for files - right after sync percentage if it exists,
    // or at the beginning if it doesn't
    let insertPosition = items.findIndex((i) => i.id === SYNC_ID);
    if (insertPosition >= 0) {
      insertPosition += 1; // Insert after sync percentage
    } else {
      insertPosition = 0; // Insert at the beginning
    }

    // First remove existing sync row items
    for (const [id, item] of [...syncRowItems.entries()]) {
      try {
        await menu.remove(item);
        syncRowItems.delete(id);
      } catch (error) {
        console.error(`Failed to remove menu item ${id}:`, error);
      }
    }

    // If no rows to show, we're done
    if (rows.length === 0) {
      return;
    }

    // Now add new items - we add all at once to avoid UI flicker
    // Insert in reverse order to maintain correct final order
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      const id = SYNC_ITEM_PREFIX + row.id;
      const text = formatRowText(row);

      try {
        const item = await newSyncRowMenuItem(id, text, row.iconPath);
        await menu.insert(item, insertPosition);
        syncRowItems.set(id, item);
      } catch (error) {
        console.error(`Failed to create menu item for ${row.fileName}:`, error);
      }
    }

    console.log(`Updated tray menu: ${syncRowItems.size} file items added`);
  } catch (error) {
    console.error("Error managing tray menu items:", error);
  }
}

/* ─ Create a row with icon if available ─────────────────────── */
async function newSyncRowMenuItem(id: string, text: string, iconPath?: string) {
  if (hasIconMenuItems && iconPath) {
    try {
      return await TauriIconMenuItem.new({
        id,
        text,
        icon: iconPath,
        enabled: false,
      });
    } catch (error) {
      console.error("Failed to create icon menu item:", error);
      // fall through to text row
    }
  }

  return await MenuItem.new({
    id,
    text,
    enabled: false,
  });
}

/* ─ Row label formatting - improved for status display ────────── */
function formatRowText(r: SyncActivityRow) {
  // Format name on first line
  const firstLine = r.fileName;

  // Format status and scope on second line  
  const statusText = r.status === "uploading" ? "Uploading..." : "Uploaded";
  const scopeText = r.scope ? ` (${r.scope})` : "";

  // Second line has status and scope
  const secondLine = `${statusText}${scopeText}`;

  // Return formatted text with multiline support
  return `${firstLine}\n${secondLine}`;
}

/* ─ Helpers ───────────────────────────────────────────────────── */
function isImagePath(p?: string) {
  if (!p) return false;
  const ext = p.split(".").pop()?.toLowerCase();
  return !!ext && ["png", "jpg", "jpeg", "webp", "gif", "bmp", "ico", "tiff", "svg"].includes(ext);
}

function isVideoPath(p?: string) {
  if (!p) return false;
  const ext = p.split(".").pop()?.toLowerCase();
  return !!ext && ["mp4", "mov", "m4v", "avi", "mkv", "webm", "flv"].includes(ext);
}

function hashId(it: BackendActivityItem) {
  // Stable key from action + path (path should be unique per file)
  return `${it.action}:${it.path || it.name}`;
}

// first 15 … last 12 (incl. extension) when > 30 chars
function shortenName(name: string) {
  if (!name) return name;
  if (name.length <= 30) return name;

  const head = name.slice(0, 15);
  const tail = name.slice(-12);
  return `${head}…${tail}`;
}

async function safeResolve(path: string) {
  try {
    return await resolveResource(path);
  } catch {
    return undefined;
  }
}
