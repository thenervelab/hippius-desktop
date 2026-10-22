// The right-hand side panels: File Details, Insights and Manage access.
//
// They share one slot beside the page (`ui/SidePanel`), so only one is ever
// open: opening any of them closes the others, rather than stacking two
// panels or a panel over a panel. The rule lives here, once, so every opener
// (row menus, the capture card, Shared Links, keyboard shortcuts) gets it by
// setting its panel's atom as before.

import { atom, type PrimitiveAtom, type SetStateAction, type WritableAtom } from "jotai";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { InsightsSheetTarget, ShareDriveModalTarget } from "@/app/lib/global-atoms/sharesAtoms";

const fileDetailsTarget = atom<FormattedUserFile | null>(null);
const insightsTarget = atom<InsightsSheetTarget | null>(null);
const shareDriveTarget = atom<ShareDriveModalTarget | null>(null);

const PANELS: ReadonlyArray<PrimitiveAtom<unknown>> = [
  fileDetailsTarget as PrimitiveAtom<unknown>,
  insightsTarget as PrimitiveAtom<unknown>,
  shareDriveTarget as PrimitiveAtom<unknown>,
];

type PanelAtom<T> = WritableAtom<T | null, [SetStateAction<T | null>], void>;

/** A panel's atom: reads its target; opening it closes the other panels. */
function exclusive<T>(own: PrimitiveAtom<T | null>): PanelAtom<T> {
  return atom(
    (get) => get(own),
    (get, set, next: SetStateAction<T | null>) => {
      const value = typeof next === "function" ? (next as (prev: T | null) => T | null)(get(own)) : next;
      set(own, value);
      if (value === null) return;
      for (const other of PANELS) {
        if (other !== (own as PrimitiveAtom<unknown>)) set(other, null);
      }
    },
  );
}

export const fileDetailsPanelTargetAtom = exclusive(fileDetailsTarget);
export const insightsPanelTargetAtom = exclusive(insightsTarget);
export const shareDrivePanelTargetAtom = exclusive(shareDriveTarget);
