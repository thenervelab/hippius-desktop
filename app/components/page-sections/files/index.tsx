"use client";

import React from "react";
import DashboardTitleWrapper from "@/app/components/dashboard-title-wrapper";
import FilesContainer from "./FilesContainer";
import { HelpCircle } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

const FILES_DOCS_URL = "https://docs.hippius.com/use/desktop/file-system";

export default function Files() {
  return (
    <>
      <DashboardTitleWrapper
        mainText="Your Files"
        subText="All uploaded files are private and securely encrypted."
        infoTooltip={
          <button
            onClick={() => openUrl(FILES_DOCS_URL)}
            aria-label="Files documentation"
            title="Files documentation"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-grey-80 bg-grey-100 text-grey-50 transition-colors hover:bg-grey-90 hover:text-primary-50"
          >
            <HelpCircle className="size-4" />
          </button>
        }
      >
        <FilesContainer />
      </DashboardTitleWrapper>
    </>
  );
}
