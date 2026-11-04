"use client";

import React from "react";

import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import BillingSections from "./BillingSections";
import PageHeader from "@/components/page-sections/home/PageHeader";
import InfoTooltip from "@/components/ui/info-tooltip";

export const BILLING_DOCS_URL = "https://docs.hippius.com/use/desktop/billing";

/** The page's name, in the top bar and the heading, as in the sidebar. */
export const BILLING_PAGE_TITLE = "Plans & Billing";

// The balance is "account balance", in dollars, as on the console and the
// balance card below: never "credits", which asked the reader to learn an
// exchange rate.
export const BILLING_PAGE_SUBTITLE =
  "Your plan, your account balance, and everything you have been charged for.";

/**
 * Plans & Billing (`/billing`): a page of its own under the main sidebar,
 * as in the console, rather than a section inside Settings. Every money
 * prompt in the app lands here through `BILLING_ROUTE`.
 */
export default function Billing() {
  return (
    <DashboardTitleWrapper mainText={BILLING_PAGE_TITLE}>
      <div className="flex flex-col px-4 pb-6">
        <PageHeader
          title={BILLING_PAGE_TITLE}
          subtitle={BILLING_PAGE_SUBTITLE}
          // No plan card: the balance and next charge cards directly below
          // already state the plan, the balance and the way to change it,
          // as on Overview. No top-up button either: this is where you act.
          showPlanCard={false}
          showTopUpCredits={false}
          infoButton={
            // The subtitle says what the page IS; the tooltip says how to
            // use it. Both routes are laid out because the choice is not
            // obvious from the page: the plan cards show a price, and
            // nothing on them explains that the account balance is an
            // alternative to a card. The balance route does not name the
            // checkout's tile, so the guide stays true whatever that tile
            // is called. The default 260px is sized for one sentence; three
            // short blocks need the extra room or every line wraps twice.
            <InfoTooltip
              ariaLabel="Plans and billing information"
              learnMoreUrl={BILLING_DOCS_URL}
              contentClassName="max-w-[320px]"
            >
              <span className="mb-1 block font-semibold text-grey-10 dark:text-white">
                Two ways to pay for a storage plan
              </span>
              <span className="mb-1 block">
                <span className="font-semibold">By card:</span> pick a plan,
                choose Card, and Stripe opens in your browser. Your card then
                funds each renewal.
              </span>
              <span className="block">
                <span className="font-semibold">From your account balance:</span>{" "}
                top up your balance first, then pick a plan and pay from it.
                Renewals come out of your balance in dollars, so keep it
                topped up.
              </span>
            </InfoTooltip>
          }
        />

        <BillingSections />
      </div>
    </DashboardTitleWrapper>
  );
}
