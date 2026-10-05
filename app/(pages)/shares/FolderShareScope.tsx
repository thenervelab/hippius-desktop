import {
  folderShareScope,
  type ScopedFolderRow,
} from "@/app/(pages)/shares/shareRowDisplay";

interface FolderShareScopeProps {
  row: ScopedFolderRow;
}

/**
 * The scope line under a folder row's name on the shares page: the shared
 * path, "Whole drive", "Folder link", or "Uploaded copy".
 *
 * The `title` is a mouse-only affordance. When the line has a description
 * (the snapshot caveat on an uploaded copy), the same text is rendered for
 * screen readers too; otherwise the title only repeats the label and nothing
 * extra is read, so the path is not announced twice.
 */
export default function FolderShareScope({ row }: FolderShareScopeProps) {
  const { label, description } = folderShareScope(row);

  return (
    <span
      className="truncate text-[11px] text-grey-50 dark:text-grey-dark-600"
      title={description ?? label}
    >
      {label}
      {/* The ": " keeps a screen reader from running the label into the
          explanation as one phrase. */}
      {description !== undefined && <span className="sr-only">: {description}</span>}
    </span>
  );
}
