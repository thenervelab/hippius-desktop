import React, { useState, useEffect } from "react";
import { AbstractIconWrapper, CardButton, Icons } from "@/components/ui";
import { IconComponent } from "@/app/lib/types";
import NotificationType from "./NotificationType";
import { handleButtonLink } from "@/app/lib/utils/links";
import { MoreVertical } from "lucide-react";
import TimeAgo from "react-timeago";
import NotificationContextMenu from "./NotificationContextMenu";
import RevealTextLine from "@/components/ui/reveal-text-line";
import { InView } from "react-intersection-observer";
import { useRouter } from "next/navigation";
import BasicMarkdown from "@/components/updater/BasicMarkdown";
import { getVersion } from "@tauri-apps/api/app";

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

// Helper to compare semver versions (returns true if v1 >= v2)
function isVersionGreaterOrEqual(v1: string, v2: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [a, b] = [parse(v1), parse(v2)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const n1 = a[i] ?? 0;
    const n2 = b[i] ?? 0;
    if (n1 > n2) return true;
    if (n1 < n2) return false;
  }
  return true;
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

  if (!selectedNotification) {
    return <div className=" w-full h-[80.9vh]"></div>;
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
  const descriptionText = hasReleaseNotes
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
          className="w-full flex gap-3 border border-grey-80 rounded p-4 h-[80.9vh]"
        >
          <AbstractIconWrapper className="min-w-[32px] size-8 text-primary-40">
            <Icon className="absolute text-primary-40 size-5" />
          </AbstractIconWrapper>
          <div className="flex flex-col min-h-0 flex-1 min-w-0">
            {/* Type badge */}
            <RevealTextLine rotate reveal={inView} className="delay-200">
              <NotificationType type={type} />
            </RevealTextLine>

            {/* Title */}
            <RevealTextLine rotate reveal={inView} className="delay-300">
              <h2 className="text-[22px] leading-8 font-semibold text-grey-10 mt-[3px] mb-[7px]">
                {title}
              </h2>
            </RevealTextLine>

            {/* Description */}
            <RevealTextLine rotate reveal={inView} className="delay-400">
              <p className="text-sm text-grey-30 font-medium leading-5 mb-[7px]">
                {descriptionText}
              </p>
            </RevealTextLine>

            {hasReleaseNotes && (
              <div className="mt-2 mb-2">
                <div className="flex items-center gap-2 text-grey-50">
                  <Icons.Note2 className="size-5" />
                  <span className="text-base font-bold">Release Notes</span>
                </div>
                <div className=" max-h-[280px] overflow-y-auto pr-2">
                  <BasicMarkdown text={releaseNotesText} />
                </div>
              </div>
            )}
            {/* Time */}
            <RevealTextLine rotate reveal={inView} className="delay-500">
              <span className="text-xs text-grey-60 leading-[18px] mb-[7px]">
                {timestamp ? <TimeAgo date={timestamp} /> : time}
              </span>
            </RevealTextLine>

            {/* Action button */}
            {shouldShowButton && (
              <CardButton
                className="max-w-[152px] h-10"
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
