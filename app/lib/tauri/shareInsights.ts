// Typed wrappers around the share link insights commands
// (`src-tauri/src/shares/insights.rs`): the owner's Insights for a link, its
// comments (delete, block), its reaction totals, its Insights / Comments /
// Reactions switches, and the share-link email preferences. Rust decides
// everything here, including what a free plan may see; these types only
// describe what crosses IPC.

import { invoke } from "@tauri-apps/api/core";

/** A link's three switches. */
export interface LinkSettings {
  insights: boolean;
  comments: boolean;
  reactions: boolean;
}

/** Which switches this server takes, so which ones are shown. */
export type OfferedSwitches = LinkSettings;

/** Where the share dialog's switches start, and which it shows. */
export interface LinkSettingsDefault {
  offered: OfferedSwitches;
  on: LinkSettings;
  /**
   * Whether the plan includes Insights: `false` on the free plan, where the
   * Insights switch leads to the upgrade prompt; `null` when Rust could not
   * read the plan (nothing is locked, and a new link starts Insights off).
   */
  insightsInPlan: boolean | null;
}

/**
 * A metric the plan may lock. A locked one carries NO value: the server
 * never sends it and Rust drops it if it did, so a locked card can only
 * ever be drawn from sample numbers.
 */
export type Gated<T> = { state: "locked" } | { state: "shown"; value: T };

export interface InsightsViewer {
  viewerId: string;
  /** The name they chose when they commented; `null` shows "Anonymous viewer". */
  name: string | null;
  visits: number;
  watchedMs: number;
  /** 0 to 1, `null` for a picture. */
  completion: number | null;
  lastViewedAt: string | null;
  comments: number;
  reactions: number;
}

export interface ShareInsights {
  plan: "free" | "paid";
  totalViews: number;
  uniqueViewers: number;
  /** 0 to 1; `null` inside when there is nothing to measure yet. */
  completion: Gated<number | null>;
  /** 100 buckets of 0 to 100; `null` inside when there is no video data. */
  retention: Gated<number[] | null>;
  viewers: Gated<InsightsViewer[]>;
}

export interface ShareComment {
  id: string;
  /** `null` when this comment could not be read. */
  text: string | null;
  /** `null` shows "Anonymous viewer". */
  name: string | null;
  atMs: number | null;
  createdAt: string;
  /**
   * Replies under it, oldest first. Only once the server has replies
   * (`share_comment_replies`, hcfs #804); Rust sends none yet, and the sheet
   * draws none without the capability.
   */
  replies?: ShareCommentReply[];
}

/** A reply under a comment, the owner's own marked so (hcfs #804). */
export interface ShareCommentReply {
  id: string;
  text: string | null;
  name: string | null;
  createdAt: string;
  byOwner: boolean;
}

export interface ShareComments {
  comments: ShareComment[];
  /** Rust's sentence for why none can be read here, or `null`. */
  unreadable: string | null;
}

/** How many people chose one emoji. */
export interface ReactionCount {
  emoji: string;
  count: number;
}

/** A link's reaction totals: only the emoji somebody chose, in the share page's order. */
export interface ShareReactions {
  counts: ReactionCount[];
  total: number;
}

/** Which of the new share-link features the server has. */
export interface EngagementFeatures {
  insights: boolean;
  comments: boolean;
  notifications: boolean;
}

export type Digest = "off" | "daily" | "weekly";

export interface NotificationPreferences {
  firstViews: boolean;
  comments: boolean;
  digest: Digest;
}

export function getShareInsights(shareToken: string): Promise<ShareInsights> {
  return invoke<ShareInsights>("share_get_insights", { shareToken });
}

export function listShareComments(shareToken: string): Promise<ShareComments> {
  return invoke<ShareComments>("share_list_comments", { shareToken });
}

export function deleteShareComment(shareToken: string, commentId: string): Promise<void> {
  return invoke<void>("share_delete_comment", { shareToken, commentId });
}

/**
 * Block the author of a comment from commenting and reacting on this link.
 * Their comments stay; the server never says who they are, and lists no
 * block state, so only the sheet that blocked them knows.
 */
export function blockShareCommenter(shareToken: string, commentId: string): Promise<void> {
  return invoke<void>("share_block_commenter", { shareToken, commentId });
}

/** Undo a block, through any comment of the same author still on the link. */
export function unblockShareCommenter(shareToken: string, commentId: string): Promise<void> {
  return invoke<void>("share_unblock_commenter", { shareToken, commentId });
}

export function getShareReactions(shareToken: string): Promise<ShareReactions> {
  return invoke<ShareReactions>("share_get_reactions", { shareToken });
}

/** A link's switches as they stand, and which this server takes. */
export function getLinkSettings(shareToken: string): Promise<LinkSettingsDefault> {
  return invoke<LinkSettingsDefault>("share_get_link_settings", { shareToken });
}

export function setLinkSettings(shareToken: string, settings: LinkSettings): Promise<void> {
  return invoke<void>("share_set_link_settings", { shareToken, settings });
}

export function getLinkSettingsDefault(
  folderLabel: string | null,
  fileName: string,
  isFolder: boolean,
): Promise<LinkSettingsDefault> {
  return invoke<LinkSettingsDefault>("share_link_settings_default", {
    folderLabel,
    fileName,
    isFolder,
  });
}

export function getEngagementFeatures(): Promise<EngagementFeatures> {
  return invoke<EngagementFeatures>("share_engagement_features");
}

export function getNotificationPreferences(): Promise<NotificationPreferences> {
  return invoke<NotificationPreferences>("share_get_notification_preferences");
}

export function setNotificationPreferences(preferences: NotificationPreferences): Promise<void> {
  return invoke<void>("share_set_notification_preferences", { preferences });
}

/** The capture card's Insights: Rust brings this window forward with it. */
export const CAPTURE_OPEN_INSIGHTS_EVENT = "capture_open_insights";

export interface CaptureOpenInsights {
  shareToken: string;
  fileName: string;
}
