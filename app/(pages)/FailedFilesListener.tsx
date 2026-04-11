"use client";

import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { failedFilesAtom, type FailedFileInfo } from "@/lib/store/syncAtoms";
import { registerTauriListeners } from "@/lib/utils/tauriListeners";

/**
 * Invisible component that listens for the hcfs_files_failed_repeatedly
 * event and populates the failedFilesAtom to trigger the modal.
 */
export default function FailedFilesListener() {
  const setFailedFiles = useSetAtom(failedFilesAtom);

  useEffect(() => {
    const { cleanup } = registerTauriListeners([
      [
        "hcfs_files_failed_repeatedly",
        (event) => {
          const payload = event.payload as { files: FailedFileInfo[] };
          if (payload.files.length > 0) {
            setFailedFiles(payload.files);
          }
        },
      ],
    ]);

    return cleanup;
  }, [setFailedFiles]);

  return null;
}
