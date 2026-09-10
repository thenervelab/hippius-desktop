/**
 * Whether the Excluded filter chip is worth showing.
 *
 * It was shown unconditionally, so most accounts carried a filter that
 * could only ever return nothing — a control that does nothing when
 * pressed teaches people to distrust the row it sits in.
 *
 * Keyed on whether the drive has any exclude RULES rather than on a count
 * of excluded files: the rules are what the user set, they are one cheap
 * read, and a file count would need a recursive walk of the drive on every
 * render of the filter row. No rules means no excluded files, which is the
 * case worth removing.
 */
export function shouldOfferExcludedFilter(opts: {
  /** The local drive in view; null on a remote drive or Recent Files. */
  driveLabel: string | null;
  /** Whether that drive has at least one exclude rule. */
  hasExclusions: boolean;
  /** Whether the filter is currently applied. */
  excludedOnly: boolean;
}): boolean {
  // Never stranded: if the filter is on, its own control has to stay
  // reachable, or the list stays filtered with no way to clear it.
  if (opts.excludedOnly) return true;
  // Exclusions are a property of a synced folder on this machine. A remote
  // drive and the Recent Files view have none by construction.
  if (!opts.driveLabel) return false;
  return opts.hasExclusions;
}
