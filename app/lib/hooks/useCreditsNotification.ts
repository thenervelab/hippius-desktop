/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import useAddCreditEvent from "@/app/lib/hooks/api/useAddCreditEvent";
import {
  addNotification,
  creditAlreadyNotified,
  isFirstTime,
  listNotifications,
  updateIsAboveHalfCredit,
  isAboveHalfCredit as getIsAboveHalfCredit,
  markFirstTimeSeen,
  hasActiveLowCreditNotification,
  getLastDeletedLowCreditNotification,
} from "@/app/lib/helpers/notificationsDb";
import { formatCreditBalance } from "@/app/lib/utils/formatters/formatCredits";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
import { useSetAtom, useAtom } from "jotai";
import {
  refreshUnreadCountAtom,
  enabledNotificationTypesAtom,
} from "@/components/page-sections/notifications/notificationStore";
import { usePathname } from "next/navigation";

const TEST_OFFSET = 0;
const ONE_DAY_MS = 24 * 60 * 60 * 1000; // 1 day in milliseconds

export function useCreditsNotification() {
  const { data: creditEvents, isSuccess } = useAddCreditEvent({ limit: 50 });
  const { data: credits, isLoading: isCreditsLoading } = useUserCredits();
  const refreshUnread = useSetAtom(refreshUnreadCountAtom);
  const [enabledTypes] = useAtom(enabledNotificationTypesAtom);
  const pathname = usePathname(); // Track route changes
  const [routeChangeKey, setRouteChangeKey] = useState(0);

  const areCreditsNotificationsEnabled = enabledTypes.includes("Credits");

  // Trigger refetch on route change
  useEffect(() => {
    setRouteChangeKey(prev => prev + 1);
  }, [pathname]);

  // Handle low credit notifications based on balance
  useEffect(() => {
    if (
      !areCreditsNotificationsEnabled ||
      isCreditsLoading ||
      credits === undefined
    )
      return;

    const handleCreditBalanceCheck = async () => {
      try {
        const creditValue =
          typeof credits === "bigint" ? credits : BigInt(credits || 0);
        const rawNumber = parseFloat(formatCreditBalance(creditValue));
        const creditNumber = rawNumber + TEST_OFFSET;

        const firstTime = await isFirstTime();
        const aboveHalfCredit = await getIsAboveHalfCredit();

        // Mark as not first time and update state if credits >= 0.5
        if (creditNumber >= 0.5) {
          if (firstTime) {
            await markFirstTimeSeen();
          }
          if (!aboveHalfCredit) {
            await updateIsAboveHalfCredit(true);
          }
          return;
        }

        // Credits are below 0.5 - check if we should show notification
        if (creditNumber < 0.5) {
          // Mark as not first time if needed
          if (firstTime) {
            await markFirstTimeSeen();
          }

          // Check if there's already an active (non-deleted) low credit notification
          const hasActiveNotification = await hasActiveLowCreditNotification();

          if (!hasActiveNotification) {
            // No active notification - check if we can add a new one
            const lastDeleted = await getLastDeletedLowCreditNotification();
            const now = Date.now();

            // Add notification if:
            // 1. No notification was ever deleted, OR
            // 2. Last deletion was more than 1 day ago
            const canAddNotification =
              !lastDeleted ||
              (now - lastDeleted.deletedAt) > ONE_DAY_MS;

            if (canAddNotification) {
              const timestamp = new Date().toISOString();
              const warningSubtype = `LowCreditWarning-${timestamp}`;

              await addNotification({
                notificationType: "Credits",
                notificationSubtype: warningSubtype,
                notificationTitleText: "You're running low on credits.",
                notificationDescription: `Your credit balance is running low. You've only got ${creditNumber.toFixed(4)} credit left. Add more credits or buy a subscription plan to continue using all features without interruption.`,
                notificationLinkText: "Add Credits",
                notificationLink: "/billing"
              });

              await refreshUnread();
            }
          }

          // Update state to reflect we're below half credit
          if (aboveHalfCredit) {
            await updateIsAboveHalfCredit(false);
          }
        }
      } catch (err) {
        console.error("Credit balance check failed:", err);
      }
    };

    handleCreditBalanceCheck();
  }, [
    credits,
    isCreditsLoading,
    refreshUnread,
    areCreditsNotificationsEnabled,
    routeChangeKey, // Refetch when route changes
  ]);

  // Process credit events and add as notifications
  useEffect(() => {
    if (!areCreditsNotificationsEnabled || !isSuccess || !creditEvents?.length)
      return;

    const run = async () => {
      try {
        /* grab existing welcome-time stamp for filtering */
        const existing = await listNotifications(100);
        const welcome = existing.find(
          (n: any[]) => n[1] === "Hippius" && n[2] === "Welcome"
        );
        if (!welcome || !welcome[8]) return;
        const welcomeMs = +welcome[8];

        /* events that arrived after welcome */
        const fresh = creditEvents.filter(
          (e) => new Date(e.timestamp).getTime() > welcomeMs
        );

        for (const e of fresh) {
          const subtype = `MintedAccountCredits-${e.timestamp}`; // unique key

          if (await creditAlreadyNotified(e.timestamp)) continue;

          // Convert amount safely, handling potential invalid formats
          let amount;
          try {
            // Remove any non-numeric characters if present
            const cleanAmount = e.amount.replace(/[^\d]/g, "");
            amount = formatCreditBalance(BigInt(cleanAmount || "0"));
          } catch (err) {
            console.log("Failed to parse credit amount:", err);
            console.warn("Failed to parse credit amount:", e.amount);
            amount = "some";
          }

          await addNotification({
            notificationType: "Credits",
            notificationSubtype: subtype,
            notificationTitleText: `🎁 Woo-hoo! ${amount} credit${+amount > 1 ? "s" : ""
              } just landed.`,
            notificationDescription: `Fresh ${+amount > 1 ? "credits" : "credit"} are in your wallet. Use them right away to upload or  sync files with zero delay. Hit Jump to 'Files' and make something awesome.`,
            notificationLinkText: "Jump to Files",
            notificationLink: "/files",
          });
          await refreshUnread();
        }
      } catch (err) {
        console.error("Credit-event processing failed:", err);
      }
    };

    run();
  }, [creditEvents, isSuccess, refreshUnread, areCreditsNotificationsEnabled]);
}
