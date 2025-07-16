import { TrayIcon } from "@tauri-apps/api/tray";
import { Menu, MenuItem } from "@tauri-apps/api/menu";
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

const TRAY_ID = "hippius-tray";
const QUIT_ID = "quit";
const SYNC_ID = "sync";

// singletons kept across React reloads
let menuPromise: Promise<Menu> | null = null;
let syncItem: MenuItem | null = null;

/* ─ Create tray once ───────────────────────────────────────────── */
export function useTrayInit() {
  useEffect(() => {
    if (menuPromise) return;

    menuPromise = (async () => {
      const quit = await MenuItem.new({
        id: QUIT_ID,
        text: "Quit Hippius",
        action: async () => {
          await invoke("app_close");
        }
      });

      const menu = await Menu.new({ items: [quit] });

      await TrayIcon.new({
        id: TRAY_ID,
        icon: "icons/icon.png",
        iconAsTemplate: false,
        tooltip: "Hippius Cloud",
        menu,
        menuOnLeftClick: true
      });

      return menu;
    })();
  }, []);
}

/* ─ Update label or remove it ─────────────────────────────────── */
/* ─ Update label or remove it ─────────────────────────────────── */
export async function setTraySyncPercent(percent: number | null) {
  const menu = await (menuPromise ?? Promise.resolve<Menu | null>(null));
  if (!menu) return;
  console.log(syncItem, "syncItem", percent);
  const items = await menu.items();
  // Find an existing item if our reference was lost (HMR, reload, etc.)
  if (!syncItem) {
    syncItem = (items.find((i) => i.id === SYNC_ID) as MenuItem | null) || null;
  }

  // ── Remove when told to hide ──────────────────────────────────
  if (percent === null) {
    if (syncItem) {
      await menu.remove(syncItem);
      syncItem = null;
    }
    return;
  }

  // ── Build label ───────────────────────────────────────────────
  const label =
    percent >= 100 ? "Sync: Completed" : `Sync: ${Math.round(percent)} %`;

  // ── Insert once, then only update text ────────────────────────
  if (!syncItem && items.length < 2) {
    syncItem = await MenuItem.new({
      id: SYNC_ID,
      text: label,
      enabled: false
    });
    await menu.insert(syncItem, 0); // one‑time insert
  } else {
    await syncItem!.setText(label); // plain update
  }
}
