"use client";

import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

import type { ExcludePatternEntry } from "@/app/lib/types/excludePattern";

export const EXCLUDE_PATTERNS_QUERY_KEY = "driveExcludePatterns";

/**
 * Whether a drive has any exclude rules configured.
 *
 * `list_exclude_patterns` re-reads the drive's `.hippius/exclude`, which is
 * a few short lines, so this is cheap enough to ask per drive. It is only
 * used to decide whether to OFFER the Excluded filter, so a stale answer
 * costs a chip that appears a moment late, never a wrong listing.
 */
export function useHasExclusions(label: string | null): boolean {
  const { data } = useQuery({
    queryKey: [EXCLUDE_PATTERNS_QUERY_KEY, label],
    queryFn: () => invoke<ExcludePatternEntry[]>("list_exclude_patterns", { label }),
    enabled: Boolean(label),
    staleTime: 60_000,
  });
  return (data?.length ?? 0) > 0;
}
