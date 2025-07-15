import { TrayIcon } from "@tauri-apps/api/tray";
import { Menu, MenuItem } from "@tauri-apps/api/menu";
import { exit } from "@tauri-apps/plugin-process";
import { useEffect } from "react";

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
        action: () => exit(0),
      });

      const menu = await Menu.new({ items: [quit] });

      await TrayIcon.new({
        id: TRAY_ID,
        icon: "icons/icon.png",
        tooltip: "Hippius Cloud",
        menu,
        menuOnLeftClick: true,
      });

      return menu;
    })();
  }, []);
}

/* ─ Update label or remove it ─────────────────────────────────── */
export async function setTraySyncPercent(percent: number | null) {
  const menu = await (menuPromise ?? Promise.resolve<Menu | null>(null));
  if (!menu) return;

  // remove label when null
  if (percent === null) {
    if (syncItem) {
      await menu.remove(syncItem);
      syncItem = null;
    }
    return;
  }

  // label text
  const label =
    percent >= 100 ? "Sync: Completed" : `Sync: ${Math.round(percent)} %`;

  // create once
  if (!syncItem) {
    syncItem = await MenuItem.new({
      id: SYNC_ID,
      text: label,
      enabled: false,
    });
    await menu.insert(syncItem, 0);
  } else {
    await syncItem.setText(label);
  }
}

/* ─ Optional hook wrapper ─────────────────────────────────────── */
export function useTraySync(percent: number | null) {
  useEffect(() => {
    void setTraySyncPercent(percent);
  }, [percent]);
}
