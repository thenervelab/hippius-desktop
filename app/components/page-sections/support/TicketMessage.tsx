/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import React, { useState } from "react";
import { Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TicketMessage } from "@/app/lib/hooks/useSupportTickets";
import { openExternalLink } from "@/app/lib/utils/tauri";

interface TicketMessageProps {
  message: TicketMessage;
  isFirstMessage?: boolean;
  isStaff?: boolean;
}

const TicketMessage: React.FC<TicketMessageProps> = ({
  message,
  isFirstMessage = false,
  isStaff: isStaffProp,
}) => {
  const isStaff = isStaffProp ?? message.author_is_staff;
  const [loadedImages, setLoadedImages] = useState<Set<number>>(new Set());

  const formatDate = (dateString: string) => {
    const d = new Date(dateString);
    if (isNaN(d.getTime())) return "Invalid Date";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = String(d.getFullYear());
    let hours = d.getHours();
    const minutes = String(d.getMinutes()).padStart(2, "0");
    const ampm = hours >= 12 ? "pm" : "am";
    hours = hours % 12 || 12;
    return `${dd}/${mm}/${yyyy} ${hours}:${minutes} ${ampm}`;
  };

  const isImageFile = (filename: string) => {
    const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"];
    return imageExtensions.some((ext) => filename.toLowerCase().endsWith(ext));
  };

  const handleImageLoad = (attachmentId: number) => {
    setLoadedImages((prev) => new Set(prev).add(attachmentId));
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 w-[16.5rem]",
        !isFirstMessage && "bg-white border border-grey-80 rounded-lg p-2",
      )}
    >
      {/* Message Body */}
      <p className="text-sm font-medium text-grey-10 leading-5 tracking-[-0.28px] whitespace-pre-wrap break-words">
        {message.body}
      </p>

      {/* Attachments */}
      {message.attachments && message.attachments.length > 0 && (
        <div className="flex flex-col gap-2">
          {message.attachments.map((attachment: any) => {
            const isImage = isImageFile(attachment.filename);

            return isImage ? (
              // Image attachment - show preview with skeleton loader
              <div
                key={attachment.id}
                className="relative rounded overflow-hidden border border-grey-80 min-h-[12.5rem]"
              >
                {/* Skeleton loader - shown while image loads */}
                {!loadedImages.has(attachment.id) && (
                  <div className="absolute inset-0  animate-pulse rounded-md bg-[#1e293b]/30" />
                )}
                {/* Actual image */}
                <div
                  onClick={() => openExternalLink(attachment.file)}
                  className="block hover:opacity-80 transition-opacity cursor-pointer"
                >
                  <img
                    src={attachment.file}
                    alt={attachment.filename}
                    onLoad={() => handleImageLoad(attachment.id)}
                    className={cn(
                      "w-full h-auto max-h-[12.5rem] object-cover transition-opacity duration-300",
                      loadedImages.has(attachment.id)
                        ? "opacity-100"
                        : "opacity-0",
                    )}
                  />
                </div>
              </div>
            ) : (
              // Non-image attachment - show as link
              <button
                key={attachment.id}
                onClick={() => openExternalLink(attachment.file)}
                className="flex items-center gap-1 text-xs text-primary-50 hover:text-primary-40 underline transition-colors"
              >
                <Paperclip className="size-3" />
                {attachment.filename}
              </button>
            );
          })}
        </div>
      )}

      {/* Author Info - Only show for staff messages */}
      <div className="flex flex-col gap-1">
        {isStaff && (
          <p className="text-xs font-medium text-primary-50 leading-[1.125rem] tracking-[-0.24px]">
            {message.author_display}{" "}
            {message.author_display ? "from Hippius" : "From Hippius"}
          </p>
        )}

        {/* Timestamp */}
        <p className="text-xs font-medium text-grey-60 leading-[1.125rem] tracking-[-0.24px]">
          {formatDate(message.created_at)}
        </p>
      </div>
    </div>
  );
};

export default TicketMessage;
