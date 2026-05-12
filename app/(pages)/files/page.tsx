"use client";

import DashboardTitleWrapper from "@/app/components/dashboard-title-wrapper";
import FolderView from "@/app/components/page-sections/files-folder";
import { Drive } from "@/components/page-sections";
import { FC } from "react";
import { useUrlParams } from "@/app/utils/hooks/useUrlParams";
import PageHeader from "@/components/ui/page-header";

import { openUrl } from "@tauri-apps/plugin-opener";
import { InfoCircle } from "@/app/components/ui/icons";

const DRIVE_DOCS_URL = "https://docs.hippius.com/use/desktop/file-system";
const FilesPage: FC = () => {
  const { getParam } = useUrlParams();

  const folderCid = getParam("folderCid");
  const folderName = getParam("folderName", "");
  const folderActualName = getParam("folderActualName", "");
  const mainFolderActualName = getParam("mainFolderActualName", "");
  const subFolderPath = getParam("subFolderPath");

  if (folderName) {
    return (
      <DashboardTitleWrapper mainText={`My Drive - ${folderName}`}>
        <FolderView
          folderCid={folderCid}
          folderName={folderName}
          folderActualName={folderActualName}
          mainFolderActualName={mainFolderActualName}
          subFolderPath={subFolderPath}
        />
      </DashboardTitleWrapper>
    );
  }
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
