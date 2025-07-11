/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect } from "react";
import useAddCreditEvent from "@/app/lib/hooks/api/useAddCreditEvent";
import {
  addNotification,
  creditAlreadyNotified,
  isFirstTime,
  listNotifications,
  updateIsAboveHalfCredit,
  isAboveHalfCredit as getIsAboveHalfCredit,
  markFirstTimeSeen,
  lowCreditSubtypeExists,
} from "@/app/lib/helpers/notificationsDb";
import { formatCreditBalance } from "@/app/lib/utils/formatters/formatCredits";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
import { useSetAtom } from "jotai";
import { refreshUnreadCountAtom } from "@/components/page-sections/notifications/notificationStore";
const TEST_OFFSET = 0;

export function useCreditsNotification() {
  const { data: creditEvents, isSuccess } = useAddCreditEvent({ limit: 50 });
  const { data: credits, isLoading: isCreditsLoading } = useUserCredits();
  const refreshUnread = useSetAtom(refreshUnreadCountAtom);
  // Handle low credit notifications based on balance
  useEffect(() => {
    if (isCreditsLoading || credits === undefined) return;

    const handleCreditBalanceCheck = async () => {
      try {
        const creditValue =
          typeof credits === "bigint" ? credits : BigInt(credits || 0);
        const rawNumber = parseFloat(formatCreditBalance(creditValue));

        const creditNumber = rawNumber + TEST_OFFSET;

        const firstTime = await isFirstTime();
        const aboveHalfCredit = await getIsAboveHalfCredit();
        const timestamp = new Date().toISOString();
        const warningSubtype = `LowCreditWarning-${timestamp}`;

        // ── Case 1 ─────────────────────────────────────────────
        if (creditNumber < 0.5 && firstTime) return;

        // ── Case 2 ─────────────────────────────────────────────
        if (creditNumber >= 0.5) {
          await markFirstTimeSeen();
          await updateIsAboveHalfCredit(true);
          return;
        }

        // ── Case 3 ─────────────────────────────────────────────
        if (creditNumber < 0.5 && !firstTime && aboveHalfCredit) {
          if (!(await lowCreditSubtypeExists(warningSubtype))) {
            await addNotification({
              notificationType: "Credits",
              notificationSubtype: warningSubtype,
              notificationTitleText: "You're running low on credits.",
              notificationDescription: `Your credit balance is running low. You've only got ${creditNumber.toFixed(4)} credit left. Add more credits or buy a subscription plan to continue using all features without interruption.`,
              notificationLinkText: "Add Credits",
              notificationLink: "BILLING",
            });
          }
          await updateIsAboveHalfCredit(false);
          await refreshUnread();
        }
      } catch (err) {
        console.error("Credit balance check failed:", err);
      }
    };

    handleCreditBalanceCheck();
  }, [credits, isCreditsLoading, refreshUnread]);

  // Process credit events and add as notifications
  useEffect(() => {
    if (!isSuccess || !creditEvents?.length) return;

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
            notificationLink: "/",
          });
          await refreshUnread();
        }
      } catch (err) {
        console.error("Credit-event processing failed:", err);
      }
    };

    run();
  }, [creditEvents, isSuccess, refreshUnread]);
}
