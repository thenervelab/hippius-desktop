"use client";
import { TrayIcon } from "@tauri-apps/api/tray";
import {
  Menu,
  MenuItem,
  IconMenuItem as TauriIconMenuItem,
} from "@tauri-apps/api/menu";
import { useEffect } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { resolveResource } from "@tauri-apps/api/path";
import { writeFile } from '@tauri-apps/plugin-fs';
import { tempDir, join } from "@tauri-apps/api/path";
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
  scope: string;
  action: "uploaded" | "deleted" | "uploading";
  kind: "file" | "folder" | string;
  timestamp?: number; // when action happened (ms)
  file_type?: string;
};

type BackendActivityResponse = {
  recent?: BackendActivityItem[];
  uploading?: BackendActivityItem[];
};

type SyncActivityRow = {
  id: string;
  fileName: string;
  rawName: string;
  scope: string;
  status: "uploading" | "uploaded" | "deleted";
  fileType: string;
  timestamp?: number;
  progress?: number;
  path?: string;     // thumbnail/icon path for menu item
  rawPath?: string;  // actual file path
};

// Cache for resolved generic icons
const iconPathCache: Record<string, string | undefined | null> = {};

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

  // Find any existing sync items by ID
  if (!syncItem) {
    // Look for an existing sync item in the menu
    syncItem = items.find((i) => i.id === SYNC_ID) as MenuItem | null;
  }

  // If percent is null, we want to remove the sync item
  if (percent === null) {
    if (syncItem) {
      await menu.remove(syncItem);
      syncItem = null;
    }
    return;
  }

  const label = percent >= 100 ? "Sync: Completed" : `Sync: ${Math.round(percent)} %`;
  const update = await getAvailableUpdate();

  // If sync item doesn't exist yet, create it and add it to the menu
  if (!syncItem) {
    syncItem = await MenuItem.new({
      id: SYNC_ID,
      text: label,
      enabled: false,
    });

    // Insert at the top of the menu (but after the update item if it exists)
    const insertPosition = update ? 1 : 0;
    await menu.insert(syncItem, insertPosition);
  } else {
    // Update existing sync item text
    await syncItem.setText(label);
  }
}

/* ─ Sync Activity watcher (debounced & diffed) ────────────────── */
function startSyncActivityWatcher() {
  const INTERVAL_MS = 3000;

  const tick = async () => {
    try {
      const menu = await (menuPromise ?? Promise.resolve<Menu | null>(null));
      if (!menu) return;

      const resp = (await invoke("get_sync_activity")) as BackendActivityResponse | null;

      // Only show what's returned now; if empty, clear all previous rows
      if (!resp || (!resp.recent?.length && !resp.uploading?.length)) {
        await updateSyncRowsDirectly(menu, []);
        lastRowsSignature = "";
        return;
      }

      const rows = await normalizeActivityToRows(resp);

      const signature = JSON.stringify(
        rows.map((r) => ({
          id: r.id,
          text: formatRowText(r),
          icon: r.path || "",
        }))
      );

      if (signature === lastRowsSignature) return;
      lastRowsSignature = signature;

      await updateSyncRowsDirectly(menu, rows);
    } catch (error) {
      console.error("Error updating sync activity in tray:", error);
    }
  };

  void tick();
  const h = setInterval(tick, INTERVAL_MS);
  if (typeof window !== "undefined") {
    // @ts-expect-error custom watcher handle
    if (window.__hippiusSyncWatcher) clearInterval(window.__hippiusSyncWatcher);
    // @ts-expect-error custom watcher handle
    window.__hippiusSyncWatcher = h;
  }
}

/* ─ Normalize backend shape to rows (with thumbnails) ────────── */
async function normalizeActivityToRows(
  resp: BackendActivityResponse
): Promise<SyncActivityRow[]> {
  // Resolve generic icons once
  if (!iconPathCache.file) {
    try { iconPathCache.file = await resolveResource("icons/generic-file.png"); } catch { iconPathCache.file = null; }
  }
  if (!iconPathCache.folder) {
    try { iconPathCache.folder = await resolveResource("icons/generic-folder.png"); } catch { iconPathCache.folder = null; }
  }
  if (!iconPathCache.video) {
    try { iconPathCache.video = await resolveResource("icons/generic-video.png"); } catch { iconPathCache.video = null; }
  }

  const rows: SyncActivityRow[] = [];
  const seen = new Set<string>(); // ensure one row per id per tick

  const addItem = async (it: BackendActivityItem) => {
    const status: "uploading" | "uploaded" | "deleted" =
      it.action === "uploading" ? "uploading" : it.action === "deleted" ? "deleted" : "uploaded";

    const id = hashId(it);
    if (seen.has(id)) return;
    seen.add(id);

    const rawName = it.name || "Unknown";
    const fileName = shortenName(rawName);
    const fileType = getFileType(it.file_type || it.path || it.name, it.kind);

    // Build thumbnail/icon path:
    // - Deleted: always generic file icon
    // - Folder: generic folder icon
    // - Image: use convertFileSrc(localPath)
    // - Video: extract a frame, write to temp, use that file path
    // - Other: generic file icon
    let iconPath: string | undefined;

    try {
      if (status === "deleted") {
        iconPath = iconPathCache.file ?? undefined;
      } else if (it.kind === "folder") {
        iconPath = iconPathCache.folder ?? iconPathCache.file ?? undefined;
      } else if (isImagePath(it.path)) {
        iconPath = it.path ? convertFileSrc(it.path) : iconPathCache.file ?? undefined;
      } else if (isVideoPath(it.path)) {
        iconPath = (await ensureVideoThumbnail(it.path, id)) ?? iconPathCache.video ?? iconPathCache.file ?? undefined;
      } else {
        iconPath = iconPathCache.file ?? undefined;
      }
    } catch (e) {
      console.warn("Failed to prepare thumbnail for", it.name, e);
      iconPath = iconPathCache.file ?? undefined;
    }

    rows.push({
      id,
      rawName,
      fileName,
      scope: it.scope || "",
      status,
      fileType,
      timestamp: it.timestamp,
      path: iconPath,
      rawPath: it.path,
    });
  };

  for (const it of resp.uploading ?? []) await addItem(it);
  for (const it of resp.recent ?? []) await addItem(it);

  // Keep the list compact
  return rows.slice(0, 5);
}

/* ─ Ensure video thumbnail exists for a local file path ──────── */
async function ensureVideoThumbnail(localPath?: string, id?: string): Promise<string | undefined> {
  try {
    if (!localPath || !id) return undefined;

    // Build a temp file path for the thumbnail
    const tmpDir = await tempDir();
    const thumbPath = await join(tmpDir, `hippius-thumb-${safeId(id)}.png`);

    // Try to render a frame in-memory and write it as PNG
    const data = await captureVideoFrameAsPng(localPath);
    if (!data) return undefined;

    await writeFile(thumbPath, data);
    return thumbPath;
  } catch (e) {
    console.warn("ensureVideoThumbnail failed:", e);
    return undefined;
  }
}

function safeId(id: string) {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/* ─ Capture a video frame into PNG bytes ─────────────────────── */
async function captureVideoFrameAsPng(localPath: string): Promise<Uint8Array | null> {
  try {
    // Use convertFileSrc so the video element can read local files
    const url = convertFileSrc(localPath);

    // Create video element
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.src = url;
    video.preload = "metadata";
    // Needed to be able to seek to time
    await new Promise<void>((resolve, reject) => {
      const tid = setTimeout(() => reject(new Error("video metadata timeout")), 10000);
      video.onloadedmetadata = () => {
        clearTimeout(tid);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(tid);
        reject(new Error("video load error"));
      };
    });

    // Seek around 0.25 progress or 0.5s if short
    const seekTime = Math.min(1, Math.max(0.5, video.duration * 0.25));
    video.currentTime = seekTime;

    await new Promise<void>((resolve, reject) => {
      const tid = setTimeout(() => reject(new Error("video seek timeout")), 10000);
      video.onseeked = () => {
        clearTimeout(tid);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(tid);
        reject(new Error("video seek error"));
      };
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(160, video.videoWidth || 320);
    canvas.height = Math.max(90, video.videoHeight || 180);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Convert to PNG bytes
    const dataUrl = canvas.toDataURL("image/png");
    return dataURLtoUint8Array(dataUrl);
  } catch (e) {
    console.warn("captureVideoFrameAsPng failed:", e);
    return null;
  }
}

function dataURLtoUint8Array(dataUrl: string): Uint8Array {
  const [meta, base64] = dataUrl.split(",");
  const binStr = atob(base64);
  const len = binStr.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binStr.charCodeAt(i);
  return bytes;
}

/* ─ Add rows (deduped) after sync percentage ─────────────────── */
async function updateSyncRowsDirectly(menu: Menu, rows: SyncActivityRow[]) {
  try {
    const items = await menu.items();

    let insertPosition = items.findIndex((i) => i.id === SYNC_ID);
    insertPosition = insertPosition >= 0 ? insertPosition + 1 : 0;

    // Hard-purge old rows to avoid duplicates
    await removeAllSyncActivityRows(menu);

    if (rows.length === 0) return;

    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      const id = SYNC_ITEM_PREFIX + row.id;
      const text = formatRowText(row);
      try {
        const item = await newSyncRowMenuItem(id, text, row.path);
        await menu.insert(item, insertPosition);
        syncRowItems.set(id, item);
      } catch (error) {
        console.error(`Failed to create menu item for ${row.fileName}:`, error);
      }
    }
  } catch (error) {
    console.error("Error managing tray menu items:", error);
  }
}

/* ─ Remove all sync-activity rows ────────────────────────────── */
async function removeAllSyncActivityRows(menu: Menu) {
  try {
    for (const [, item] of [...syncRowItems.entries()]) {
      try { await menu.remove(item); } catch { }
    }
    syncRowItems.clear();

    const items = await menu.items();
    for (const item of items) {
      if (typeof item.id === "string" && item.id.startsWith(SYNC_ITEM_PREFIX)) {
        try { await menu.remove(item); } catch { }
      }
    }
  } catch (error) {
    console.error("Failed to purge sync-activity rows:", error);
  }
}

/* ─ Create menu item with icon (thumbnail) if supported ─────── */
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
      console.warn("Icon menu item failed; falling back to text row:", error);
    }
  }
  return await MenuItem.new({ id, text, enabled: false });
}

/* ─ Row label: 3 lines (name / scope+status / time) ──────────── */
function formatRowText(r: SyncActivityRow) {
  const first = r.fileName;

  let statusText = "Synced";
  if (r.status === "uploading") statusText = "Uploading";
  else if (r.status === "uploaded") statusText = "Uploaded";
  else if (r.status === "deleted") statusText = "Deleted";

  const second = [r.scope || "", statusText].filter(Boolean).join(" • ");

  const third = r.timestamp ? formatTimeAgo(r.timestamp) : "";

  return [first, second, third].filter(Boolean).join("\n");
}

/* ─ Helpers ───────────────────────────────────────────────────── */
function isImagePath(p?: string) {
  if (!p) return false;
  const ext = p.split(".").pop()?.toLowerCase();
  return !!ext && ["png", "jpg", "jpeg", "webp", "gif", "bmp", "ico", "tiff", "svg", "heic", "heif"].includes(ext);
}
function isVideoPath(p?: string) {
  if (!p) return false;
  const ext = p.split(".").pop()?.toLowerCase();
  return !!ext && ["mp4", "mov", "m4v", "avi", "mkv", "webm", "flv"].includes(ext);
}
function hashId(it: BackendActivityItem) {
  return `${it.action}:${it.path || it.name}`;
}
function shortenName(name: string) {
  if (!name) return name;
  if (name.length <= 30) return name;
  const head = name.slice(0, 15);
  const tail = name.slice(-12);
  return `${head}…${tail}`;
}
function getFileType(path: string, kind?: string): string {
  if (kind === "folder") return "folder";
  const ext = path.split(".").pop()?.toLowerCase();
  return ext && ext !== path ? ext : kind || "file";
}
function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const seconds = Math.floor((now - timestamp) / 1000);

  if (seconds < 60) {
    return `${seconds} second${seconds !== 1 ? 's' : ''} ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days} day${days !== 1 ? 's' : ''} ago`;
}
