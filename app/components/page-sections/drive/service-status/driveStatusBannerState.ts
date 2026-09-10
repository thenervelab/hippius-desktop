import { BILLING_ROUTE } from "@/app/lib/routes";

/** Mirrors the console's `MANAGED_BY_LABEL`. */
const MANAGED_BY_LABEL: Record<string, string> = {
  stripe: "the Stripe billing portal",
  app_store: "the App Store",
  play_store: "Google Play",
};

export interface DriveServiceStatus {
  state?: string | null;
  plan?: string | null;
  planName?: string | null;
  managedBy?: string | null;
}

export interface DriveStatusBanner {
  tone: "info" | "warning";
  title: string;
  description: string;
  /** Absent when the plan is managed somewhere this app cannot reach. */
  action?: { label: string; href: string };
  /** Set when the banner may be put away; the key persists the dismissal. */
  dismissKey?: string;
}

/**
 * What Drive wants the user to know, from `/api/services/status/`.
 *
 * The states and the wording follow the console's own `driveBanners`, so
 * one account is not told two different stories by two clients. Only
 * states worth interrupting for are drawn: a product that is simply
 * working, or that the user does not have, says nothing — an "all good"
 * banner is noise, and it trains people to scroll past the one that
 * matters.
 */
export function getDriveStatusBanner(
  status: DriveServiceStatus | undefined,
): DriveStatusBanner | null {
  const state = status?.state;
  if (!state) return null;

  // A plan bought on another rail cannot be fixed from here, so the copy
  // sends the user where it can be, rather than to a button that would
  // fail on arrival.
  const elsewhere =
    status?.managedBy && status.managedBy !== "console"
      ? MANAGED_BY_LABEL[status.managedBy]
      : null;
  const planName = status?.planName ?? status?.plan ?? null;
  const plansAction = { label: "See storage plans", href: BILLING_ROUTE };

  if (state === "pending") {
    return {
      tone: "info",
      title: "Setting up your Drive plan",
      description: `Your payment went through and the plan is being provisioned on chain. This usually takes two to three minutes${
        planName ? `, and then ${planName} is live` : ""
      }.`,
    };
  }

  if (state === "past_due") {
    return {
      tone: "warning",
      title: "Your Drive plan could not be renewed",
      description: elsewhere
        ? `The last payment did not go through. Manage this subscription in ${elsewhere} to keep your storage.`
        : "The last payment did not go through. Top up your credits to keep your storage.",
      ...(elsewhere ? {} : { action: { label: "Top up credits", href: BILLING_ROUTE } }),
    };
  }

  if (state === "canceled") {
    return {
      tone: "warning",
      title: "Your Drive plan has been cancelled",
      description: elsewhere
        ? `Your files are still here. Subscribe again in ${elsewhere} to keep uploading.`
        : "Your files are still here, but you need an active plan to upload. Subscribe again whenever you are ready.",
      ...(elsewhere ? {} : { action: plansAction }),
      // Cancelling is deliberate, so this one can be put away.
      dismissKey: "hippius:service-status:drive-canceled",
    };
  }

  // `active`, `none`, and any state added server-side that this build has
  // not been taught about: say nothing rather than guess at its severity.
  return null;
}
