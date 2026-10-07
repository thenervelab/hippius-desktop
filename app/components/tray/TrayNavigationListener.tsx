"use client";

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  TRAY_OPEN_FILES_EVENT,
  TRAY_OPEN_VM_EVENT,
} from "@/app/lib/tray/trayWindowActions";
import { useFilesNavigation } from "@/app/lib/hooks/useFilesNavigation";
import useNavigationLoader from "@/app/lib/hooks/useNavigationLoader";
import {
  OPEN_DRIVE_FOLDER_EVENT,
  type OpenDriveFolderDetail,
} from "@/app/lib/drive/openDriveFolder";
import {
  parseTrayPagePayload,
  trayPageRoute,
  TRAY_OPEN_PAGE_EVENT,
} from "@/app/lib/tray/trayHeaderMenu";
import { openLinkByKey } from "@/app/lib/utils/links";
import {
  parkTrayDrop,
  parseTrayDropPayload,
  TRAY_OPEN_FILES_TAURI_EVENT,
  TRAY_UPLOAD_PATHS_EVENT,
} from "@/app/lib/tray/trayDrop";

// The tray popover (a separate webview) emits TRAY_OPEN_FILES_TAURI_EVENT to
// send the main window to the Drive page (its Upload tile and empty-state
// CTA). DOM CustomEvents are window-local, so cross-window nav goes through
// Tauri.
/** Same, for the popover's chat button (shown while chat has unread DMs/mentions). */
export const TRAY_OPEN_CHAT_TAURI_EVENT = "hippius:tray-open-chat";

export default function TrayNavigationListener() {
  const { navigateToFilesView } = useFilesNavigation();
  const { push } = useNavigationLoader();

  useEffect(() => {
    const goTo = (path: string) => {
      if (path === "/files") navigateToFilesView();
      push(path);
    };

    const handleOpenFiles = () => goTo("/files");
    const handleOpenVm = () => goTo("/vm");
    // "Show in folder" from the sync queue: a `/files?openLabel=…` URL.
    const handleOpenFolder = (e: Event) => {
      const url = (e as CustomEvent<OpenDriveFolderDetail>).detail?.url;
      if (url) push(url);
    };

    window.addEventListener(TRAY_OPEN_FILES_EVENT, handleOpenFiles);
    window.addEventListener(TRAY_OPEN_VM_EVENT, handleOpenVm);
    window.addEventListener(OPEN_DRIVE_FOLDER_EVENT, handleOpenFolder);

    const unlisten = listen(TRAY_OPEN_FILES_TAURI_EVENT, () => goTo("/files"));
    // Files dropped on the popover: the Drive page opens its upload dialog
    // with them (`DriveContent` takes them from `trayDrop`), so they go
    // through every gate a drop on the page itself does.
    const unlistenDrop = listen(TRAY_UPLOAD_PATHS_EVENT, (event) => {
      const paths = parseTrayDropPayload(event.payload);
      if (!paths) return;
      goTo("/files");
      parkTrayDrop(paths);
    });
    const unlistenChat = listen(TRAY_OPEN_CHAT_TAURI_EVENT, () =>
      goTo("/chat"),
    );
    // The popover's ⋮ menu: a page by name (never a route or URL from the
    // other webview), or Top up, which opens the console like every other
    // Top up in the app.
    const unlistenPage = listen(TRAY_OPEN_PAGE_EVENT, (event) => {
      const page = parseTrayPagePayload(event.payload);
      if (!page) return;
      if (page === "top-up") {
        void openLinkByKey("CREDITS");
        return;
      }
      const route = trayPageRoute(page);
      if (route) goTo(route);
    });

    return () => {
      window.removeEventListener(TRAY_OPEN_FILES_EVENT, handleOpenFiles);
      window.removeEventListener(TRAY_OPEN_VM_EVENT, handleOpenVm);
      window.removeEventListener(OPEN_DRIVE_FOLDER_EVENT, handleOpenFolder);
      void unlisten.then((fn) => fn());
      void unlistenDrop.then((fn) => fn());
      void unlistenChat.then((fn) => fn());
      void unlistenPage.then((fn) => fn());
    };
  }, [navigateToFilesView, push]);

  return null;
}
