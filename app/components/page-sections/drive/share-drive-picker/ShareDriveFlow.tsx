"use client";

// Where the "Share a drive" picker's buttons go. Continue opens the same
// Share dialog as "Share drive..." in the drive's menu (`shareDialogAtom`),
// after closing the picker, so only one dialog is ever open. New drive makes
// a drive on Hippius right here (`useNewDriveStep`, no local folder) and then
// goes the same way as Continue, with the new drive. Upgrade plan is
// Settings > Billing, like every other Drive upgrade prompt. Mounted only
// while the picker is open.

import React, { useCallback } from "react";
import { useSetAtom } from "jotai";
import { useRouter } from "next/navigation";

import { shareDialogAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { triggerSyncPathRefreshAtom } from "@/app/lib/global-atoms/unpinAtoms";
import type { DriveSharing } from "@/app/lib/hooks/useOwnedDriveSharing";
import { useSharedDrivesInPlan } from "@/app/lib/hooks/useSharedDrivesInPlan";
import { BILLING_ROUTE } from "@/app/lib/routes";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { sharingGate } from "../share-dialog/shareDialogState";
import ShareDrivePicker from "./ShareDrivePicker";
import { useNewDriveStep } from "./useNewDriveStep";

export default function ShareDriveFlow({
  drives,
  sharingByLabel,
  loading,
  onClose,
}: {
  drives: readonly string[];
  sharingByLabel: ReadonlyMap<string, DriveSharing>;
  loading: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const { polkadotAddress } = useWalletAuth();
  const openShareDialog = useSetAtom(shareDialogAtom);
  // Every drive list (this page's, the Drive page's, Settings') reloads on
  // it, so the new drive shows up everywhere as not synced here.
  const refreshDriveLists = useSetAtom(triggerSyncPathRefreshAtom);
  const planAllows = useSharedDrivesInPlan();

  const shareDrive = useCallback(
    (label: string) => {
      onClose();
      openShareDialog({ label, folderName: label });
    },
    [onClose, openShareDialog],
  );

  const newDrive = useNewDriveStep({
    accountId: polkadotAddress,
    onCreated: (label) => {
      refreshDriveLists((n) => n + 1);
      shareDrive(label);
    },
  });

  return (
    <ShareDrivePicker
      drives={drives}
      sharingByLabel={sharingByLabel}
      loading={loading}
      // This account's own plan decides, as in the Share dialog for an own
      // drive; the server's 403 there stays the authority.
      gate={sharingGate({ planAllows, owner: true, refusedByServer: false })}
      onClose={onClose}
      onContinue={shareDrive}
      onUpgrade={() => {
        onClose();
        router.push(BILLING_ROUTE);
      }}
      newDrive={newDrive}
    />
  );
}
