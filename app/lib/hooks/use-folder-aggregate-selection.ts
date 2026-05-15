import { useCallback } from "react";
import { useFileSelection } from "@/app/contexts/FileSelectionContext";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

/**
 * Returns the sync-root-relative path of `file`. For files this is
 * `actualFileName` verbatim (the listing pipeline already prefixes the
 * subfolder onto every file row). For folders the basename in
 * `actualFileName` is combined with `parentRelativePath` populated at
 * selection time.
 */
function fullPathOf(file: FormattedUserFile): string {
    const name = file.actualFileName ?? file.name;
    if (file.isFolder) {
        const parent = file.parentRelativePath ?? "";
        return parent ? `${parent}/${name}` : name;
    }
    return name;
}

/**
 * Visual + logical selection helpers layered on top of the flat
 * `selectedFiles` array in `FileSelectionContext`. The flat array is
 * the source of truth; cascade/aggregate semantics derive from it
 * without forcing the context to track explicit parent/child pointers.
 *
 * Mirrors hippius-console's `useFolderAggregateSelection` (see
 * `src/components/files/files-table/index.tsx`), adapted to the
 * desktop's `label + relative-path` identity model.
 */
export interface FolderAggregateSelection {
    isVisuallySelected: (
        file: FormattedUserFile,
        ancestorChain: FormattedUserFile[],
    ) => boolean;
    classifyVisualSelection: (
        file: FormattedUserFile,
        ancestorChain: FormattedUserFile[],
    ) => "direct" | "cascade" | "none";
    clearAggregateSelection: (folder: FormattedUserFile) => void;
    computeLogicalSelection: (
        rootFiles: FormattedUserFile[],
        selected: FormattedUserFile[],
    ) => FormattedUserFile[];
}

export function useFolderAggregateSelection(): FolderAggregateSelection {
    const { isFileSelected, removeDescendantsOf } = useFileSelection();

    const isDescendant = useCallback(
        (ancestor: FormattedUserFile, descendant: FormattedUserFile) => {
            if ((ancestor.label ?? "") !== (descendant.label ?? "")) return false;
            const ancestorPath = fullPathOf(ancestor);
            const descendantPath = fullPathOf(descendant);
            if (ancestorPath === descendantPath) return false;
            return descendantPath.startsWith(`${ancestorPath}/`);
        },
        [],
    );

    const classifyVisualSelection = useCallback(
        (file: FormattedUserFile, ancestorChain: FormattedUserFile[]) => {
            if (isFileSelected(file)) return "direct" as const;
            for (const ancestor of ancestorChain) {
                if (isFileSelected(ancestor) && isDescendant(ancestor, file)) {
                    return "cascade" as const;
                }
            }
            return "none" as const;
        },
        [isFileSelected, isDescendant],
    );

    const isVisuallySelected = useCallback(
        (file: FormattedUserFile, ancestorChain: FormattedUserFile[]) =>
            classifyVisualSelection(file, ancestorChain) !== "none",
        [classifyVisualSelection],
    );

    /**
     * Drop every individually-selected descendant of `folder` from the
     * selection set. The folder itself is left untouched — callers
     * combine this with their own folder add/remove as needed.
     */
    const clearAggregateSelection = useCallback(
        (folder: FormattedUserFile) => {
            removeDescendantsOf(folder);
        },
        [removeDescendantsOf],
    );

    /**
     * Pass-through on desktop. The console rolls per-leaf selections up
     * into folder selections by walking the cached child set; the
     * desktop's inline-expansion tree fetches children lazily into
     * per-component state, so there's no global cache to walk. When the
     * user explicitly checks a folder, `toggleFolderSelection` already
     * stores it as a folder entry and the deletion path forwards that
     * verbatim — so the practical outcome (one folder delete, not N
     * file deletes) matches the console for the common path.
     */
    const computeLogicalSelection = useCallback(
        (_rootFiles: FormattedUserFile[], selected: FormattedUserFile[]) => selected,
        [],
    );

    return {
        isVisuallySelected,
        classifyVisualSelection,
        clearAggregateSelection,
        computeLogicalSelection,
    };
}

export { fullPathOf };
