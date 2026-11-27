// What the folder link Insights panel is about, the atom that opens it, the
// capability that offers it and its query keys. Kept apart from the panel so
// Shared Links can open it without importing it.

import { atom } from "jotai";

import { serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { folderInsightsPanelTargetAtom } from "@/app/lib/global-atoms/sidePanelAtoms";

/** A folder link, as Shared Links lists it. */
export interface FolderInsightsTarget {
  /** The listing's `token_hash`: every row has one, wherever it was minted. */
  tokenHash: string;
  /** The folder's name, as the link shows it. */
  name: string;
  createdAt: string;
  expiresAt: string | null;
  revoked: boolean;
  /**
   * Off while its folder is in Trash, as the server's listing says
   * (`isFolderLinkPaused`); absent from a target built before it was known.
   */
  paused?: boolean;
  /** Off until the owner revokes it: its folder left Trash another way. */
  held?: boolean;
  /** The link's switch from the listing; `null` when the server does not say. */
  insightsOn: boolean | null;
}

/** Opening it closes File Details, Insights and Manage access (`sidePanelAtoms`). */
export const folderInsightsAtom = folderInsightsPanelTargetAtom;

/** Whether the server has Insights for folder links (`folder_share_insights`). */
export const folderShareInsightsEnabledAtom = atom(
  (get) => get(serverCapabilitiesAtom)?.share_insights === true && get(serverCapabilitiesAtom)?.folder_share_insights === true,
);

export const folderInsightsQueryKey = (tokenHash: string) => ["folder-share-insights", tokenHash] as const;
/** The Shared Links table's per-link activity (`share_link_activity`). */
export const LINK_ACTIVITY_QUERY_KEY = "share-link-activity";
