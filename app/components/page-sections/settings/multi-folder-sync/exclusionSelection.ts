import type { ExcludePatternEntry } from "@/lib/types/excludePattern";

/**
 * Which picker paths start ticked: every path the drive does not already
 * exclude by name. A literal exclusion is stored escaped and comes back with
 * the file name as `display`, so that is the side a picker path can equal. A
 * typed glob never equals a path and unticks nothing, as before.
 */
export function initialSelection(
  paths: string[],
  exclusions: ExcludePatternEntry[],
): Set<string> {
  const excluded = new Set(exclusions.map((entry) => entry.display));
  return new Set(paths.filter((path) => !excluded.has(path)));
}
