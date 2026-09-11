"use client";

import React, { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useAtomValue, useSetAtom } from "jotai";
import { FolderPlus, FolderSync, Upload, UploadCloud } from "lucide-react";

import {
  newFolderTargetAtom,
  pageContextActionsAtom,
} from "@/app/lib/global-atoms/contextMenuAtoms";
import {
  UPLOAD_FILE_LABEL,
  UPLOAD_FOLDER_LABEL,
  SYNC_FOLDER_LABEL,
} from "@/app/components/page-sections/drive/uploadActions";

/** Where the menu was opened, in viewport coordinates. */
interface MenuPoint {
  x: number;
  y: number;
}

const MENU_WIDTH = 210;
/** Rough height per item, for keeping the menu on screen near an edge. */
const ITEM_HEIGHT = 36;

const ITEM_CLASS =
  "flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium !text-grey-30 hover:!text-grey-40 hover:bg-grey-90 cursor-pointer dark:!text-grey-dark-200 dark:hover:!text-grey-light-100 dark:hover:bg-white/5";

/**
 * The app's own right-click menu, mounted once in `app/(pages)/layout.tsx`.
 *
 * Replaces the WebView's Back / Reload / Inspect Element menu, which is a
 * developer menu that says nothing a user of this app wants. What it
 * offers is whatever the current surface registered through
 * `pageContextActionsAtom`, so the menu and that page's own toolbar always
 * run the same handlers against the same folder.
 *
 * **It yields to a menu that already handled the event.** File rows and
 * folder cards have their own menus and call `preventDefault`; checking
 * `defaultPrevented` rather than relying on `stopPropagation` means a row
 * menu wins whether or not it stops the event, and a row that forgets to
 * stop it does not get two menus.
 */
const AppContextMenu: React.FC = () => {
  const actions = useAtomValue(pageContextActionsAtom);
  const setNewFolderTarget = useSetAtom(newFolderTargetAtom);
  const [point, setPoint] = useState<MenuPoint | null>(null);

  const close = useCallback(() => setPoint(null), []);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      // A row or card menu took it. Ours would otherwise open on top.
      if (e.defaultPrevented) return;
      e.preventDefault();
      setPoint({ x: e.clientX, y: e.clientY });
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  useEffect(() => {
    if (!point) return;
    const onDown = () => close();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    // `mousedown` rather than `click`: a right-click elsewhere should move
    // the menu, and waiting for a full click leaves the old one up.
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [point, close]);

  if (!point) return null;

  const items: Array<{ label: string; icon: React.ReactNode; run: () => void }> = [];
  if (actions.onUploadFile) {
    items.push({
      label: UPLOAD_FILE_LABEL,
      icon: <Upload className="size-4" />,
      run: actions.onUploadFile,
    });
  }
  if (actions.onUploadFolder) {
    items.push({
      label: UPLOAD_FOLDER_LABEL,
      icon: <UploadCloud className="size-4" />,
      run: actions.onUploadFolder,
    });
  }
  // Always offered. With no folder open — Overview, the drive list — it
  // creates in the main drive's root, which is the only unambiguous
  // "here" those surfaces have.
  items.push({
    label: "New Folder",
    icon: <FolderPlus className="size-4" />,
    run: () => setNewFolderTarget(actions.newFolderTarget ?? { kind: "local" }),
  });
  if (actions.onSyncFolder) {
    items.push({
      label: SYNC_FOLDER_LABEL,
      icon: <FolderSync className="size-4" />,
      run: actions.onSyncFolder,
    });
  }

  const style: React.CSSProperties = {
    top: Math.min(point.y, window.innerHeight - items.length * ITEM_HEIGHT - 16),
    left: Math.min(point.x, window.innerWidth - MENU_WIDTH - 8),
  };

  return createPortal(
    <div
      role="menu"
      className="fixed z-[2000]"
      style={style}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="overflow-hidden rounded-lg border border-grey-80 bg-white p-0 shadow-[0px_12px_32px_8px_rgba(51,51,51,0.1)] dark:border-black-300 dark:bg-black-500 dark:shadow-[0px_12px_32px_8px_rgba(0,0,0,0.3)]"
        style={{ minWidth: MENU_WIDTH }}
      >
        <div className="flex flex-col">
          {items.map((item, index) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={
                index < items.length - 1
                  ? `${ITEM_CLASS} border-b border-grey-80 dark:border-black-300`
                  : ITEM_CLASS
              }
              onClick={() => {
                close();
                item.run();
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default AppContextMenu;
