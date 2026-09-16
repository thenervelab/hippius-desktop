"use client";

import { useAtomValue } from "jotai";
import {
  updateDialogOpenAtom,
  updateStore,
} from "@/app/components/updater/updateStore";
import UpdateDialog from "./UpdateDialog";
import { useBackgroundUpdateChecks } from "./useBackgroundUpdateChecks";

export default function UpdateDialogWrapper() {
  const open = useAtomValue(updateDialogOpenAtom, { store: updateStore });
  // Mounted once at the provider level and never unmounted, which is what the
  // listener needs: it has to outlive the dialog it opens, and the dialog
  // below is torn down whenever it closes.
  useBackgroundUpdateChecks();

  // Only render the dialog when it's needed
  if (!open) return null;

  return <UpdateDialog />;
}
