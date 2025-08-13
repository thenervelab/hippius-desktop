"use client";

import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import HomePage from "@/components/page-sections/home";
// import PublicFolderTest from "@/components/folder-upload-download";
// import { useFilesNotification } from "../lib/hooks/useFilesNotification";
// import WssEndpointTester from "../wssTest";

export default function Home() {
  // const { syncStatus, invokeCount } = useFilesNotification();

  return (
    <DashboardTitleWrapper mainText="">
      {/* <PublicFolderTest /> */}
      {/* TEMPORARY SYNC STATUS DISPLAY - TO BE REMOVED LATER */}
      {/* {syncStatus && (
        <div className="p-3 border-b border-grey-80">
          <h4 className="font-medium mb-1">Sync Status:</h4>
          <div className="text-sm text-gray-600">
            <p>
              Progress: {syncStatus.synced_files} / {syncStatus.total_files}{" "}
              files
            </p>
            <p>Percentage: {syncStatus.percent.toFixed(1)}%</p>
            <p>Status: {syncStatus.in_progress ? "Syncing..." : "Idle"}</p>

            <p>API calls: {invokeCount} times</p>
          </div>
          {syncStatus.in_progress && (
            <div className="w-full bg-grey-80 rounded-full h-2 mt-2">
              <div
                className="bg-blue-500 h-2 rounded-full"
                style={{ width: `${syncStatus.percent}%` }}
              ></div>
            </div>
          )}
        </div>
      )} */}
      {/* END OF TEMPORARY SECTION */}
      <HomePage />
    </DashboardTitleWrapper>
  );
}
