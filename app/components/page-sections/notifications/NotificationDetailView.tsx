import React from "react";
import { AbstractIconWrapper, Button, CardButton } from "../../ui";
import { IconComponent } from "@/app/lib/types";
import NotificationType from "./NotificationType";
import { openLinkByKey } from "@/app/lib/utils/links";
import { MoreVertical } from "lucide-react";

interface NotificationDetailViewProps {
  selectedNotification: {
    icon: IconComponent;
    type: string;
    title: string;
    description: string;
    time: string;
    actionText?: string;
    actionLink?: string;
  } | null;
}

const NotificationDetailView: React.FC<NotificationDetailViewProps> = ({
  selectedNotification,
}) => {
  if (!selectedNotification) {
    return (
      <div className="flex items-center justify-center w-full h-[80.9vh] border border-grey-80 rounded p-4">
        <p className="text-grey-60">Select a notification to view details</p>
      </div>
    );
  }

  const {
    icon: Icon,
    type,
    title,
    description,
    time,
    actionText,
    actionLink,
  } = selectedNotification;
  return (
    <div className="w-full flex gap-3 border border-grey-80 rounded p-4 h-[80.9vh]">
      <AbstractIconWrapper className="min-w-[32px] size-8 text-primary-40">
        <Icon className="absolute text-primary-40 size-5" />
      </AbstractIconWrapper>
      <div className="flex flex-col">
        {/* Type badge */}
        <NotificationType type={type} />

        {/* Title */}
        <h2 className="text-[22px] leading-8 font-semibold text-grey-10 mt-[3px] mb-[7px]">
          {title}
        </h2>

        {/* Description */}
        <p className="text-sm text-grey-30 font-medium leading-5 mb-[7px]">
          {description}
        </p>

        {/* Time */}
        <span className="text-xs text-grey-60 leading-[18px] mb-[7px]">
          {time}
        </span>

        {/* Action button */}
        {actionText && (
          <CardButton
            className="max-w-[152px] h-10"
            onClick={() => openLinkByKey(actionLink || "")}
          >
            <span className="flex items-center text-lg font-medium">
              {actionText}
            </span>
          </CardButton>
        )}
      </div>
      <button className="text-grey-70 p-2 hover:bg-primary-100 rounded self-start">
        <MoreVertical className="size-4" />
      </button>
    </div>
  );
};

export default NotificationDetailView;
