"use client";

import React from "react";

import NoEntriesFound from "@/components/ui/NoEntriesFound";

import { SYNC_FOLDER_LABEL } from "../uploadActions";

/**
 * What the folder list shows before there is a single folder.
 *
 * The list rendered an empty card instead — a heading, a button in the
 * corner, and a blank panel under it — which says nothing about what the
 * page is for or what to do first. This is the whole of the Drive page on
 * a new account, so it is also the app's first impression.
 *
 * Syncing a folder is the only offer here. Uploading needs somewhere to
 * upload TO, so on an account with no folders at all it would open a
 * picker with nothing in it.
 */
const FolderListEmptyState: React.FC<{ onSyncFolder: () => void }> = ({
  onSyncFolder,
}) => (
  <NoEntriesFound
    title="No folders yet"
    description="Pick a folder on this computer to sync. Its files are encrypted here before they upload, and stay up to date on every device you sign in to."
    buttonText={SYNC_FOLDER_LABEL}
    onButtonClick={onSyncFolder}
    // The list card already draws the border and the surface; a second
    // one around this would read as a panel inside a panel.
    cardView={false}
    className="bg-transparent p-0 dark:bg-transparent"
  />
);

export default FolderListEmptyState;
