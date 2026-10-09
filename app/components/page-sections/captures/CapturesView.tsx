"use client";

import { useEffect, useMemo } from "react";
import { useSetAtom } from "jotai";
import { Camera, HardDrive } from "lucide-react";

import PageHeader from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import CaptureButtons from "@/app/components/capture/CaptureButtons";
import DriveContainer from "@/app/components/page-sections/drive/DriveContainer";
import { DriveRouteContext, type DriveRoute } from "@/app/components/page-sections/drive/driveRoute";
import { useCaptureDriveStatus } from "@/app/lib/hooks/useCaptureDriveStatus";
import { captureDialogAtom } from "@/app/lib/capture/captureFlow";
import { CAPTURES_ROUTE } from "@/app/lib/routes";
import { fileDetailsPanelAtom } from "@/app/lib/global-atoms/fileDetailsAtoms";
import { activeSubMenuItemAtom } from "@/app/components/sidebar/sideBarAtoms";
import { cn } from "@/lib/utils";

const CARD = cn(
  "overflow-hidden rounded-[8px]",
  "bg-grey-light-300 border border-grey-dark-100",
  "shadow-[0px_1px_1.1px_0px_rgba(0,0,0,0.04)]",
  "dark:bg-black-primary-bg dark:border-black-300",
  "dark:shadow-[0px_1px_1.1px_0px_rgba(0,0,0,0.4)]",
);

const NOTE = cn(
  "flex flex-wrap items-start gap-3 rounded-[8px] border px-4 py-3 text-sm",
  "border-grey-dark-100 bg-white text-grey-40 dark:border-black-300 dark:bg-black-600 dark:text-grey-dark-600",
);

const SUBTITLE = "Your screenshots and recordings, in a drive of their own.";

/**
 * The sidebar's Captures: the captures drive, shown by the Drive page's own
 * container pinned to it (`DriveRouteContext`), so it pages, searches,
 * filters, switches between list and cards and offers every row action the
 * way any drive does. Before the drive exists (nobody has said where captures
 * go, or the chosen folder could not be added yet) it says what happens and
 * offers to set it up. Which state applies is Rust's (`capture_drive_status`).
 */
export default function CapturesView() {
  const { data: status, isLoading, isError, refetch } = useCaptureDriveStatus();
  const setActiveSubMenuItem = useSetAtom(activeSubMenuItemAtom);
  const setFileDetails = useSetAtom(fileDetailsPanelAtom);
  const setDialog = useSetAtom(captureDialogAtom);

  useEffect(() => {
    setActiveSubMenuItem("");
    // A file's details belong to the page they were opened on.
    return () => setFileDetails(null);
  }, [setActiveSubMenuItem, setFileDetails]);

  const label = status?.state === "ready" ? status.label : null;
  const remote = status?.state === "ready" ? status.remote : false;
  const route = useMemo<DriveRoute | null>(
    () =>
      label
        ? {
            basePath: CAPTURES_ROUTE,
            pinned: { label, remote },
            emptyState: <CapturesEmptyState />,
          }
        : null,
    [label, remote],
  );

  const openSetup = () => setDialog({ kind: "captureDrive" });

  return (
    <>
      <PageHeader
        title="Captures"
        subtitle={SUBTITLE}
        hideStats
        className="!shadow-none"
        // In the drive, Screenshot and Record sit in its own toolbar, as on
        // every drive; before it exists they are here and in the card.
        actions={route ? null : <CaptureButtons />}
      />
      {route ? (
        // Keyed on the drive: a moved captures drive is a different drive,
        // opened fresh rather than over the old one's view.
        <DriveRouteContext.Provider value={route}>
          <DriveContainer key={`${route.pinned?.label}:${route.pinned?.remote}`} />
        </DriveRouteContext.Provider>
      ) : (
        <div className="flex flex-col gap-3 px-3 pb-10">
          {status?.state === "pending" && (
            <div role="status" className={NOTE}>
              <HardDrive
                aria-hidden
                className="mt-0.5 size-[18px] shrink-0 text-primary-50 dark:text-primary-brand-dark"
                strokeWidth={2}
              />
              <p className="min-w-0 flex-1 basis-60">{status.message}</p>
              <Button variant="defaultStable" size="sm" onClick={openSetup}>
                Try again
              </Button>
            </div>
          )}
          {status?.state === "needsSetup" && status.waiting > 0 && (
            <div role="status" className={NOTE}>
              <HardDrive
                aria-hidden
                className="mt-0.5 size-[18px] shrink-0 text-primary-50 dark:text-primary-brand-dark"
                strokeWidth={2}
              />
              <p className="min-w-0 flex-1 basis-60">
                {status.waiting === 1
                  ? "1 capture is kept on this computer until you set up your Captures folder."
                  : `${status.waiting} captures are kept on this computer until you set up your Captures folder.`}
              </p>
            </div>
          )}
          <div className={CARD}>
            {isLoading ? (
              <div data-testid="captures-loading" className="flex flex-col items-center gap-3 px-4 py-16">
                <span className="size-12 animate-pulse rounded-full bg-grey-light-200 motion-reduce:animate-none dark:bg-black-500" />
                <span className="h-4 w-40 animate-pulse rounded bg-grey-light-200 motion-reduce:animate-none dark:bg-black-500" />
              </div>
            ) : isError ? (
              <div className="flex flex-col items-center px-4 py-12 text-center">
                <p className="text-sm font-medium text-grey-10 dark:text-white">
                  Couldn&apos;t load your captures right now.
                </p>
                <button
                  type="button"
                  className="mt-4 text-sm font-medium text-primary-50 hover:text-primary-40 dark:text-primary-brand-dark"
                  onClick={() => void refetch()}
                >
                  Try again
                </button>
              </div>
            ) : (
              <CapturesEmptyState
                place={status?.state === "needsSetup" ? status.suggested.place : undefined}
                onSetUp={status?.state === "needsSetup" ? openSetup : undefined}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * No captures yet: what a capture is here, and the buttons that take one.
 * Before the captures drive exists it also says where it will go and offers
 * to set it up now.
 */
export function CapturesEmptyState({ place, onSetUp }: { place?: string; onSetUp?: () => void }) {
  return (
    <div data-testid="captures-empty" className="flex flex-col items-center px-4 py-12 text-center sm:py-16">
      <span className="flex size-12 items-center justify-center rounded-full bg-primary-50/10 text-primary-50 dark:bg-primary-brand-dark/15 dark:text-primary-brand-dark">
        <Camera className="size-6" strokeWidth={1.75} />
      </span>
      <h2 className="mt-4 text-base font-medium text-grey-10 dark:text-white">No captures yet</h2>
      <p className="mt-1 max-w-md text-sm text-grey-50 dark:text-grey-dark-600">
        {onSetUp
          ? `Take a screenshot or record your screen. The first time, Hippius makes a folder for your captures${
              place ? ` (${place})` : ""
            }, backs it up as a drive of its own, and copies a link you can paste anywhere.`
          : "Take a screenshot or record your screen. It lands here and a link you can paste anywhere is copied."}
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <CaptureButtons />
      </div>
      {onSetUp && (
        <button
          type="button"
          onClick={onSetUp}
          className="mt-4 text-sm font-medium text-primary-50 underline-offset-2 hover:underline dark:text-primary-brand-dark"
        >
          Set up the folder now
        </button>
      )}
    </div>
  );
}
