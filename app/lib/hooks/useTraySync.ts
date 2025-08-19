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

// New section ids
const SYNC_SECTION_HEADER_ID = "sync-activity-header";
const SYNC_ITEM_PREFIX = "sync-activity-item:";

/* ─ State kept across React reloads ───────────────────────────── */
let menuPromise: Promise<Menu> | null = null;
let syncItem: MenuItem | null = null;

let syncHeaderItem: MenuItem | null = null; // "Sync Activity" header
const syncRowItems = new Map<string, MenuItem>(); // rows under header

// Cache last rendered “rows signature” to avoid flicker
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
  status: "uploading" | "uploaded" | "deleted" | "queued" | "failed" | "synced";
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

      // Quit
      const quit = await MenuItem.new({
        id: QUIT_ID,
        text: "Quit Hippius",
        action: async () => {
          await invoke("app_close");
        },
      });

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

      // Build the base menu
      const menu = await Menu.new({
        items: [
          // The dynamic percent label may insert above these later
          ...(installUpdateMenuItem ? [installUpdateMenuItem] : []),
          quit,
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

      // Build a compact signature to detect “no change”
      const signature = JSON.stringify(
        rows.map((r) => ({
          id: r.id,
          text: formatRowText(r),
          icon: r.iconPath || "",
        }))
      );

      if (signature === lastRowsSignature) {
        // No changes => no DOM churn => no flicker.
        return;
      }
      lastRowsSignature = signature;

      await updateSyncActivitySection(menu, rows);
    } catch {
      // silent: avoid noisy logs from tray updates
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
  const videoIcon = await safeResolve("icons/generic-video.png");
  const fileIcon = await safeResolve("icons/generic-file.png");

  const rows: SyncActivityRow[] = [];

  const addItem = async (it: BackendActivityItem) => {
    const status =
      it.action === "uploading"
        ? "uploading"
        : it.action === "deleted"
          ? "deleted"
          : "synced";

    const rawName = it.name || "Unknown";
    const fileName = shortenName(rawName);

    // Resolve best icon:
    // 1) Ask backend for a thumbnail (works for images/videos if you implement it)
    // 2) If image, use the file itself as icon (often supported)
    // 3) If video, use generic video icon
    // 4) Fallback to generic file icon
    let iconPath: string | undefined;

    try {
      // Optional but recommended backend helper:
      // return a small PNG path (e.g., 64x64) for any file (image or video)
      iconPath =
        (await invoke("get_thumbnail_for_path", {
          path: it.path,
          size: 64,
        })) as string;
    } catch {
      // Helper not available; continue with heuristics
    }

    if (!iconPath) {
      if (isImagePath(it.path)) {
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
      iconPath: iconPath || undefined,
      rawPath: it.path,
    });
  };

  for (const it of resp.uploading ?? []) await addItem(it);
  for (const it of resp.recent ?? []) await addItem(it);

  // Order: uploading first, then recent. Limit to keep the tray tidy.
  return rows.slice(0, 5);
}

/* ─ Maintain "Sync Activity" section (minimal churn) ──────────── */
async function updateSyncActivitySection(menu: Menu, rows: SyncActivityRow[]) {
  if (rows.length === 0) {
    await removeSyncActivitySection(menu);
    return;
  }

  // Ensure header exists, inserted right below the percent label if present
  if (!syncHeaderItem) {
    syncHeaderItem = await MenuItem.new({
      id: SYNC_SECTION_HEADER_ID,
      text: "— Sync Activity —",
      enabled: false,
    });

    const items = await menu.items();
    const syncIdx = items.findIndex((i) => i.id === SYNC_ID);
    const insertAt = syncIdx >= 0 ? syncIdx + 1 : 0;
    await menu.insert(syncHeaderItem, insertAt);
  }

  // Compute desired order of row IDs
  const desiredIds = rows.map((r) => SYNC_ITEM_PREFIX + r.id);
  const desiredMap = new Map(desiredIds.map((id, idx) => [id, idx]));

  // 1) Remove stale items
  for (const [id, item] of [...syncRowItems.entries()]) {
    if (!desiredMap.has(id)) {
      await menu.remove(item);
      syncRowItems.delete(id);
    }
  }

  // 2) Ensure rows exist in desired order, updating text/icon only when changed
  //    Insert right after the header.
  let insertIndex =
    (await menu.items()).findIndex((i) => i.id === SYNC_SECTION_HEADER_ID) + 1;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const id = SYNC_ITEM_PREFIX + r.id;
    const newText = formatRowText(r);

    const existing = syncRowItems.get(id);

    if (!existing) {
      // Create new (try icon row; fallback to text)
      const item = await newSyncRowMenuItem(id, newText, r.iconPath);
      await menu.insert(item, insertIndex++);
      syncRowItems.set(id, item);
    } else {
      // Update in place if text changed
      const currentText = await existing.text();
      if (currentText !== newText) {
        await existing.setText(newText);
      }
      // Ensure correct order with minimal moves:
      // We'll accept minor out-of-order to reduce flicker.
      insertIndex++;
    }
  }
}

/* ─ Remove header + rows ──────────────────────────────────────── */
async function removeSyncActivitySection(menu: Menu) {
  for (const [, item] of syncRowItems) {
    await menu.remove(item);
  }
  syncRowItems.clear();

  if (syncHeaderItem) {
    await menu.remove(syncHeaderItem);
    syncHeaderItem = null;
  }

  lastRowsSignature = "";
}

/* ─ Create a row (icon if available) ──────────────────────────── */
async function newSyncRowMenuItem(id: string, text: string, iconPath?: string) {
  if (hasIconMenuItems && iconPath) {
    try {
      return await TauriIconMenuItem.new({
        id,
        text,
        icon: iconPath, // backend thumbnail or file path
        enabled: false,
      });
    } catch {
      // fall through to text row
    }
  }

  return await MenuItem.new({
    id,
    text,
    enabled: false,
  });
}

/* ─ Row label formatting ──────────────────────────────────────── */
// Try multi-line. Some platforms collapse to one line; that’s okay.
function formatRowText(r: SyncActivityRow) {
  const primary =
    r.status === "uploading"
      ? `⬆️ ${r.fileName}`
      : r.status === "uploaded"
        ? `✅ ${r.fileName}`
        : r.status === "deleted"
          ? `🗑️ ${r.fileName}`
          : r.status === "failed"
            ? `❌ ${r.fileName}`
            : `⏳ ${r.fileName}`;

  // Second line for scope (public/private) if available
  const scope = r.scope ? `\n(${r.scope})` : "";
  return primary + scope;
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
