import React, { useState, useEffect, useMemo } from "react";
import { isVersionGreaterOrEqual } from "@/lib/utils/versionCompare";
import { CardButton, Icons } from "@/components/ui";
import { IconComponent } from "@/app/lib/types";
import NotificationType from "./NotificationType";
import { handleButtonLink } from "@/app/lib/utils/links";
import { MoreVertical, ArrowUpCircle, ArrowDownCircle, Trash2 } from "lucide-react";
import TimeAgo from "react-timeago";
import NotificationContextMenu from "./NotificationContextMenu";
import RevealTextLine from "@/components/ui/reveal-text-line";
import { InView } from "react-intersection-observer";
import { useRouter } from "next/navigation";
import BasicMarkdown from "@/components/updater/BasicMarkdown";
import { getVersion } from "@tauri-apps/api/app";
import {
  cn,
  getFilePartsFromFileName,
  getFileTypeFromExtension,
} from "@/lib/utils";
import { getFileIcon, formatDisplayName } from "@/lib/utils/fileTypeUtils";
import { formatBytes } from "@/lib/utils/formatBytes";
import type { SyncedFileDetail } from "@/lib/hooks/useFilesNotification";

/** Parse file details JSON from releaseNotes for Files-type notifications. */
export function parseFileDetails(type: string, releaseNotes: string): SyncedFileDetail[] {
  if (type !== "Files" || !releaseNotes) return [];
  try {
    const parsed = JSON.parse(releaseNotes);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Not JSON — fall through
  }
  return [];
}

interface NotificationDetailViewProps {
  selectedNotification: {
    id?: number;
    icon: IconComponent;
    type: string;
    subType?: string;
    title: string;
    description: string;
    releaseNotes?: string;
    time: string | number;
    timestamp?: number;
    actionText?: string;
    actionLink?: string;
    unread?: boolean;
  } | null;
  onReadStatusChange?: (id: number, isUnread: boolean) => void;
}


const NotificationDetailView: React.FC<NotificationDetailViewProps> = ({
  selectedNotification,
  onReadStatusChange,
}) => {
  const router = useRouter();
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string>("");

  useEffect(() => {
    getVersion()
      .then(setCurrentVersion)
      .catch((err: unknown) => console.warn("[NotificationDetailView] Failed to get app version:", err));
  }, []);

  // Group file details by action for summary counts — must be before early return
  const fileSummary = useMemo(() => {
    if (!selectedNotification) return null;
    const releaseNotesText = selectedNotification.releaseNotes?.trim() ?? "";
    const fileDetails = parseFileDetails(selectedNotification.type, releaseNotesText);
    if (selectedNotification.type !== "Files" || fileDetails.length === 0) return null;
    const uploaded = fileDetails.filter((f) => f.action === "upload");
    const downloaded = fileDetails.filter((f) => f.action === "download");
    const deleted = fileDetails.filter(
      (f) => f.action === "local_delete" || f.action === "remote_delete"
    );
    return { uploaded, downloaded, deleted };
  }, [selectedNotification]);

  if (!selectedNotification) {
    return <div className="w-full" style={{ height: 'calc(100vh - 12rem)' }}></div>;
  }

  const {
    id,
    icon: Icon,
    type,
    subType,
    title,
    description,
    releaseNotes,
    time,
    timestamp,
    actionText,
    actionLink,
    unread = false,
  } = selectedNotification;

  // For Hippius update notifications, hide button if already on this version or newer
  const isUpdateNotification =
    type === "Hippius" && subType && actionLink === "Install Update";
  const isUpdateAlreadyInstalled =
    isUpdateNotification &&
    currentVersion &&
    isVersionGreaterOrEqual(currentVersion, subType);
  const shouldShowButton = actionText && !isUpdateAlreadyInstalled;

  const releaseNotesText = releaseNotes?.trim() ?? "";
  const hasReleaseNotes = releaseNotesText.length > 0;

  // Parse file details from releaseNotes for Files-type notifications
  const fileDetails = parseFileDetails(type, releaseNotesText);

  const isFilesNotification = type === "Files" && fileDetails.length > 0;
  const hasRegularReleaseNotes = hasReleaseNotes && !isFilesNotification;
  const descriptionText = hasRegularReleaseNotes
    ? `${description}${description.endsWith(".") ? "" : "."} See what's new below.`
    : description;

  const handleMoreClick = (e: React.MouseEvent) => {
    e.preventDefault();
    const button = e.currentTarget;
    const rect = button.getBoundingClientRect();
    setContextMenu({
      x: rect.left,
      y: rect.bottom,
    });
  };

  const handleReadStatusToggle = () => {
    if (id && onReadStatusChange) {
      onReadStatusChange(id, !unread);
    }
  };

  const handleLinkClick = (e: React.MouseEvent) => {
    handleButtonLink(e, actionLink, router);
  };

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className="w-full flex gap-3 border border-grey-80 rounded p-4" style={{ height: 'calc(100vh - 12rem)' }}
        >
          <div className="min-w-[2rem] size-8 flex items-center justify-center rounded-lg bg-primary-95 flex-shrink-0">
            <Icon className="text-primary-40 size-5" />
          </div>
          <div className="flex flex-col min-h-0 flex-1 min-w-0">
            {/* Type badge */}
            <RevealTextLine rotate reveal={inView} className="delay-200">
              <NotificationType type={type} />
            </RevealTextLine>

            {/* Title */}
            <RevealTextLine rotate reveal={inView} className="delay-300">
              <h2 className="text-[1.375rem] leading-8 font-semibold text-grey-10 mt-[0.1875rem] mb-[0.4375rem]">
                {title}
              </h2>
            </RevealTextLine>

            {/* Description */}
            <RevealTextLine rotate reveal={inView} className="delay-400">
              <p className="text-sm text-grey-30 font-medium leading-5 mb-[0.4375rem] break-all">
                {descriptionText}
              </p>
            </RevealTextLine>

            {/* File details for sync notifications */}
            {isFilesNotification && fileSummary && (
              <div className="mt-2 mb-3">
                {/* Summary counters */}
                <div className="flex items-center gap-3 mb-3">
                  {fileSummary.uploaded.length > 0 && (
                    <div className="flex items-center gap-1.5 px-2.5 py-1 bg-primary-95 border border-primary-80 rounded-full">
                      <ArrowUpCircle className="size-3.5 text-primary-50" />
                      <span className="text-xs font-medium text-primary-40">
                        {fileSummary.uploaded.length} uploaded
                      </span>
                    </div>
                  )}
                  {fileSummary.downloaded.length > 0 && (
                    <div className="flex items-center gap-1.5 px-2.5 py-1 bg-success-90 border border-success-70 rounded-full">
                      <ArrowDownCircle className="size-3.5 text-success-50" />
                      <span className="text-xs font-medium text-success-40">
                        {fileSummary.downloaded.length} downloaded
                      </span>
                    </div>
                  )}
                  {fileSummary.deleted.length > 0 && (
                    <div className="flex items-center gap-1.5 px-2.5 py-1 bg-error-90 border border-error-70 rounded-full">
                      <Trash2 className="size-3.5 text-error-50" />
                      <span className="text-xs font-medium text-error-40">
                        {fileSummary.deleted.length} deleted
                      </span>
                    </div>
                  )}
                </div>

                {/* File list */}
                <div className="max-h-[17.5rem] overflow-y-auto rounded-lg border border-grey-80 divide-y divide-grey-90">
                  {fileDetails.map((file, index) => {
                    const { fileFormat } = getFilePartsFromFileName(file.fileName);
                    const fileType = getFileTypeFromExtension(fileFormat || null);
                    const { icon: FileIcon, color } = getFileIcon(fileType ? fileType : undefined, false);
                    const isDeleted = file.action === "local_delete" || file.action === "remote_delete";
                    const isUpload = file.action === "upload";
                    return (
                      <div
                        key={`${file.fileName}-${index}`}
                        className="flex items-center gap-3 px-3 py-2.5 bg-white hover:bg-grey-98 transition-colors"
                      >
                        {/* File icon */}
                        <div className="size-8 flex-shrink-0 flex items-center justify-center rounded-lg bg-grey-95">
                          <FileIcon className={cn("size-5", color)} />
                        </div>

                        {/* File name + size */}
                        <div className="flex flex-col justify-center min-w-0 flex-1">
                          <span className="text-sm font-medium text-grey-10 truncate" title={file.fileName}>
                            {formatDisplayName(file.fileName)}
                          </span>
                          {file.totalBytes > 0 && (
                            <span className="text-xs text-grey-60">
                              {formatBytes(file.totalBytes)}
                            </span>
                          )}
                        </div>

                        {/* Action badge */}
                        <div className="flex-shrink-0">
                          {isDeleted ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-error-90 text-error-50">
                              <Trash2 className="size-3" />
                              Deleted
                            </span>
                          ) : isUpload ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-primary-95 text-primary-50">
                              <ArrowUpCircle className="size-3" />
                              Uploaded
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-success-90 text-success-50">
                              <ArrowDownCircle className="size-3" />
                              Downloaded
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {hasRegularReleaseNotes && (
              <div className="mt-2 mb-2">
                <div className="flex items-center gap-2 text-grey-50">
                  <Icons.Note2 className="size-5" />
                  <span className="text-base font-bold">Release Notes</span>
                </div>
                <div className=" max-h-[17.5rem] overflow-y-auto pr-2">
                  <BasicMarkdown text={releaseNotesText} />
                </div>
              </div>
            )}
            {/* Time */}
            <RevealTextLine rotate reveal={inView} className="delay-500">
              <span className="text-xs text-grey-60 leading-[1.125rem] mb-[0.4375rem]">
                {timestamp ? <TimeAgo date={timestamp} /> : time}
              </span>
            </RevealTextLine>

            {/* Action button */}
            {shouldShowButton && (
              <CardButton
                className="max-w-[9.5rem] h-10"
                onClick={handleLinkClick}
              >
                <span className="flex items-center text-lg font-medium">
                  {actionText}
                </span>
              </CardButton>
            )}
          </div>
          <button
            className="text-grey-70 p-2 hover:bg-primary-100 rounded self-start ml-auto"
            onClick={handleMoreClick}
            onContextMenu={(e) => {
              e.preventDefault();
              handleMoreClick(e);
            }}
          >
            <MoreVertical className="size-4" />
          </button>

          {/* Context Menu */}
          {contextMenu && (
            <NotificationContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              isUnread={unread}
              onClose={() => setContextMenu(null)}
              onToggleReadStatus={handleReadStatusToggle}
              notificationId={id}
              onArchived={() => {
                setContextMenu(null);
              }}
              onArchiveStart={() => {}}
            />
          )}
        </div>
      )}
    </InView>
  );
};

export default NotificationDetailView;
