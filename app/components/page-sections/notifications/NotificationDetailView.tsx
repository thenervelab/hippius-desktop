import React, { useState } from "react";
import { AbstractIconWrapper, CardButton } from "../../ui";
import { IconComponent } from "@/app/lib/types";
import NotificationType from "./NotificationType";
import { handleButtonLink } from "@/app/lib/utils/links";
import { MoreVertical } from "lucide-react";
import TimeAgo from "react-timeago";
import NotificationContextMenu from "./NotificationContextMenu";
import RevealTextLine from "../../ui/reveal-text-line";
import { InView } from "react-intersection-observer";
import { useRouter } from "next/navigation";
import { useSetAtom } from "jotai";
import { activeSubMenuItemAtom } from "../../sidebar/sideBarAtoms";

interface NotificationDetailViewProps {
  selectedNotification: {
    id?: number;
    icon: IconComponent;
    type: string;
    title: string;
    description: string;
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
  onReadStatusChange
}) => {
  const router = useRouter();
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  if (!selectedNotification) {
    return (
      <div className=" w-full h-[80.9vh]"></div>
      // <div className="flex items-center justify-center w-full h-[80.9vh] border border-grey-80 rounded p-4">
      //   <p className="text-grey-60">Select a notification to view details</p>
      // </div>
    );
  }

  const {
    id,
    icon: Icon,
    type,
    title,
    description,
    time,
    timestamp,
    actionText,
    actionLink,
    unread = false
  } = selectedNotification;

  const handleMoreClick = (e: React.MouseEvent) => {
    e.preventDefault();
    const button = e.currentTarget;
    const rect = button.getBoundingClientRect();
    setContextMenu({
      x: rect.left,
      y: rect.bottom
    });
  };

  const handleReadStatusToggle = () => {
    if (id && onReadStatusChange) {
      onReadStatusChange(id, !unread);
    }
  };
  const setActiveSubMenuItem = useSetAtom(activeSubMenuItemAtom);

  const handleLinkClick = (e: React.MouseEvent) => {
    handleButtonLink(e, actionLink, router, setActiveSubMenuItem);
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
          <div className="flex flex-col">
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
                {description}
              </p>
            </RevealTextLine>

            {/* Time */}
            <RevealTextLine rotate reveal={inView} className="delay-500">
              <span className="text-xs text-grey-60 leading-[18px] mb-[7px]">
                {timestamp ? <TimeAgo date={timestamp} /> : time}
              </span>
            </RevealTextLine>

            {/* Action button */}
            {actionText && (
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
            className="text-grey-70 p-2 hover:bg-primary-100 rounded self-start"
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
            />
          )}
        </div>
      )}
    </InView>
  );
};

export default NotificationDetailView;
