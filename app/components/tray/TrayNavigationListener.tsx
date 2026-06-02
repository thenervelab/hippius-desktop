"use client";

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  TRAY_OPEN_FILES_EVENT,
  TRAY_OPEN_VM_EVENT,
} from "@/app/lib/tray/trayWindowActions";
import { useFilesNavigation } from "@/app/lib/hooks/useFilesNavigation";
import useNavigationLoader from "@/app/lib/hooks/useNavigationLoader";

/** Backend event the tray popover (a separate webview) emits to send the main
 *  window to the Drive page (its empty-state "Upload a File" CTA). DOM
 *  CustomEvents are window-local, so cross-window nav goes through Tauri. */
const TRAY_OPEN_FILES_TAURI_EVENT = "hippius:tray-open-files";

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

    window.addEventListener(TRAY_OPEN_FILES_EVENT, handleOpenFiles);
    window.addEventListener(TRAY_OPEN_VM_EVENT, handleOpenVm);

    const unlisten = listen(TRAY_OPEN_FILES_TAURI_EVENT, () => goTo("/files"));

    return () => {
      window.removeEventListener(TRAY_OPEN_FILES_EVENT, handleOpenFiles);
      window.removeEventListener(TRAY_OPEN_VM_EVENT, handleOpenVm);
      void unlisten.then((fn) => fn());
    };
  }, [navigateToFilesView, push]);

  return null;
}
