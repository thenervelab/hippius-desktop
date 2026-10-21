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
export function newestShare(rows: ShareSummary[]): ShareSummary | null {
  let newest: ShareSummary | null = null;
  for (const row of rows) {
    if (!newest || Date.parse(row.createdAt) > Date.parse(newest.createdAt)) newest = row;
  }
  return newest;
}

export function newestShareToken(rows: ShareSummary[]): string | null {
  return newestShare(rows)?.shareToken ?? null;
}

/**
 * The link whose Insights a row on the Captures page opens: its newest, for
 * a file (never a folder) with a link, on a server that has Insights.
 * Anywhere else, `null`. Shared by the row's Insights button and its menu
 * item so the two can never disagree about which rows have Insights.
 */
export function useCaptureInsightsShare() {
  const { basePath } = useDriveRoute();
  const enabled = useAtomValue(shareInsightsEnabledAtom);
  const { getSharesFor } = useSharedFiles();
  return useCallback(
    (
      label: string | null | undefined,
      relativePath: string | null | undefined,
      isFolder: boolean,
    ): ShareSummary | null => {
      if (basePath !== CAPTURES_ROUTE || !enabled || isFolder) return null;
      return newestShare(getSharesFor(label, relativePath));
    },
    [basePath, enabled, getSharesFor],
  );
}

/** {@link useCaptureInsightsShare}, as the link's token. */
export function useCaptureInsightsToken() {
  const shareFor = useCaptureInsightsShare();
  return useCallback(
    (label: string | null | undefined, relativePath: string | null | undefined, isFolder: boolean): string | null =>
      shareFor(label, relativePath, isFolder)?.shareToken ?? null,
    [shareFor],
  );
}

/**
 * The "Insights" item for a row on the Captures page: offered for a capture
 * that has a link, once the server has Insights. Elsewhere it adds nothing.
 * `relativePath` is the row's drive-relative path, resolved by the caller
 * the same way its Share item is.
 */
export function useCaptureInsightsItem() {
  const tokenFor = useCaptureInsightsToken();
  const open = useSetAtom(insightsSheetAtom);
  return useCallback(
    (file: FormattedUserFile, relativePath: string, onOpen?: () => void): ActionItem[] => {
      const shareToken = tokenFor(file.label, relativePath, Boolean(file.isFolder));
      if (!shareToken) return [];
      return [
        {
          icon: <BarChart3 className="size-4" />,
          itemTitle: "Insights",
          onItemClick: (e?: React.MouseEvent) => {
            e?.preventDefault();
            e?.stopPropagation();
            onOpen?.();
            open({ shareToken, fileName: file.actualFileName || file.name, file });
          },
        },
      ];
    },
    [tokenFor, open],
  );
}
