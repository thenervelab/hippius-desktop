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

/** Backend event the tray popover (a separate webview) emits to send the main
 *  window to the Drive page (its empty-state "Upload a File" CTA). DOM
 *  CustomEvents are window-local, so cross-window nav goes through Tauri. */
const TRAY_OPEN_FILES_TAURI_EVENT = "hippius:tray-open-files";
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
    const unlistenChat = listen(TRAY_OPEN_CHAT_TAURI_EVENT, () =>
      goTo("/chat"),
    );

    return () => {
      window.removeEventListener(TRAY_OPEN_FILES_EVENT, handleOpenFiles);
      window.removeEventListener(TRAY_OPEN_VM_EVENT, handleOpenVm);
      window.removeEventListener(OPEN_DRIVE_FOLDER_EVENT, handleOpenFolder);
      void unlisten.then((fn) => fn());
      void unlistenChat.then((fn) => fn());
    };
  }, [navigateToFilesView, push]);

  return null;
}
