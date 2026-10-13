// Typed wrappers around the share link insights commands
// (`src-tauri/src/shares/insights.rs`): the owner's Insights for a link, its
// comments, its Insights / Comments / Reactions switches, and the share-link
// email preferences. Rust decides everything here, including what a free
// plan may see; these types only describe what crosses IPC.

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
}

/**
 * A metric the plan may lock. A locked one carries NO value: the server
 * never sends it and Rust drops it if it did, so a locked card can only
 * ever be drawn from sample numbers.
 */
export type Gated<T> = { state: "locked" } | { state: "shown"; value: T };

export interface InsightsViewer {
  viewerId: string;
  /** The name they chose when they commented; `null` shows "Someone". */
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
  /** `null` shows "Someone". */
  name: string | null;
  atMs: number | null;
  createdAt: string;
}

export interface ShareComments {
  comments: ShareComment[];
  /** Rust's sentence for why none can be read here, or `null`. */
  unreadable: string | null;
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
