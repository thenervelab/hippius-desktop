import { useInvokeMutation } from "./useInvokeMutation";
import { useInvokeQuery } from "./useInvokeQuery";
import type {
  DriveBillingPeriod,
  DriveCheckoutIntent,
  DriveCheckoutStart,
  DrivePlanCode,
  DriveSubscription,
} from "@/lib/types/drive-plans";

export const DRIVE_SUBSCRIPTION_QUERY_KEY = "drive-subscription";

/**
 * Where Stripe sends the browser after a card checkout. The desktop cannot
 * receive that redirect, so it lands on the console's plans page and the
 * desktop polls the intent itself (see `useDriveCheckoutIntent`).
 */
export const DRIVE_CHECKOUT_RETURN_URL =
  "https://console.hippius.com/dashboard/storage/drive/plans";

/**
 * The account's drive subscription, or `{ active: false }` when there is
 * none. Not having one is a normal state, not an error.
 */
export function useDriveSubscription(options?: {
  /** Poll at this interval while waiting for an on-chain write to land. */
  refetchInterval?: number | false;
}) {
  return useInvokeQuery<DriveSubscription>({
    command: "get_drive_subscription",
    queryKey: (addr) => [DRIVE_SUBSCRIPTION_QUERY_KEY, addr],
    options: { refetchInterval: options?.refetchInterval ?? false },
  });
}

export interface DrivePlanChangeInput {
  plan: Exclude<DrivePlanCode, "free">;
  period?: DriveBillingPeriod;
}

const INVALIDATE = [[DRIVE_SUBSCRIPTION_QUERY_KEY]];

/** Subscribe from no plan. 402 when credits are short, 409 when a plan exists. */
export function useSubscribeDrivePlan() {
  return useInvokeMutation<DriveSubscription, DrivePlanChangeInput>({
    command: "subscribe_drive_plan",
    params: (accountId, v) => ({
      accountId,
      plan: v.plan,
      period: v.period ?? "monthly",
    }),
    invalidateKeys: INVALIDATE,
  });
}

/** Upgrade or downgrade an existing plan. Refused if usage exceeds the target. */
export function useChangeDrivePlan() {
  return useInvokeMutation<DriveSubscription, DrivePlanChangeInput>({
    command: "change_drive_plan",
    params: (accountId, v) => ({
      accountId,
      plan: v.plan,
      period: v.period ?? "monthly",
    }),
    invalidateKeys: INVALIDATE,
  });
}

/** Cancel, which returns the account to the free plan. */
export function useCancelDriveSubscription() {
  return useInvokeMutation<void, void>({
    command: "cancel_drive_subscription",
    invalidateKeys: INVALIDATE,
  });
}

/**
 * Pay a plan by card. Answers with a Stripe Checkout URL to open in the
 * browser; the plan is bought once the credits are minted, and the card is
 * kept for renewals. Nothing is subscribed until then.
 */
export function useStartDriveCardCheckout() {
  return useInvokeMutation<DriveCheckoutStart, DrivePlanChangeInput>({
    command: "start_drive_card_checkout",
    params: (accountId, v) => ({
      accountId,
      plan: v.plan,
      period: v.period ?? "monthly",
      returnTo: DRIVE_CHECKOUT_RETURN_URL,
    }),
  });
}

/** Poll a card checkout until it is fulfilled or failed. */
export function useDriveCheckoutIntent(
  intentId: string | null,
  pollMs = 3_000,
) {
  return useInvokeQuery<DriveCheckoutIntent>({
    command: "get_drive_checkout_intent",
    queryKey: (addr) => ["drive-checkout-intent", intentId, addr],
    params: (accountId) => (intentId ? { accountId, intentId } : null),
    enabled: !!intentId,
    options: {
      refetchInterval: (q) => {
        const st = q.state.data?.status;
        return st === "fulfilled" || st === "failed" ? false : pollMs;
      },
    },
  });
}
