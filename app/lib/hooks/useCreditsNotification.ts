import { useEffect, useState } from "react";
import useAddCreditEvent from "@/app/lib/hooks/api/useAddCreditEvent";
import { addNotification } from "@/app/lib/helpers/notificationsDb";
import { isExpectedNoSessionError } from "@/app/lib/utils/errorUtils";

import { invoke } from "@tauri-apps/api/core";
import { useSetAtom, useAtom } from "jotai";
import {
  refreshUnreadCountAtom,
  enabledNotificationTypesAtom,
} from "@/components/page-sections/notifications/notificationStore";
import { usePathname } from "next/navigation";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";



export function useCreditsNotification() {
  const { data: creditEvents, isSuccess } = useAddCreditEvent({ limit: 50 });
  const refreshUnread = useSetAtom(refreshUnreadCountAtom);
  const [enabledTypes] = useAtom(enabledNotificationTypesAtom);
  const pathname = usePathname(); // Track route changes
  const [routeChangeKey, setRouteChangeKey] = useState(0);
  const { oauthSession, polkadotAddress } = useWalletAuth();

  const areCreditsNotificationsEnabled = enabledTypes.includes("Credits");

  // Trigger refetch on route change
  useEffect(() => {
    setRouteChangeKey(prev => prev + 1);
  }, [pathname]);

  // Handle low credit notifications — Rust fetches the LIVE balance and owns
  // all decision logic. Audit R-08: the FE no longer feeds a stale cached
  // balance into the check (`useUserCredits` is `staleTime: Infinity` and never
  // invalidated), so a mid-session drop below the threshold is now caught on
  // the next route-change re-evaluation.
  useEffect(() => {
    if (!areCreditsNotificationsEnabled) return;

    const handleCreditBalanceCheck = async () => {
      try {
        const userAddress = oauthSession?.substrateAddress || polkadotAddress;
        if (!userAddress) return;

        // Single Rust call fetches the live balance and runs every state
        // check / decision — no FE-supplied (cacheable) balance.
        const result = await invoke<{
          shouldNotify: boolean;
          creditBalance: number;
        }>("check_low_credit_notification_live", {
          accountId: userAddress,
        });

        if (result.shouldNotify) {
          const bal = result.creditBalance.toFixed(4);
          const timestamp = new Date().toISOString();
          await addNotification({
            userAddress,
            notificationType: "Credits",
            notificationSubtype: `LowCreditWarning-${timestamp}`,
            notificationTitleText: "You're running low on credits.",
            notificationDescription: `Your credit balance is running low. You've only got ${bal} credit left. Add more credits or buy a subscription plan to continue using all features without interruption.`,
            notificationLinkText: "Add Credits",
            notificationLink: "/billing",
          });
        }
        // Always refresh: a top-up retires existing LowCreditWarning rows as
        // read (`shouldNotify` is false) and the bell badge must drop.
        await refreshUnread();
      } catch (err) {
        // Skip the expected no-session / account-transition rejection (the
        // account-scoped command can race a stale address during a switch).
        if (!isExpectedNoSessionError(err)) {
          console.error("Credit balance check failed:", err);
        }
      }
    };

    handleCreditBalanceCheck();
  }, [
    refreshUnread,
    areCreditsNotificationsEnabled,
    routeChangeKey,
    oauthSession,
    polkadotAddress,
  ]);

  // Process credit events — Rust handles filtering, dedup, and formatting
  useEffect(() => {
    if (!areCreditsNotificationsEnabled || !isSuccess || !creditEvents?.length)
      return;

    const run = async () => {
      try {
        const userAddress = oauthSession?.substrateAddress || polkadotAddress;
        if (!userAddress) return;

        // Rust filters by welcome timestamp, deduplicates, returns raw amounts
        const events = await invoke<Array<{
          subtype: string;
          amount: number;
        }>>("process_credit_events", {
          accountId: userAddress,
          events: creditEvents.map((e) => ({ timestamp: e.timestamp, amount: e.amount })),
        });

        if (events.length > 0) {
          // Frontend formats the notification text
          const formatted = events.map((e) => {
            const amt = e.amount > 0 ? e.amount.toFixed(2) : "some";
            const plural = e.amount > 1 ? "s" : "";
            return {
              subtype: e.subtype,
              title: `Woo-hoo! ${amt} credit${plural} just landed.`,
              description: `${amt} credit${plural} added to your account and ready to use. Spend credits to upload files, keep folders in sync, or spin up confidential VMs. They're deducted automatically as you go, so there's nothing extra to manage. Track your balance and recent usage anytime under Billing, or hit Jump to 'Files' to start uploading right away.`,
            };
          });
          await invoke("create_credit_notifications", {
            accountId: userAddress,
            notifications: formatted,
          });
          await refreshUnread();
        }
      } catch (err) {
        if (!isExpectedNoSessionError(err)) {
          console.error("Credit-event processing failed:", err);
        }
      }
    };

    run();
  }, [creditEvents, isSuccess, refreshUnread, areCreditsNotificationsEnabled, oauthSession, polkadotAddress]);
}
