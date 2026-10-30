"use client";

import { useCallback } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { BarChart3 } from "lucide-react";

import type { ActionItem } from "@/app/components/ui/alt-table/TableActionMenu";
import {
  insightsSheetAtom,
  shareInsightsEnabledAtom,
  type CaptureLinkSource,
} from "@/app/lib/global-atoms/sharesAtoms";
import { useSharedFiles } from "@/app/lib/hooks/useSharedFiles";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { CAPTURES_ROUTE } from "@/app/lib/routes";
import type { ShareSummary } from "@/app/lib/tauri/shares";
import { cloudFileIdFor } from "@/app/lib/tray/trayRowActions";
import { captureSharesFrom, isCaptureMedia, newestShare } from "@/app/lib/utils/fileLinks";
import { useDriveRoute } from "./driveRoute";

/** The words for opening a capture's Insights, wherever it is offered. */
export const VIEW_INSIGHTS_LABEL = "View insights";

export { captureSharesFrom, isCaptureMedia, isCaptureName, newestShare } from "@/app/lib/utils/fileLinks";

export function newestShareToken(rows: ShareSummary[]): string | null {
  return newestShare(rows)?.shareToken ?? null;
}

/**
 * {@link captureSharesFrom} over the share listing already loaded, so a row
 * asks nothing of the server. Not tied to a page: the Insights sheet uses it
 * to find a capture's link when it was opened before one was known.
 */
export function useCaptureShares() {
  const { getSharesFor, getUnplacedSharesNamed, isLoading, isError, refetch } = useSharedFiles();
  const sharesFor = useCallback(
    (label: string | null | undefined, relativePath: string | null | undefined, size?: number) =>
      captureSharesFrom({ getSharesFor, getUnplacedSharesNamed }, label, relativePath, size),
    [getSharesFor, getUnplacedSharesNamed],
  );
  return { sharesFor, isLoading, isError, refetch };
}

/**
 * The tokens of a capture's links, by the same lookup as its Insights
 * ({@link captureSharesFrom}), for "Also turn off its links" when it is
 * deleted. Nothing for a folder or a file that is not a screenshot or a
 * recording.
 */
export function useCaptureLinkTokens() {
  const { sharesFor } = useCaptureShares();
  return useCallback(
    (file: FormattedUserFile): string[] => {
      const relativePath = file.actualFileName || file.name;
      if (file.isFolder || !isCaptureMedia(relativePath)) return [];
      return [...new Set(sharesFor(file.label, relativePath, file.size).map((row) => row.shareToken))];
    },
    [sharesFor],
  );
}

/**
 * Whether a row on the Captures page offers Insights, and the link they are
 * about. `offered` is true for every screenshot and recording (never a
 * folder) once the server has Insights; `share` is its newest link, or
 * `null` while it has none, when the Insights sheet offers to make one.
 * Off the Captures page nothing is offered. Shared by the row's Insights
 * button and its menu item so the two can never disagree.
 */
export function useCaptureInsightsShare() {
  const { basePath } = useDriveRoute();
  const enabled = useAtomValue(shareInsightsEnabledAtom);
  const { sharesFor } = useCaptureShares();
  return useCallback(
    (
      label: string | null | undefined,
      relativePath: string | null | undefined,
      isFolder: boolean,
      size?: number,
    ): { offered: boolean; share: ShareSummary | null } => {
      if (basePath !== CAPTURES_ROUTE || !enabled || isFolder || !label || !relativePath || !isCaptureMedia(relativePath)) {
        return { offered: false, share: null };
      }
      return { offered: true, share: newestShare(sharesFor(label, relativePath, size)) };
    },
    [basePath, enabled, sharesFor],
  );
}

/**
 * What "Create link" in the Insights sheet makes a capture's link from: its
 * drive and path, and its server id when there is no copy on this computer
 * (the Share dialog's cloud-only dispatch).
 */
export function captureLinkSource(file: FormattedUserFile, relativePath: string): CaptureLinkSource | undefined {
  if (!file.label || !relativePath) return undefined;
  return {
    label: file.label,
    relativePath,
    fileId: cloudFileIdFor(file),
    ...(file.size ? { size: file.size } : {}),
  };
}

/**
 * The "View insights" item for a row on the Captures page: offered for every
 * screenshot and recording once the server has Insights, with a link or not
 * (the sheet offers to make one). Elsewhere it adds nothing. `relativePath`
 * is the row's drive-relative path, resolved by the caller the same way its
 * Share item is.
 */
export function useCaptureInsightsItem() {
  const shareFor = useCaptureInsightsShare();
  const open = useSetAtom(insightsSheetAtom);
  return useCallback(
    (file: FormattedUserFile, relativePath: string, onOpen?: () => void): ActionItem[] => {
      const { offered, share } = shareFor(file.label, relativePath, Boolean(file.isFolder), file.size);
      if (!offered) return [];
      return [
        {
          icon: <BarChart3 className="size-4" />,
          itemTitle: VIEW_INSIGHTS_LABEL,
          onItemClick: (e?: React.MouseEvent) => {
            e?.preventDefault();
            e?.stopPropagation();
            onOpen?.();
            open({
              shareToken: share?.shareToken ?? null,
              fileName: file.actualFileName || file.name,
              file,
              capture: captureLinkSource(file, relativePath),
            });
          },
        },
      ];
    },
    [shareFor, open],
  );
}
