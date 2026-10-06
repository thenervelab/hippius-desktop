import { invoke } from "@tauri-apps/api/core";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type { ActionItem } from "@/app/components/ui/alt-table/TableActionMenu";
import { Close, Refresh } from "@/components/ui/icons";
import type { FileFailureRecord } from "@/app/lib/types/fileFailure";
import { failedRowAction } from "@/app/lib/utils/failureMessage";
import { notifyFilesMutated } from "@/app/lib/utils/fileMutationEvents";
import { tauriErrorMessage } from "@/lib/utils/dispatchTauriError";

// Same key `useDriveFailures` caches the drive's saved failures under; the
// row badges have already fetched it by the time a row menu opens.
const DRIVE_FAILURES_KEY = "drive-failures";

interface FailedRowMenuArgs {
  label: string;
  /** The file's drive-relative path, as Rust keys its failure row. */
  relativePath: string;
  queryClient: QueryClient;
  polkadotAddress: string | null | undefined;
  disabled: boolean;
}

/**
 * The menu action for a failed file row, decided by its saved failure's kind
 * (see `failedRowAction`): Retry sync, Dismiss for a refusal, or nothing for
 * an undecryptable file. Reads the drive's failures from the query cache, so
 * building a menu costs no IPC.
 */
export function failedRowMenuItem(args: FailedRowMenuArgs): ActionItem | null {
  const { label, relativePath, queryClient, disabled } = args;
  const saved = queryClient
    .getQueryData<FileFailureRecord[]>([DRIVE_FAILURES_KEY, label])
    ?.find((f) => f.relativePath === relativePath);
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: [DRIVE_FAILURES_KEY, label] });

  switch (failedRowAction(saved)) {
    case "retry":
      return {
        icon: <Refresh className="size-4" />,
        itemTitle: "Retry sync",
        onItemClick: () => {
          void invoke("retry_file_failure", { label, path: relativePath })
            .then(() => {
              void invalidate();
              toast.success("Retrying sync…");
            })
            .catch((e) => toast.error(`Retry failed: ${tauriErrorMessage(e)}`));
        },
        disabled,
      };
    case "dismiss":
      return {
        icon: <Close className="size-4" />,
        itemTitle: "Dismiss",
        onItemClick: () => {
          void invoke("clear_file_failure", { label, relativePath })
            .then(async () => {
              void invalidate();
              // The listing paints the row failed from the saved row, so it
              // must re-read to drop the badge.
              await notifyFilesMutated(queryClient, args.polkadotAddress);
            })
            .catch((e) => toast.error(tauriErrorMessage(e)));
        },
        disabled,
      };
    case null:
      return null;
  }
}
