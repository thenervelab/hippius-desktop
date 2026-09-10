import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

/**
 * The drive-relative path of a row, which is not always the name it shows.
 *
 * A FOLDER row carries only its basename: the inline-expanded tree and the
 * subfolder listing both render a folder by name and keep the containing
 * path beside it (`parentRelativePath`, or the surface's own current
 * path). A FILE row's `actualFileName` already carries the full path.
 *
 * So a folder's path has to be rebuilt from the two halves, and anything
 * that addresses a folder on disk or on the server has to do it — a
 * rename or a share that used the bare basename would act on a different
 * folder of the same name at the drive root.
 */
export function driveRelativePathFor(
  file: Pick<FormattedUserFile, "name" | "actualFileName" | "parentRelativePath" | "isFolder">,
  basePath?: string | null,
): string {
  if (!file.isFolder) return file.actualFileName || file.name;

  const trim = (value: string) => value.replace(/^\/+|\/+$/g, "");
  const name = trim(file.actualFileName || file.name);
  const base = trim(file.parentRelativePath ?? basePath ?? "");

  if (!base) return name;

  // Only treat the name as already-qualified when it genuinely carries a
  // path. A folder row's name is a bare basename, so an unconditional
  // `name === base` check would collapse `Trips/Trips` to `Trips` and
  // address the PARENT — a strict superset of what the user picked.
  // Same-named nesting is ordinary (`src/src`, an archive that re-nests
  // its own directory).
  if (name.includes("/")) return name;

  return `${base}/${name}`;
}
