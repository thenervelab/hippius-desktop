"use client";

import { useEffect } from "react";
import {
  TRAY_OPEN_FILES_EVENT,
  TRAY_OPEN_VM_EVENT,
} from "@/app/lib/tray/trayWindowActions";
import { useFilesNavigation } from "@/app/lib/hooks/useFilesNavigation";
import useNavigationLoader from "@/app/lib/hooks/useNavigationLoader";

export default function TrayNavigationListener() {
  const { navigateToFilesView } = useFilesNavigation();
  const { push } = useNavigationLoader();

  useEffect(() => {
    const handleOpenFiles = () => {
      navigateToFilesView();
      push("/files");
    };

    const handleOpenVm = () => {
      push("/vm");
    };

    window.addEventListener(TRAY_OPEN_FILES_EVENT, handleOpenFiles);
    window.addEventListener(TRAY_OPEN_VM_EVENT, handleOpenVm);
    return () => {
      window.removeEventListener(TRAY_OPEN_FILES_EVENT, handleOpenFiles);
      window.removeEventListener(TRAY_OPEN_VM_EVENT, handleOpenVm);
    };
  }, [navigateToFilesView, push]);

  return null;
}
