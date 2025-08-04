"use client";

import { useAtomValue } from "jotai";
import { updateDialogOpenAtom, updateStore } from "@/lib/stores/updateStore";
import DesktopAppDownloadDialog from "./sidebar/UpdateDownloadDialog";

export default function UpdateDialogWrapper() {
  const open = useAtomValue(updateDialogOpenAtom, { store: updateStore });
  
  // Only render the dialog when it's needed
  if (!open) return null;
  
  return <DesktopAppDownloadDialog />;
}
