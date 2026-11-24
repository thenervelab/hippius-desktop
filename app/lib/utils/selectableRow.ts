import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

/**
 * Whether a row can be selected for the selection bar's bulk actions: not
 * while it is still syncing (`isAssigned`), and never a whole drive's row
 * (Starred), whose `source` is the drive's sync root, so a bulk Delete or
 * Move would act on the whole drive folder.
 */
export function isSelectableRow(file: Pick<FormattedUserFile, "isAssigned" | "isDriveRoot">): boolean {
  return Boolean(file.isAssigned) && !file.isDriveRoot;
}
