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
import { getFileTypeFromExtension } from "@/app/lib/utils/getTileTypeFromExtension";
import { useDriveRoute } from "./driveRoute";

/** The words for opening a capture's Insights, wherever it is offered. */
export const VIEW_INSIGHTS_LABEL = "View insights";

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

/** A screenshot or a recording: the files Insights are offered for. */
export function isCaptureMedia(name: string | null | undefined): boolean {
  const dot = name?.lastIndexOf(".") ?? -1;
  if (!name || dot < 0) return false;
  const type = getFileTypeFromExtension(name.slice(dot + 1));
  return type === "image" || type === "video";
}

/** The last part of a drive-relative path. */
function baseName(relativePath: string): string {
  return relativePath.slice(relativePath.lastIndexOf("/") + 1);
}

/**
 * A capture's links: the ones this device made for its path, and the ones
 * made elsewhere (the browser extension, the web console, another
 * computer) from a file of the same name, unless the sizes say it was a
 * different file. The server names a link's file by name and size only, and
 * the console and the extension match links to files the same way. Trusted
 * only for screenshots and recordings, whose names carry the second they
 * were taken; any other file gets only this device's links.
 */
export function captureSharesFrom(
  lookups: Pick<ReturnType<typeof useSharedFiles>, "getSharesFor" | "getUnplacedSharesNamed">,
  label: string | null | undefined,
  relativePath: string | null | undefined,
  size?: number,
): ShareSummary[] {
  if (!label || !relativePath) return [];
  const placed = lookups.getSharesFor(label, relativePath);
  if (!isCaptureMedia(relativePath)) return placed;
  const named = lookups
    .getUnplacedSharesNamed(baseName(relativePath))
    .filter((row) => !size || !row.plaintextSize || row.plaintextSize === size);
  return named.length === 0 ? placed : [...placed, ...named];
}

/**
 * {@link captureSharesFrom} over the share listing already loaded, so a row
 * asks nothing of the server. Not tied to a page: the Insights sheet uses it
 * to find a capture's link when it was opened before one was known.
 */
export function useCaptureShares() {
  const { getSharesFor, getUnplacedSharesNamed, isLoading } = useSharedFiles();
  const sharesFor = useCallback(
    (label: string | null | undefined, relativePath: string | null | undefined, size?: number) =>
      captureSharesFrom({ getSharesFor, getUnplacedSharesNamed }, label, relativePath, size),
    [getSharesFor, getUnplacedSharesNamed],
  );
  return { sharesFor, isLoading };
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
  return { label: file.label, relativePath, fileId: cloudFileIdFor(file) };
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
