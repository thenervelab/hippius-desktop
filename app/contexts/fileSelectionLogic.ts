import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

/**
 * Identity key for a selected row. `label` + `actualFileName` is globally
 * unique for files (whose actualFileName is the full sync-root-relative path),
 * but folder rows carry only their basename in `actualFileName`, so
 * `parentRelativePath` is the disambiguator that makes the same folder name in
 * two different locations distinct.
 */
export const selectionKey = (file: FormattedUserFile): string => {
  const name = file.actualFileName ?? file.name;
  if (file.isFolder) {
    const parent = file.parentRelativePath ?? "";
    return `folder:${file.label ?? ""}::${parent ? `${parent}/` : ""}${name}`;
  }
  return `file:${file.label ?? ""}::${name}`;
};

/** The sync-root-relative path of a folder row (parent + basename). */
function folderFullPathOf(folder: FormattedUserFile): string {
  const name = folder.actualFileName ?? folder.name;
  const parent = folder.parentRelativePath ?? "";
  return parent ? `${parent}/${name}` : name;
}

/**
 * Drop every STRICT descendant of `folder` from `selected` — same label, path
 * under `${folderFullPath}/`. The folder row itself is preserved.
 *
 * The `/` suffix on the prefix is what prevents the sibling false-positive: a
 * folder "a" must not subsume "ab/file" (which is a different folder's child).
 * The label guard keeps two same-named folders on different drives independent.
 *
 * Shared by both selection paths: `removeDescendantsOf` (keep the folder,
 * drop its children) and `toggleFolderSelection` (which calls this in its
 * toggle-ON branch, where the folder is provably absent from `selected`, then
 * appends it — so preserving-the-folder-itself here is a no-op there).
 */
export function removeDescendantsFromSelection(
  selected: FormattedUserFile[],
  folder: FormattedUserFile
): FormattedUserFile[] {
  const label = folder.label ?? "";
  const folderFullPath = folderFullPathOf(folder);
  const descendantPrefix = `${folderFullPath}/`;
  return selected.filter((f) => {
    if ((f.label ?? "") !== label) return true;
    if (f.isFolder) {
      const fullPath = folderFullPathOf(f);
      if (fullPath === folderFullPath) return true; // keep the folder itself
      return !fullPath.startsWith(descendantPrefix);
    }
    const filePath = f.actualFileName ?? f.name;
    return !filePath.startsWith(descendantPrefix);
  });
}
