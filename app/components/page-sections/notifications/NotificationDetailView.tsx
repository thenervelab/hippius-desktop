import React, { useState, useEffect, useMemo } from "react";
import { isVersionGreaterOrEqual } from "@/lib/utils/versionCompare";
import { IconComponent } from "@/app/lib/types";
import { handleButtonLink } from "@/app/lib/utils/links";
import { ArrowUpCircle, ArrowDownCircle, Trash2, MoreVertical } from "lucide-react";
import TimeAgo from "react-timeago";
import NotificationContextMenu from "./NotificationContextMenu";
import { InView } from "react-intersection-observer";
import { useRouter } from "next/navigation";
import BasicMarkdown from "@/components/updater/BasicMarkdown";
import { getVersion } from "@tauri-apps/api/app";
import { cn, getFilePartsFromFileName, getFileTypeFromExtension } from "@/lib/utils";
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

// Figma: icon circle background color per type
const ICON_BG: Record<string, string> = {
  Subscription: "#fc7d73",
  Balance:      "#fc7d73",
  Credits:      "#fc7d73",
  Files:        "#3067dd",
  Hippius:      "#f8a84b",
  Blockchain:   "#3067dd",
  Storage:      "#3067dd",
};

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
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string>("");

  useEffect(() => {
    getVersion()
      .then(setCurrentVersion)
      .catch((err: unknown) =>
        console.warn("[NotificationDetailView] Failed to get app version:", err)
      );
  }, []);

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
    return (
      <div className="w-full h-full flex items-center justify-center">
        <p className="text-[14px] font-medium" style={{ color: "#b6b6b6" }}>
          Select a notification to view details
        </p>
      </div>
    );
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

  const isUpdateNotification = type === "Hippius" && subType && actionLink === "Install Update";
  const isUpdateAlreadyInstalled =
    isUpdateNotification && currentVersion && isVersionGreaterOrEqual(currentVersion, subType);
  const shouldShowButton = actionText && !isUpdateAlreadyInstalled;

  const releaseNotesText = releaseNotes?.trim() ?? "";
  const hasReleaseNotes = releaseNotesText.length > 0;
  const fileDetails = parseFileDetails(type, releaseNotesText);
  const isFilesNotification = type === "Files" && fileDetails.length > 0;
  const hasRegularReleaseNotes = hasReleaseNotes && !isFilesNotification;
  const descriptionText = hasRegularReleaseNotes
    ? `${description}${description.endsWith(".") ? "" : "."} See what's new below.`
    : description;

  const iconBg = ICON_BG[type] ?? "#3067dd";

  const handleMoreClick = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    setContextMenu({ x: rect.left, y: rect.bottom });
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
        <div ref={ref} className="flex flex-col h-full overflow-y-auto">
          {/* Header — Figma: padding=12, gap=12, border-b #e3e3e3 */}
          <div
            className="flex items-start gap-3 px-3 py-3 border-b flex-shrink-0"
            style={{ borderColor: "#e3e3e3" }}
          >
            {/* Icon circle — Figma: fill=type-based color, ~106px radius (fully round) */}
            <div
              className="size-9 rounded-full flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: iconBg }}
            >
              <Icon className="size-5 text-white" />
            </div>

            <div className="flex flex-col gap-0.5 flex-1 min-w-0">
              {/* Figma: type name Geist w500 14px lh=18px #0a0a0a */}
              <p className="text-[14px] font-medium truncate" style={{ color: "#0a0a0a" }}>
                {type}
              </p>
              {/* Figma: description preview Geist w500 13px lh=16.9px #0a0a0a */}
              <p className="text-[13px] font-medium truncate" style={{ color: "#0a0a0a" }}>
                {title}
              </p>
            </div>

            {/* Figma: timestamp Geist w500 13px #0a0a0a */}
            <span
              className="text-[13px] font-medium flex-shrink-0"
              style={{ color: "#0a0a0a" }}
            >
              {timestamp ? <TimeAgo date={timestamp} /> : time}
            </span>

            <button
              className="text-[#b6b6b6] hover:text-[#0a0a0a] p-1 rounded transition-colors flex-shrink-0"
              onClick={handleMoreClick}
            >
              <MoreVertical className="size-4" />
            </button>
          </div>

          {/* Body — Figma: padding L/R=24, T/B=9, gap=16 */}
          <div className="px-6 py-[9px] flex flex-col gap-4 flex-1">
            {/* Main body text — Figma: Geist w500 16px lh=20.8px #0a0a0a */}
            <p
              className="text-[16px] font-medium leading-[20.8px] break-words"
              style={{ color: "#0a0a0a" }}
            >
              {descriptionText}
            </p>

            {/* File details for Files-type notifications */}
            {isFilesNotification && fileSummary && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2 flex-wrap">
                  {fileSummary.uploaded.length > 0 && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-[#eef2ff] border border-[#c7d7f8] rounded-full text-xs font-medium text-[#3067dd]">
                      <ArrowUpCircle className="size-3.5" />
                      {fileSummary.uploaded.length} uploaded
                    </span>
                  )}
                  {fileSummary.downloaded.length > 0 && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-[#f0fdf4] border border-[#bbf7d0] rounded-full text-xs font-medium text-[#16a34a]">
                      <ArrowDownCircle className="size-3.5" />
                      {fileSummary.downloaded.length} downloaded
                    </span>
                  )}
                  {fileSummary.deleted.length > 0 && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-[#fef2f2] border border-[#fecaca] rounded-full text-xs font-medium text-[#dc2626]">
                      <Trash2 className="size-3.5" />
                      {fileSummary.deleted.length} deleted
                    </span>
                  )}
                </div>

                <div
                  className="max-h-[17.5rem] overflow-y-auto rounded-lg border divide-y"
                  style={{ borderColor: "#e3e3e3" }}
                >
                  {fileDetails.map((file, index) => {
                    const { fileFormat } = getFilePartsFromFileName(file.fileName);
                    const fileType = getFileTypeFromExtension(fileFormat || null);
                    const { icon: FileIcon, color } = getFileIcon(fileType ?? undefined, false);
                    const isDeleted = file.action === "local_delete" || file.action === "remote_delete";
                    const isUpload = file.action === "upload";
                    return (
                      <div
                        key={`${file.fileName}-${index}`}
                        className="flex items-center gap-3 px-3 py-2.5 bg-white hover:bg-[#f8f8f8] transition-colors"
                      >
                        <div className="size-8 flex-shrink-0 flex items-center justify-center rounded-lg bg-[#f3f3f3]">
                          <FileIcon className={cn("size-5", color)} />
                        </div>
                        <div className="flex flex-col justify-center min-w-0 flex-1">
                          <span className="text-[14px] font-medium truncate" style={{ color: "#0a0a0a" }} title={file.fileName}>
                            {formatDisplayName(file.fileName)}
                          </span>
                          {file.totalBytes > 0 && (
                            <span className="text-[12px]" style={{ color: "#b6b6b6" }}>
                              {formatBytes(file.totalBytes)}
                            </span>
                          )}
                        </div>
                        <div className="flex-shrink-0">
                          {isDeleted ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-[#fef2f2] text-[#dc2626]">
                              <Trash2 className="size-3" /> Deleted
                            </span>
                          ) : isUpload ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-[#eef2ff] text-[#3067dd]">
                              <ArrowUpCircle className="size-3" /> Uploaded
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-[#f0fdf4] text-[#16a34a]">
                              <ArrowDownCircle className="size-3" /> Downloaded
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Release notes */}
            {hasRegularReleaseNotes && (
              <div className="max-h-[17.5rem] overflow-y-auto">
                <BasicMarkdown text={releaseNotesText} />
              </div>
            )}

            {/* Action buttons — Figma: gap=24 */}
            {shouldShowButton && (
              <div className="flex items-center gap-6 pt-2">
                {/* Mark as read — Figma: fill=#fff, stroke=#eaeaea, radius=6, px=19, py=8 */}
                <button
                  className="px-[19px] py-2 rounded-md border text-[14px] font-medium transition-colors hover:bg-[#f5f5f5]"
                  style={{
                    backgroundColor: "#ffffff",
                    borderColor: "#eaeaea",
                    color: "#111111",
                  }}
                  onClick={handleReadStatusToggle}
                >
                  {unread ? "Mark as read" : "Mark as unread"}
                </button>
                {/* Primary action — Figma: fill=#3067dd, radius=6, px=19, py=8 */}
                <button
                  className="px-[19px] py-2 rounded-md text-white text-[14px] font-medium transition-colors hover:opacity-90"
                  style={{ backgroundColor: "#3067dd" }}
                  onClick={handleLinkClick}
                >
                  {actionText}
                </button>
              </div>
            )}

            {!shouldShowButton && id && (
              <div className="flex items-center gap-6 pt-2">
                <button
                  className="px-[19px] py-2 rounded-md border text-[14px] font-medium transition-colors hover:bg-[#f5f5f5]"
                  style={{
                    backgroundColor: "#ffffff",
                    borderColor: "#eaeaea",
                    color: "#111111",
                  }}
                  onClick={handleReadStatusToggle}
                >
                  {unread ? "Mark as read" : "Mark as unread"}
                </button>
              </div>
            )}
          </div>

          {contextMenu && (
            <NotificationContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              isUnread={unread}
              onClose={() => setContextMenu(null)}
              onToggleReadStatus={handleReadStatusToggle}
              notificationId={id}
              onArchived={() => setContextMenu(null)}
              onArchiveStart={() => {}}
            />
          )}
        </div>
      )}
    </InView>
  );
};

export default NotificationDetailView;
