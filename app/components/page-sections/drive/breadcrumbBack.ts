import type { BreadcrumbSegment } from "./SyncFolderBreadcrumb";

/**
 * Where "up one level" goes from the current breadcrumb path.
 *
 * The trail alone was the only way back out of a folder, and it is a row
 * of 40%-opacity text — easy to miss, and it asks the user to work out
 * which word is their parent. This resolves that once so the button and
 * the trail cannot disagree.
 *
 * Returns `null` at the root, where there is nowhere to go up to and the
 * control should not render at all rather than render disabled.
 */
export function resolveBreadcrumbBack(
  segments: BreadcrumbSegment[],
  onRootClick: () => void,
): { label: string; go: () => void } | null {
  if (segments.length === 0) return null;

  // One segment deep: the parent IS the root, whatever the root is called.
  if (segments.length === 1) {
    return { label: "Back to all folders", go: onRootClick };
  }

  const parent = segments[segments.length - 2];
  return {
    label: `Back to ${parent.label}`,
    // A parent with no handler cannot be navigated to; falling back to the
    // root is better than a button that does nothing, since the user's
    // intent — get out of here — is still served.
    go: parent.onClick ?? onRootClick,
  };
}
