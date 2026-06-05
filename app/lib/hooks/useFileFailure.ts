import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { FileFailureRecord } from "@/app/lib/types/fileFailure";

const DRIVE_FAILURES_KEY = "drive-failures";

/**
 * All persisted failures for a drive (`get_drive_failures`). TanStack Query
 * dedupes by query key, so every file row in the same drive shares ONE fetch
 * instead of one per badge.
 */
export function useDriveFailures(label: string | undefined) {
  return useQuery({
    queryKey: [DRIVE_FAILURES_KEY, label],
    queryFn: () =>
      invoke<FileFailureRecord[]>("get_drive_failures", { label }),
    enabled: !!label,
    // Failures change rarely relative to render churn; refetch is driven by the
    // retry mutations below (and any failure-event listener that invalidates).
    staleTime: 15_000,
  });
}

/**
 * The persisted failure for a single file, matched by basename — mirroring how
 * `useFileLiveProgress` matches rows by name — or `null`. Reads the shared
 * per-drive query, so it adds no extra network cost per row.
 */
export function useFileFailure(
  label: string | undefined,
  fileName: string | undefined,
): FileFailureRecord | null {
  const { data } = useDriveFailures(label);
  if (!data || !fileName) return null;
  return data.find((f) => f.fileName === fileName) ?? null;
}

/**
 * Retry mutations for a drive. On success they invalidate the drive's failures
 * query so the badge/reason clears once Rust has dropped the persisted row.
 */
export function useRetryFailure(label: string | undefined) {
  const qc = useQueryClient();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: [DRIVE_FAILURES_KEY, label] });

  const retryFile = useMutation({
    mutationFn: (path: string) =>
      invoke<void>("retry_file_failure", { label, path }),
    onSuccess: invalidate,
  });

  const retryAll = useMutation({
    mutationFn: () => invoke<void>("retry_all_failures", { label }),
    onSuccess: invalidate,
  });

  return { retryFile, retryAll };
}
