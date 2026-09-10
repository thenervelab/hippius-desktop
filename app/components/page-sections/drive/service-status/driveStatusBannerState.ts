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
  tone: "info" | "warning" | "danger";
  title: string;
  description: string;
  /** Absent when the plan is managed somewhere this app cannot reach. */
  action?: { label: string; href: string };
  /** Set when the banner may be put away; the key persists the dismissal. */
  dismissKey?: string;
}

/**
 * How long files survive on an account with no plan.
 *
 * A claim about SERVER behaviour that this app cannot verify — nothing
 * in the API reports a retention window, so the number is carried here
 * on product's word. Named rather than inlined for exactly that reason:
 * if the server's window changes, this is the one line to change, and
 * anything that quotes a different number is wrong by construction.
 */
export const NO_PLAN_RETENTION_DAYS = 30;

/**
 * The banner for an account with no storage capacity at all — an access
 * key that is not entitled to the included allowance and has not
 * subscribed.
 *
 * Lives here, and is the ONLY wording of this state, because two
 * surfaces draw it: the Drive page and the Overview page's card row.
 * Split copies drift, and this is the one message that has to be
 * unambiguous — the account is both blocked from uploading and on a
 * clock to lose what it already has.
 *
 * Both halves are said, in that order: the files already stored are
 * deleted, and nothing new can go up. The deletion leads because it is
 * the half with a deadline and the half the user cannot undo.
 */
export function getNoStoragePlanBanner(
  capacitySource?: "subscription" | "free" | "none",
): DriveStatusBanner | null {
  if (capacitySource !== "none") return null;
  return {
    tone: "danger",
    title: "You don't have a subscription plan",
    description: `Your account has no storage. Files you have already uploaded are permanently deleted after ${NO_PLAN_RETENTION_DAYS} days without a plan, and nothing new can be uploaded until you subscribe.`,
    action: { label: "See storage plans", href: BILLING_ROUTE },
    // No dismiss key: subscribing is the only thing that resolves it, and
    // dismissing does not stop the deletion — putting it away would hide
    // the one warning the user cannot afford to miss. The reverse of the
    // cancelled-plan notice, where cancelling was the user's own act.
  };
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
  capacitySource?: "subscription" | "free" | "none",
): DriveStatusBanner | null {
  // Checked FIRST, and it outranks anything the services endpoint says:
  // an account with no capacity at all cannot use Drive at all, where a
  // bad billing state still leaves it readable.
  const noPlan = getNoStoragePlanBanner(capacitySource);
  if (noPlan) return noPlan;

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
