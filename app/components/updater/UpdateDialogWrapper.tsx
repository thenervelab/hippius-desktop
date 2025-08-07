"use client";

import { useAtomValue } from "jotai";
import {
  updateDialogOpenAtom,
  updateStore,
} from "@/app/components/updater/updateStore";
import DesktopAppDownloadDialog from "./UpdateDownloadDialog";
import { useWindowSizer } from "@/app/lib/hooks/useWindowSizer";

export default function UpdateDialogWrapper() {
  useWindowSizer();
  const open = useAtomValue(updateDialogOpenAtom, { store: updateStore });

  // Only render the dialog when it's needed
  if (!open) return null;

  return <DesktopAppDownloadDialog />;
}
