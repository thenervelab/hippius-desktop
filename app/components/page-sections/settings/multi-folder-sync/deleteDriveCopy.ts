// The words of "Delete from Hippius" on a whole drive. Hippius Trash takes
// files and folders inside a drive, never a drive itself, so while the
// server has Trash the dialog says plainly that this one skips it. With
// Trash off the words are today's, unchanged. The share links point is not
// part of this sentence: the dialog shows it in its own notice card, with a
// link to Shared Links, so the two facts read apart.

export interface DeleteDriveCopy {
  title: string;
  /** Before the drive's name. */
  lead: string;
  /** After the drive's name. */
  tail: string;
  button: string;
}

export function deleteDriveCopy(trashEnabled: boolean): DeleteDriveCopy {
  if (trashEnabled) {
    return {
      title: "Delete Drive Forever",
      lead: "Every file in ",
      tail: " is deleted for good. Drives don't go to Trash.",
      button: "Delete Forever",
    };
  }
  return {
    title: "Delete Folder from Server",
    lead: "This will permanently delete all files for ",
    tail: " from the server. This action cannot be undone.",
    button: "Delete Permanently",
  };
}

/** The notice card's line: a drive's share links outlive it until turned off. */
export const DELETE_DRIVE_LINKS_NOTE = "Share links to its files keep working.";
/** The notice card's link, to the page where those links are turned off. */
export const DELETE_DRIVE_LINKS_ACTION = "Open Shared Links";
