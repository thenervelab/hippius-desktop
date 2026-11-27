// The words of "Delete from Hippius" on a whole drive. Hippius Trash takes
// files and folders inside a drive, never a drive itself, so while the
// server has Trash the dialog says first, and plainly, that this one skips
// it. With Trash off the words are today's, unchanged.

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
      lead: "Drives don't go to Trash. This deletes every file in ",
      tail: " for good.",
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
