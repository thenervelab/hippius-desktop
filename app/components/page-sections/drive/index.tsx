"use client";

import React from "react";
import DashboardTitleWrapper from "@/app/components/dashboard-title-wrapper";
import DriveContainer from "./DriveContainer";
import { HelpCircle } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

const DRIVE_DOCS_URL = "https://docs.hippius.com/use/desktop/file-system";

export default function Drive() {
  return (
    <>
      <DashboardTitleWrapper
        mainText="My Drive"
        subText="All uploaded files are private and securely encrypted."
        infoTooltip={
          <button
            onClick={() => openUrl(DRIVE_DOCS_URL)}
            aria-label="Drive documentation"
            title="Drive documentation"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-grey-80 bg-white text-grey-50 transition-colors hover:bg-grey-90 hover:text-primary-50"
          >
            <HelpCircle className="size-4" />
          </button>
        }
      >
        <DriveContainer />
      </DashboardTitleWrapper>
    </>
  );
}
