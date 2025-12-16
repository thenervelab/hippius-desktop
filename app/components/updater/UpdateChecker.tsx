/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import React, { useEffect, useRef, useState, ReactNode } from "react";
import { checkForUpdates } from "@/app/components/updater/checkForUpdates";
import { useSetAtom, useAtomValue } from "jotai";
import { refreshUnreadCountAtom } from "@/components/page-sections/notifications/notificationStore";
import {
  updateDialogOpenAtom,
  updateStore,
  updateCheckCompleteAtom,
} from "@/app/components/updater/updateStore";
import PageLoader from "@/app/components/PageLoader";
import UpdateDialogWrapper from "./UpdateDialogWrapper";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

interface UpdateCheckerProps {
  children?: ReactNode;
}

export default function UpdateChecker({ children }: UpdateCheckerProps) {
  const [checkComplete, setCheckComplete] = useState(false);
  const [showApp, setShowApp] = useState(false);
  const didRun = useRef(false);
  const refreshUnread = useSetAtom(refreshUnreadCountAtom);
  const updateDialogOpen = useAtomValue(updateDialogOpenAtom, {
    store: updateStore,
  });
  const setUpdateCheckComplete = useSetAtom(updateCheckCompleteAtom);
  const { polkadotAddress, oauthSession } = useWalletAuth();

  useEffect(() => {
    if (didRun.current) return;

    const runUpdateCheck = async () => {
      try {
        const userAddress = oauthSession?.substrateAddress || polkadotAddress;

        // Check for updates (app update check doesn't require user address)
        await checkForUpdates(true, userAddress || "");

        // Refresh notification count if user is authenticated
        if (userAddress) {
          refreshUnread();
        }

        console.log("Update check completed");
      } catch (error) {
        console.log("Update check failed:", error);
      } finally {
        // Always mark check as complete, even if it failed
        setCheckComplete(true);
        setUpdateCheckComplete(true);

        // If no dialog opened (no update), show app immediately
        if (!updateStore.get(updateDialogOpenAtom)) {
          console.log("No update found, showing app");
          setShowApp(true);
        }
      }
    };

    // Guard against multiple runs
    if (!(window as any).__didCheckUpdates) {
      (window as any).__didCheckUpdates = true;
      runUpdateCheck();
    } else {
      // If already checked, show app immediately
      setCheckComplete(true);
      setUpdateCheckComplete(true);
      setShowApp(true);
    }

    didRun.current = true;
  }, [refreshUnread, setUpdateCheckComplete, polkadotAddress, oauthSession]);

  // Monitor dialog state to show app when dialog closes
  useEffect(() => {
    if (checkComplete && !updateDialogOpen) {
      console.log("Update dialog closed or no update, showing app");
      setShowApp(true);
    }
  }, [checkComplete, updateDialogOpen]);

  // Show loading screen during initial check
  if (!checkComplete) {
    // Don't show UpdateChecker loading - let splash screen handle it
    return <>{children}</>;
  }

  // Show app (splash screen) with update dialog on top if available
  if (showApp || updateDialogOpen) {
    return (
      <>
        {children}
        {updateDialogOpen && <UpdateDialogWrapper />}
      </>
    );
  }

  // Fallback loading state
  return (
    <div className="flex items-center justify-center min-h-screen bg-grey-100">
      <div className="text-center">
        <PageLoader />
        <p className="mt-4 text-grey-50 text-sm">Loading...</p>
      </div>
    </div>
  );
}
