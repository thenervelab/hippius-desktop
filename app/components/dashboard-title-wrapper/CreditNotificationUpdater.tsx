/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useEffect } from "react";
import { InView } from "react-intersection-observer";
import { RevealTextLine } from "@/app/components/ui";
import { Icons } from "@/app/components/ui";
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

interface CreditNotificationUpdaterProps {
  className?: string;
}
const TEST_OFFSET = 0;
const CreditNotificationUpdater: React.FC<CreditNotificationUpdaterProps> = ({
  className = "delay-500",
}) => {
  const { data: creditEvents, isSuccess } = useAddCreditEvent({ limit: 50 });
  const { data: credits, isLoading: isCreditsLoading } = useUserCredits();
  console.log("Credit balance check 1:", credits);

  // Handle low credit notifications based on balance
  useEffect(() => {
    if (isCreditsLoading || credits === undefined) return;

    const handleCreditBalanceCheck = async () => {
      try {
        /* 1️⃣  raw on-chain balance */
        const creditValue =
          typeof credits === "bigint" ? credits : BigInt(credits || 0);
        const rawNumber = parseFloat(formatCreditBalance(creditValue));

        /* 2️⃣  add offset only for UI/debug */
        const creditNumber = rawNumber + TEST_OFFSET;

        /* 👉  use rawNumber for business logic  */
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
              notificationTitleText: "You're running low on credits",
              notificationDescription:
                "Your credit balance is running low. Add more credits or buy a subscription plan to continue using all features without interruption.",
              notificationLinkText: "Add Credits",
              notificationLink: "BILLING",
            });
          }
          await updateIsAboveHalfCredit(false);
        }
      } catch (err) {
        console.error("Credit balance check failed:", err);
      }
    };

    handleCreditBalanceCheck();
  }, [credits, isCreditsLoading]);

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
            notificationTitleText: `🎁 Woo-hoo! ${amount} credit${
              +amount > 1 ? "s" : ""
            } just landed.`,
            notificationDescription: `Fresh ${+amount > 1 ? "credits" : "credit"} are in your wallet. Use them right away to upload or  sync files with zero delay. Hit Jump to 'Files' and make something awesome.`,
            notificationLinkText: "Jump to Files",
            notificationLink: "/files",
          });
        }
      } catch (err) {
        console.error("Credit-event processing failed:", err);
      }
    };

    run();
  }, [creditEvents, isSuccess]);

  // Otherwise use InView to manage the reveal state
  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div ref={ref}>
          <RevealTextLine reveal={inView} className={className}>
            <span className="text-grey-60 bg-grey-90 p-2.5 rounded">
              <Icons.Notification className="text-grey-70 size-4" />
            </span>
          </RevealTextLine>
        </div>
      )}
    </InView>
  );
};

export default CreditNotificationUpdater;
