"use client";

import { useCallback } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { BarChart3 } from "lucide-react";

import type { ActionItem } from "@/app/components/ui/alt-table/TableActionMenu";
import { insightsSheetAtom, shareInsightsEnabledAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { useSharedFiles } from "@/app/lib/hooks/useSharedFiles";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { CAPTURES_ROUTE } from "@/app/lib/routes";
import type { ShareSummary } from "@/app/lib/tauri/shares";
import { useDriveRoute } from "./driveRoute";

/** The newest of a file's links: the one its Insights are about. */
export function newestShareToken(rows: ShareSummary[]): string | null {
  let newest: ShareSummary | null = null;
  for (const row of rows) {
    if (!newest || Date.parse(row.createdAt) > Date.parse(newest.createdAt)) newest = row;
  }
  return newest?.shareToken ?? null;
}

/**
 * The "Insights" item for a row on the Captures page: offered for a capture
 * that has a link, once the server has Insights. Elsewhere it adds nothing.
 * `relativePath` is the row's drive-relative path, resolved by the caller
 * the same way its Share item is.
 */
export function useCaptureInsightsItem() {
  const { basePath } = useDriveRoute();
  const enabled = useAtomValue(shareInsightsEnabledAtom);
  const { getSharesFor } = useSharedFiles();
  const open = useSetAtom(insightsSheetAtom);
  return useCallback(
    (file: FormattedUserFile, relativePath: string, onOpen?: () => void): ActionItem[] => {
      if (basePath !== CAPTURES_ROUTE || !enabled || file.isFolder) return [];
      const shareToken = newestShareToken(getSharesFor(file.label, relativePath));
      if (!shareToken) return [];
      return [
        {
          icon: <BarChart3 className="size-4" />,
          itemTitle: "Insights",
          onItemClick: (e?: React.MouseEvent) => {
            e?.preventDefault();
            e?.stopPropagation();
            onOpen?.();
            open({ shareToken, fileName: file.actualFileName || file.name });
          },
        },
      ];
    },
    [basePath, enabled, getSharesFor, open],
  );
}
