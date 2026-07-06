import { errorMessage } from "@/lib/utils/errorUtils";

/**
 * Toast text for a failed folder delete.
 *
 * The delete catch blocks used to show a fixed "Failed to delete folder from
 * server" string and `console.error(rawError)` — so a user (and a support log)
 * saw a useless `{kind,message}` object and no reason. This surfaces the real
 * AppError message so the failure is actionable. Pairing it with a refetch on
 * the call site also hides a "failed-but-actually-deleted" folder (F-2: the
 * server commits the delete before the client read times out).
 */
export function deleteFolderErrorToast(error: unknown): string {
  return `Failed to delete folder: ${errorMessage(error)}`;
}
