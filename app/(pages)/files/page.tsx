"use client";

import { Drive } from "@/components/page-sections";
import { FC } from "react";
import PageHeader from "@/components/ui/page-header";

import { openUrl } from "@tauri-apps/plugin-opener";
import { InfoCircle } from "@/app/components/ui/icons";

const DRIVE_DOCS_URL = "https://docs.hippius.com/use/desktop/file-system";

const FilesPage: FC = () => {
  // Nested folder browsing used to live on a separate route (FolderView).
  // It now folds back into DriveContainer, which reads the URL params
  // (folderName, subFolderPath, folderSource…) itself and renders the
  // breadcrumb-based view in-place. The page wrapper stays the same in
  // both the root and nested cases.
  return (
    <>
      <PageHeader
        hideStats={true}
        infoTooltip={
          <button
            onClick={() => openUrl(DRIVE_DOCS_URL)}
            aria-label="Drive documentation"
            title="Drive documentation"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-grey-dark-100 bg-grey-light-700 text-black transition-colors hover:bg-grey-90 hover:text-primary-50"
          >
            <InfoCircle className="size-4" />
          </button>
        }
        title="Your Files"
        className="!shadow-none"
        subtitle="All uploaded files are private and securely encrypted."
      />
      <Drive />
    </>
  );
};

export default FilesPage;
