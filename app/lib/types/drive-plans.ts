/**
 * Drive storage plans (`/api/drive/...`).
 *
 * These are the new per-account storage subscriptions, separate from the
 * Stripe credit top-ups on the Billing page: a plan grants storage, a top-up
 * adds credits. A credits-rail plan is paid *out of* that credit balance.
 */

export type DrivePlanCode = "free" | "solo" | "duo" | "max" | "scale";
export type DriveBillingPeriod = "monthly" | "annual";
export type DriveProvider = "credits" | "stripe" | "apple" | "google";
export type DriveSubscriptionStatus = "active" | "past_due" | "canceled";
export type DriveManagedBy = "console" | "stripe" | "app_store" | "play_store";
/** How the credits that pay the plan get onto the account. */
export type DriveFunding = "credits" | "card";
/** How to pay a subscribe: from the balance, or by card via Stripe Checkout. */
export type DrivePaymentRail = "credits" | "card";

export interface DriveSavedCard {
  id: string;
  brand: string;
  last4: string;
  /** MM/YY */
  exp: string;
}

export interface DriveCardInfo {
  saved: DriveSavedCard | null;
  next_charge: {
    date: string | null;
    credits: string;
    covered_by_balance: boolean;
    topup_planned: boolean;
  };
}

export interface DriveNotice {
  kind: "charged" | "failed" | "no_card" | string;
  text: string;
  at: string;
}

/** A card checkout in flight: pending -> paid (minting) -> fulfilled | failed. */
export type DriveCheckoutStatus = "pending" | "paid" | "fulfilled" | "failed";

export interface DriveCheckoutStart {
  intent_id: string;
  checkout_url: string;
  credits: string;
  amount_cents: number;
}

export interface DriveCheckoutIntent {
  intent_id: string;
  status: DriveCheckoutStatus;
  plan: string;
  billing_period: DriveBillingPeriod;
  credits: string;
  amount_cents: number;
  payment_status: string;
  minted: boolean;
  error: string | null;
  subscription: DriveSubscription | null;
}

export interface DrivePlan {
  code: DrivePlanCode;
  name: string;
  storage_bytes: number;
  price_credits_monthly: number;
  /** Effective per-month credits when billed annually, not the annual total. */
  price_credits_annual: number;
  is_free: boolean;
}

export interface DriveSubscription {
  active: boolean;
  plan?: DrivePlanCode | string;
  plan_name?: string;
  /** Total storage granted by the subscription. */
  storage_bytes?: number;
  provider?: DriveProvider;
  billing_period?: DriveBillingPeriod;
  status?: DriveSubscriptionStatus;
  /** Days since the epoch, not seconds. See `nextChargeDate`. */
  next_charge_unix_day?: number | null;
  subscription_id?: number | null;
  managed_by?: DriveManagedBy;
  funding?: DriveFunding;
  auto_topup?: boolean;
  /** Only on GET /subscription/, only for card-funded plans. */
  card?: DriveCardInfo | null;
  /** Last thing the renewal funding told the user; the banner for .local accounts. */
  notice?: DriveNotice | null;
  // The API may add fields without a console release.
  [key: string]: unknown;
}

/** Size order, so a plan change can be described as an upgrade or a downgrade. */
const PLAN_RANK: Record<DrivePlanCode, number> = {
  free: 0,
  solo: 1,
  duo: 2,
  max: 3,
  scale: 4,
};

export function planRank(code: string | undefined): number {
  return PLAN_RANK[code as DrivePlanCode] ?? -1;
}

/**
 * Upgrade or downgrade, decided by storage first. The rank table is only a
 * tie-breaker: a plan the console has not been taught about (a new code from
 * the API) used to rank below Free and show "Downgrade" on the biggest plan.
 */
export function isUpgrade(from: DrivePlan | undefined, to: DrivePlan): boolean {
  if (!from) return true;
  if (to.storage_bytes !== from.storage_bytes) return to.storage_bytes > from.storage_bytes;
  return planRank(to.code) > planRank(from.code);
}

/**
 * Plans that may create shared drives: Plus, Max and Scale. Settled at
 * founder level (shared drives plan, 3.3). Joining one is open to every plan
 * including Free, because the owner pays for everything in the drive, so
 * this gate applies to creating and inviting only. The server enforces the
 * same rule; the console reads it to offer the upgrade before the refusal.
 */
export const SHARED_DRIVE_PLAN_CODES: ReadonlySet<DrivePlanCode> = new Set([
  "duo",
  "max",
  "scale",
]);

export function planAllowsSharedDrives(code: string | undefined): boolean {
  return SHARED_DRIVE_PLAN_CODES.has(code as DrivePlanCode);
}

/** Plans that come with a shared team drive, for the plan card perk list. */
export function hasSharedTeamDrive(plan: DrivePlan): boolean {
  return planAllowsSharedDrives(plan.code);
}

/** The plan the user is on when they hold no subscription. */
export const DEFAULT_PLAN_CODE: DrivePlanCode = "free";

export function planPrice(plan: DrivePlan, period: DriveBillingPeriod): number {
  return period === "annual"
    ? plan.price_credits_annual
    : plan.price_credits_monthly;
}

/**
 * What is actually charged on the first payment. The annual price is quoted
 * per month, so a year costs twelve of them.
 */
export function chargeAmount(
  plan: DrivePlan,
  period: DriveBillingPeriod
): number {
  if (plan.is_free) return 0;
  return period === "annual"
    ? Math.round(plan.price_credits_annual * 12 * 100) / 100
    : plan.price_credits_monthly;
}

/**
 * Plan sizes are exact powers of 1024 (10 GiB, 1 TiB, 3 TiB, 10 TiB) but the
 * plans are sold in the marketing units, so they are rendered as GB and TB.
 * `formatBinaryBytes` would print "10 GiB" on a card that the pricing page,
 * the mobile app and the plan name all call 10 GB.
 */
export function formatPlanStorage(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 GB";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${parseFloat(value.toFixed(2))} ${units[i]}`;
}

/**
 * `next_charge_unix_day` counts days since the epoch, so it is read in UTC.
 * Multiplying into a local date would land on the previous day for anyone
 * west of Greenwich.
 */
export function nextChargeDate(sub: DriveSubscription | undefined): Date | null {
  const day = sub?.next_charge_unix_day;
  if (typeof day !== "number" || day <= 0) return null;
  return new Date(day * 86_400_000);
}

export function formatNextCharge(sub: DriveSubscription | undefined): string | null {
  const date = nextChargeDate(sub);
  if (!date) return null;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Where a subscription has to be managed, for the rails we cannot touch. */
const MANAGED_BY_LABEL: Record<DriveManagedBy, string> = {
  console: "Hippius Console",
  stripe: "your Stripe billing portal",
  app_store: "the App Store",
  play_store: "Google Play",
};

export function managedByLabel(sub: DriveSubscription | undefined): string {
  return MANAGED_BY_LABEL[sub?.managed_by as DriveManagedBy] ?? "another store";
}

/**
 * Whether the console is allowed to change this subscription at all. The API
 * refuses subscribe, change and cancel with a 409 for anything bought on
 * another rail, so the buttons are disabled rather than left to fail.
 */
export function isManagedByConsole(sub: DriveSubscription | undefined): boolean {
  if (!sub?.active) return true;
  const managedBy = sub.managed_by ?? "console";
  return managedBy === "console";
}

/** The plan code the user is effectively on, treating "no subscription" as free. */
export function currentPlanCode(sub: DriveSubscription | undefined): DrivePlanCode {
  if (!sub?.active) return DEFAULT_PLAN_CODE;
  const code = sub.plan as DrivePlanCode | undefined;
  return code && code in PLAN_RANK ? code : DEFAULT_PLAN_CODE;
}

/** Words for the renewal, from the card info the API sends with the subscription. */
export function describeCardRenewal(sub: DriveSubscription | undefined): string | null {
  const card = sub?.card;
  if (!card || sub?.funding !== "card") return null;
  const when = card.next_charge.date ?? "the next renewal";
  if (!card.saved) return `No card on file: the renewal on ${when} needs a card or credits.`;
  const c = `${card.saved.brand} •••• ${card.saved.last4}`;
  if (card.next_charge.covered_by_balance) return `Renews on ${when} from your balance; ${c} stays saved at Stripe.`;
  if (card.next_charge.topup_planned) return `${c} will be charged before the renewal on ${when}.`;
  return `Renews on ${when}.`;
}
