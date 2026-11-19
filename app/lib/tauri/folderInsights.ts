// Typed wrappers around a folder link's Insights
// (`src-tauri/src/shares/folder_insights.rs`) and the Shared Links table's
// per-link activity (`src-tauri/src/shares/link_activity.rs`). Rust decides
// everything, including what a free plan may see and the order of every
// list; these types only describe what crosses IPC.

import { invoke } from "@tauri-apps/api/core";

import type { Gated, InsightsPages } from "@/app/lib/tauri/shareInsights";

/** One viewer of one file of a folder link. */
export interface FolderViewer {
  viewerId: string;
  /** "Viewer 3fa9": folder links carry no names. */
  label: string;
  visits: number;
  lastViewedAt: string | null;
  /** For a video, 0 to 1. */
  completion: number | null;
  pagesSeen: number | null;
  pageCount: number | null;
  /** Time on the document's pages over this viewer's visits. */
  pageTimeMs: number | null;
}

/** One file of the folder that was opened. */
export interface FolderFile {
  path: string;
  name: string;
  /** The folder it sits in, `""` at the link's top. */
  folder: string;
  totalViews: number;
  uniqueViewers: number;
  /** For a document, the share of visits that read to its end, 0 to 1. */
  read: number | null;
  timeMs: number | null;
  /** Only for a viewed document of more than one page, on a plan that shows it. */
  pages: InsightsPages | null;
  viewers: Gated<FolderViewer[]>;
}

export interface RoomFile {
  path: string;
  name: string;
  visits: number;
  lastViewedAt: string | null;
  pagesSeen: number | null;
  pageCount: number | null;
  pageTimeMs: number | null;
}

/** One person across the folder, with the files they opened. */
export interface RoomPerson {
  viewerId: string;
  label: string;
  visits: number;
  lastViewedAt: string | null;
  pageTimeMs: number | null;
  files: RoomFile[];
}

export interface FolderInsights {
  plan: "free" | "paid";
  totalViews: number;
  uniqueViewers: number;
  /** Most viewed first. */
  files: FolderFile[];
  /** Most recent first; locked on a plan without the viewer list. */
  people: Gated<RoomPerson[]>;
}

/** What turning a folder link's Insights on or off did. */
export type FolderSwitchOutcome = { outcome: "saved"; insights: boolean } | { outcome: "needsPaidPlan" };

export async function getFolderInsights(tokenHash: string): Promise<FolderInsights> {
  return invoke<FolderInsights>("folder_share_get_insights", { tokenHash });
}

export async function setFolderInsights(tokenHash: string, on: boolean): Promise<FolderSwitchOutcome> {
  return invoke<FolderSwitchOutcome>("folder_share_set_insights", { tokenHash, on });
}

/** "Board room activity 2026-11-18.csv", the name the save dialog suggests. */
export async function folderInsightsCsvName(folderName: string): Promise<string> {
  return invoke<string>("folder_share_insights_csv_name", { folderName });
}

/** Rust reads the link's activity again, builds the CSV and writes it at `destination`. */
export async function exportFolderInsightsCsv(tokenHash: string, folderName: string, destination: string): Promise<void> {
  await invoke<void>("folder_share_export_insights_csv", { tokenHash, folderName, destination });
}

/** A file link's numbers from the owner listing. */
export interface LinkCounts {
  views: number;
  uniqueViewers: number;
  comments: number;
  newSinceSeen: boolean;
}

export interface FileLinkActivity {
  shareToken: string;
  insightsOn: boolean | null;
  counts: LinkCounts | null;
}

export interface FolderLinkActivity {
  tokenHash: string;
  insightsOn: boolean | null;
}

export interface LinkActivity {
  files: FileLinkActivity[];
  folders: FolderLinkActivity[];
}

/** Views, comments and Insights switches for the Shared Links table. */
export async function getLinkActivity(): Promise<LinkActivity> {
  return invoke<LinkActivity>("share_link_activity");
}
