"use client";

// The file details panel's extra rows (Date Taken, Date Modified, Camera,
// Uploaded from), looked up by Rust with one `/search_files` file-id lookup.
// Asked for only while the panel is open on a file the server holds; Rust
// checks the hit, trusts or drops each date and labels the device.

import { useQuery } from "@tanstack/react-query";

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { remoteDriveLabel } from "@/app/lib/utils/renameGating";
import { getFileSourceDetails, type FileSourceDetails, type FileSourceTarget } from "@/app/lib/tauri/devices";

const FILE_ID = /^[0-9a-f]{64}$/;

export const FILE_SOURCE_DETAILS_QUERY_KEY = "fileSourceDetails";

/**
 * What to ask Rust about, or `null` when the row has nothing to ask: a
 * folder (folders and drives get no extra rows), a row with no 64-hex file
 * id yet, a row still uploading or refused, or one with no drive to look in.
 */
export function fileSourceTarget(file: FormattedUserFile | null | undefined): FileSourceTarget | null {
  if (!file || file.isFolder) return null;
  if (file.syncStatus === "uploading" || file.syncStatus === "failed") return null;
  const fileId = (file.fileId || file.arionHash || "").toLowerCase();
  if (!FILE_ID.test(fileId)) return null;
  const label = remoteDriveLabel(file) ?? file.label ?? null;
  if (!label) return null;
  return { label, fileId };
}

/** The extra rows for `file`; `undefined` until Rust answers, and on any failure. */
export function useFileSourceDetails(
  accountId: string | null | undefined,
  file: FormattedUserFile | null | undefined,
): FileSourceDetails | undefined {
  const target = fileSourceTarget(file);
  const { data } = useQuery({
    queryKey: [FILE_SOURCE_DETAILS_QUERY_KEY, accountId ?? null, target?.label ?? null, target?.fileId ?? null],
    queryFn: () => getFileSourceDetails(accountId as string, target as FileSourceTarget),
    enabled: Boolean(accountId && target),
    // A file's capture details never change under it; a lookup that failed
    // shows nothing rather than an error, so it is not retried.
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return data;
}
