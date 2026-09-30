"use client";

// Where the "Share a drive" picker's buttons go. Continue opens the same
// Share dialog as "Share drive..." in the drive's menu (`shareDialogAtom`),
// after closing the picker, so only one dialog is ever open. Upgrade plan is
// Settings > Billing, like every other Drive upgrade prompt. Mounted only
// while the picker is open.

import React from "react";
import { useSetAtom } from "jotai";
import { useRouter } from "next/navigation";

import { shareDialogAtom } from "@/app/lib/global-atoms/sharesAtoms";
import type { DriveSharing } from "@/app/lib/hooks/useOwnedDriveSharing";
import { useSharedDrivesInPlan } from "@/app/lib/hooks/useSharedDrivesInPlan";
import { BILLING_ROUTE } from "@/app/lib/routes";
import { sharingGate } from "../share-dialog/shareDialogState";
import ShareDrivePicker from "./ShareDrivePicker";

export default function ShareDriveFlow({
  drives,
  sharingByLabel,
  loading,
  onClose,
  onAddDrive,
}: {
  drives: readonly string[];
  sharingByLabel: ReadonlyMap<string, DriveSharing>;
  loading: boolean;
  onClose: () => void;
  /** Start making a drive. Called after the picker has closed. */
  onAddDrive: () => void;
}) {
  const router = useRouter();
  const openShareDialog = useSetAtom(shareDialogAtom);
  const planAllows = useSharedDrivesInPlan();

  return (
    <ShareDrivePicker
      drives={drives}
      sharingByLabel={sharingByLabel}
      loading={loading}
      // This account's own plan decides, as in the Share dialog for an own
      // drive; the server's 403 there stays the authority.
      gate={sharingGate({ planAllows, owner: true, refusedByServer: false })}
      onClose={onClose}
      onContinue={(label) => {
        onClose();
        openShareDialog({ label, folderName: label });
      }}
      onUpgrade={() => {
        onClose();
        router.push(BILLING_ROUTE);
      }}
      onAddDrive={() => {
        onClose();
        onAddDrive();
      }}
    />
  );
}
