"use client";

import React from "react";
import SyncStatusHandler from "./SyncStatusHandler";
import { createPortal } from "react-dom";

/**
 * Renders the sync status dialog in a portal at the bottom-right of the screen.
 * The pinning queue has been removed — only the sync status widget is shown.
 */
const UnpinnedFilesHandler: React.FC = () => {
  return (
    <>
      {createPortal(
        <div className="fixed z-[10] right-6 bottom-20 sm:bottom-7 pointer-events-none">
          <div className="flex flex-col gap-4 items-end pointer-events-auto">
            <SyncStatusHandler />
          </div>
        </div>,
        document.body
      )}
    </>
  );
};

export default UnpinnedFilesHandler;
