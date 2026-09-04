import { useInvokeQuery } from "./useInvokeQuery";
import type { TransactionObject } from "./useBillingTransactions";

/**
 * One line of the drive plan ledger, as the API is expected to return it.
 * The same contract the console codes against; if the shipped shape
 * differs, this file is the only place that has to change.
 */
export interface DriveSubscriptionEvent {
  id: string;
  kind:
    | "subscribe"
    | "renewal"
    | "upgrade"
    | "downgrade"
    | "cancel"
    | "refund"
    | string;
  plan: string;
  plan_name?: string;
  /** Credits moved by this event. One credit is one dollar. */
  amount_credits: number | string;
  /** Which rail paid: the credit balance, or a card through Stripe. */
  provider: "credits" | "stripe" | string;
  status: string;
  created_at: string;
}

interface HistoryResponse {
  results?: DriveSubscriptionEvent[];
}

/** A history row: the billing table's shape plus what the event was. */
export type DriveHistoryRow = TransactionObject & { description: string };

export const DRIVE_SUBSCRIPTION_HISTORY_QUERY_KEY =
  "drive-subscription-history";

const KIND_LABEL: Record<string, string> = {
  subscribe: "Subscribed",
  renewal: "Renewal",
  upgrade: "Upgrade",
  downgrade: "Downgrade",
  cancel: "Cancelled",
  refund: "Refund",
};

/** Turn an API event into the row shape the billing history table draws. */
export function toTransaction(event: DriveSubscriptionEvent): DriveHistoryRow {
  const raw =
    typeof event.amount_credits === "string"
      ? parseFloat(event.amount_credits)
      : event.amount_credits;
  return {
    id: event.id,
    transaction_type: event.provider === "stripe" ? "card" : "credits",
    amount: Number.isFinite(raw) ? raw : 0,
    transaction_date: event.created_at,
    status: event.status,
    description: `${KIND_LABEL[event.kind] ?? event.kind} · ${event.plan_name ?? event.plan}`,
  };
}

/**
 * The drive plan's history, newest first. The Rust command already folds a
 * 404 into an empty list, so "nothing yet" never reads as an error here.
 */
export default function useDriveSubscriptionHistory() {
  return useInvokeQuery<
    HistoryResponse | DriveSubscriptionEvent[],
    DriveHistoryRow[]
  >({
    command: "get_drive_subscription_history",
    queryKey: (addr) => [DRIVE_SUBSCRIPTION_HISTORY_QUERY_KEY, addr],
    options: {
      select: (data) =>
        (Array.isArray(data) ? data : (data?.results ?? [])).map(toTransaction),
    },
  });
}
