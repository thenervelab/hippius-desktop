// Atom for the inline File Details panel mounted on the Files page.
//
// Hoisted out of the per-table local state so the panel can live as a
// sibling of <Drive /> at the page level (inline on 2xl, slide-in dialog
// below 2xl) while every consumer — table rows, card view, context menu,
// keyboard shortcuts — flips a single source of truth.

import { atom } from "jotai";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

/**
 * Selected file for the inline File Details panel. `null` means closed.
 *
 * The snapshot stored here may go stale (e.g. arion hash arrives after the
 * panel opens). DriveContent re-syncs the latest copy from `filteredData`
 * via an effect so the panel keeps showing fresh data without each
 * consumer needing to know about live lookups.
 */
export const fileDetailsPanelAtom = atom<FormattedUserFile | null>(null);
