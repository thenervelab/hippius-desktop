import type { SelectOption } from "@/components/ui/select/SelectOptions";

/**
 * Ticket categories the desktop offers: one per product it has (Drive only,
 * so no S3 or Hub), plus the account topics.
 *
 * The value is what the support API stores and what staff filter tickets by,
 * so it names the product, not the app: the console files its Drive tickets
 * under the same `drive`. Don't rename a value once it has shipped.
 */
export const ticketCategories: SelectOption[] = [
  { value: "drive", label: "Drive & sync" },
  { value: "shared_drives", label: "Shared drives" },
  { value: "credits", label: "Credits & payments" },
  { value: "subscription", label: "Subscription" },
  { value: "account", label: "Account & sign in" },
  { value: "feedback", label: "Feedback" },
  { value: "other", label: "Other" },
];

/**
 * Categories the desktop never offers but still has to label, because the
 * tickets table lists every ticket on the account: the console's S3 and Hub,
 * and what tickets were filed under before the list went per product.
 */
const shownOnlyTicketCategories: SelectOption[] = [
  { value: "s3", label: "S3" },
  { value: "hub", label: "Hub" },
  { value: "billing", label: "Account & billing" },
  { value: "storage", label: "Storage" },
  { value: "general", label: "General" },
];

/** The label a ticket's category shows as; a value we don't know shows as-is. */
export function ticketCategoryLabel(value: string): string {
  return (
    [...ticketCategories, ...shownOnlyTicketCategories].find(
      (c) => c.value === value
    )?.label ?? value
  );
}
