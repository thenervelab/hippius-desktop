import { remoteLabelFromSource } from "@/app/lib/hooks/use-nested-folder-listing";

export interface FolderExpansionInputs {
  accountId: string | null | undefined;
  /** The expanding row's `source`; `remote://<label>` for a browsed drive. */
  source: string | null | undefined;
  /** The row's own label, when it carries one. */
  label: string | null | undefined;
  /** Sync root. A browsed drive has none — that is what "not synced" means. */
  syncPath: string | null | undefined;
  /** Drive-relative path of the folder being expanded. */
  relativePath: string;
}

export interface FolderExpansion {
  enabled: boolean;
  /** Drive to list; the row's label, or the one in its remote source. */
  label: string | null;
  /** List from the SERVER rather than local disk. */
  remote: boolean;
}

/**
 * Whether a folder row can expand, and where its children come from.
 *
 * Expanding used to require a `syncPath`, which a browsed drive does not
 * have, so the chevron on a folder inside one did nothing at all — no
 * request, no error, no empty state.
 *
 * Both facts come off the row: a folder inside a browsed drive carries
 * `remote://<label>` as its source, so nothing has to be threaded down
 * through the table to reach it.
 */
export function resolveFolderExpansion(
  inputs: FolderExpansionInputs,
): FolderExpansion {
  const remoteLabel = remoteLabelFromSource(inputs.source);
  const remote = remoteLabel !== null;
  const label = inputs.label ?? remoteLabel;

  return {
    // A remote listing is addressed by label alone; a local one needs the
    // root to walk.
    enabled: Boolean(
      inputs.accountId && label && inputs.relativePath && (remote || inputs.syncPath),
    ),
    label,
    remote,
  };
}
