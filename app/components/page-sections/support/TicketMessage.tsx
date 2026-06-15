"use client";

import React, { useState } from "react";
import { Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TicketMessage } from "@/app/lib/hooks/useSupportTickets";
import { openExternalLink } from "@/app/lib/utils/tauri";

type MessageAttachment = {
  id: number;
  filename: string;
  file: string;
};

interface TicketMessageProps {
  message: TicketMessage;
  isStaff: boolean;
  showContainer?: boolean;
  className?: string;
}

const formatDate = (dateString: string): string => {
  const d = new Date(dateString);
  if (isNaN(d.getTime())) return dateString;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12 || 12;
  return `${dd}/${mm}/${yy} ${hours}:${minutes}${ampm}`;
};

const isImageFile = (filename: string): boolean => {
  const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"];
  return imageExtensions.some((ext) => filename.toLowerCase().endsWith(ext));
};

const TicketMessageComponent: React.FC<TicketMessageProps> = ({
  message,
  isStaff,
  showContainer = true,
  className,
}) => {
  const [loadedImages, setLoadedImages] = useState<Set<number>>(new Set());

  const handleImageLoad = (attachmentId: number) => {
    setLoadedImages((prev) => new Set(prev).add(attachmentId));
  };

  // Author label: append " from Hippius" unless the author display already
  // mentions Hippius (avoids "Hippius Support from Hippius" duplication).
  const authorLabel = message.author_display?.toLowerCase().includes("hippius")
    ? message.author_display
    : `${message.author_display} from Hippius`;

  return (
    <div
      className={cn(
        // 264px when standalone, but shrinks to the parent's content box
        // when nested (e.g. the first-message wrapper, whose px-3 leaves
        // 240px). Without the w-full fallback the rigid 264px would
        // overflow that 240px parent and clip text against the border.
        "flex flex-col gap-2 w-full max-w-[264px] min-w-0",
        showContainer &&
          "overflow-hidden border border-grey-dark-100 bg-white px-3 py-3 shadow-[0px_2px_0px_0px_white] dark:border-black-300 dark:bg-black-600 dark:shadow-[0px_0px_0px_1px_black]",
        showContainer &&
          (isStaff
            ? "rounded-br-[12px] rounded-tl-[12px] rounded-tr-[12px]"
            : "rounded-bl-[12px] rounded-tl-[12px] rounded-tr-[12px]"),
        className,
      )}
    >
      <p className="text-sm font-medium text-grey-10 leading-5 tracking-[-0.28px] whitespace-pre-wrap break-words dark:text-grey-dark-500">
        {message.body}
      </p>

      {message.attachments && message.attachments.length > 0 && (
        <div className="flex flex-col gap-2">
          {message.attachments.map((attachment: MessageAttachment) => {
            const isImage = isImageFile(attachment.filename);

            return isImage ? (
              <div
                key={attachment.id}
                className="relative min-h-[120px] overflow-hidden rounded-[8px] border border-grey-dark-100 dark:border-black-300"
              >
                {!loadedImages.has(attachment.id) && (
                  <div className="absolute inset-0 animate-pulse rounded-[8px] bg-grey-90/70 dark:bg-black-400/70" />
                )}
                <button
                  type="button"
                  onClick={() => openExternalLink(attachment.file)}
                  className="block w-full cursor-pointer transition-opacity hover:opacity-80"
                >
                  <img
                    src={attachment.file}
                    alt={attachment.filename}
                    onLoad={() => handleImageLoad(attachment.id)}
                    className={cn(
                      "h-auto max-h-[200px] w-full object-cover transition-opacity duration-300",
                      loadedImages.has(attachment.id)
                        ? "opacity-100"
                        : "opacity-0",
                    )}
                  />
                </button>
              </div>
            ) : (
              <button
                key={attachment.id}
                type="button"
                onClick={() => openExternalLink(attachment.file)}
                className="inline-flex items-center gap-1 text-xs font-medium text-primary-50 underline transition-colors hover:text-primary-40"
              >
                <Paperclip className="size-3" />
                {attachment.filename}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex flex-col gap-1">
        {isStaff && (
          <p className="text-xs font-medium text-primary-50 leading-[18px] tracking-[-0.24px]">
            {authorLabel}
          </p>
        )}

        <p className="text-xs font-medium text-grey-dark-800 leading-[18px] tracking-[-0.24px] dark:text-grey-dark-800">
          {formatDate(message.created_at)}
        </p>
      </div>
    </div>
  );
};

export default TicketMessageComponent;
