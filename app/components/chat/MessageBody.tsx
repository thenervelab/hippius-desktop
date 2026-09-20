"use client";

import { type MouseEvent, useMemo } from "react";

import { isEmojiOnly } from "@/lib/chat/emoji";
import { plainTextToHtml, sanitizeHtml } from "@/lib/chat/html";
import type { MessageBody as Body } from "@/lib/chat/timeline";
import { cn } from "@/lib/utils";

interface MessageBodyProps {
  body: Body;
  senderName: string;
  /** Called when a `matrix.to` user link is clicked, with the user id. */
  onMentionClick?: (userId: string) => void;
  /** Called when an in-app permalink (same room) is clicked, with the event id. */
  onEventLinkClick?: (roomId: string, eventId: string) => void;
  className?: string;
}

const MATRIX_TO_USER = /^https:\/\/matrix\.to\/#\/(@[^/?]+)/i;
const MATRIX_TO_EVENT = /^https:\/\/matrix\.to\/#\/([!#][^/?]+)\/(\$[^/?]+)/i;

/**
 * Prose classes for message HTML: tight paragraphs, inline code, quotes,
 * mention pills (`a[data-mention]`). Kept as one string so both the
 * timeline and the thread panel render identically.
 */
export const messageProseClassName = cn(
  "break-words text-[15px] leading-[1.45] text-grey-10 dark:text-grey-light-100",
  "[&_p]:my-0 [&_p+p]:mt-2",
  "[&_a]:text-primary-50 [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:opacity-80 dark:[&_a]:text-primary-40",
  "[&_a[data-mention]]:no-underline [&_a[data-mention]]:rounded [&_a[data-mention]]:bg-primary-50/10 [&_a[data-mention]]:px-1 [&_a[data-mention]]:font-medium dark:[&_a[data-mention]]:bg-primary-40/20",
  "[&_code]:rounded [&_code]:bg-grey-90 [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[13px] [&_code]:text-error-50 dark:[&_code]:bg-black-500 dark:[&_code]:text-error-50",
  "[&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-grey-80 [&_pre]:bg-grey-light-600 [&_pre]:p-2 dark:[&_pre]:border-black-500 dark:[&_pre]:bg-black-primary-bg",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-grey-10 dark:[&_pre_code]:bg-transparent dark:[&_pre_code]:text-grey-light-100",
  "[&_blockquote]:my-1 [&_blockquote]:border-l-4 [&_blockquote]:border-grey-80 [&_blockquote]:pl-3 [&_blockquote]:text-grey-60 dark:[&_blockquote]:border-black-500 dark:[&_blockquote]:text-grey-dark-700",
  "[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-[15px] [&_h3]:font-semibold",
  "[&_del]:text-grey-60 dark:[&_del]:text-grey-dark-700",
  "[&_span[data-mx-spoiler]]:rounded [&_span[data-mx-spoiler]]:bg-grey-10 [&_span[data-mx-spoiler]]:text-grey-10 hover:[&_span[data-mx-spoiler]]:bg-transparent dark:[&_span[data-mx-spoiler]]:bg-grey-light-100 dark:[&_span[data-mx-spoiler]]:text-grey-light-100 dark:hover:[&_span[data-mx-spoiler]]:bg-transparent",
  "[&_table]:my-1 [&_table]:border-collapse [&_td]:border [&_td]:border-grey-80 [&_td]:px-2 [&_td]:py-0.5 [&_th]:border [&_th]:border-grey-80 [&_th]:px-2 [&_th]:py-0.5 dark:[&_td]:border-black-500 dark:[&_th]:border-black-500",
);

/** Message content as safe HTML, with mention / permalink click routing. */
export default function MessageBody({ body, senderName, onMentionClick, onEventLinkClick, className }: MessageBodyProps) {
  const html = useMemo(() => {
    if (body.redacted || body.decryptionFailed) return "";
    const source = body.formatted ? sanitizeHtml(body.formatted) : plainTextToHtml(body.text);
    return body.emote ? `<em>${sanitizeHtml(senderName)} ${source}</em>` : source;
  }, [body, senderName]);

  if (body.redacted) {
    return <p className={cn("text-sm italic text-grey-60 dark:text-grey-dark-700", className)}>This message was deleted.</p>;
  }
  if (body.decryptionFailed) {
    return (
      <p className={cn("text-sm italic text-grey-60 dark:text-grey-dark-700", className)}>
        Unable to decrypt: the keys for this message are not on this device yet.
      </p>
    );
  }

  const big = !body.formatted && isEmojiOnly(body.text);

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    const user = MATRIX_TO_USER.exec(href);
    if (user && onMentionClick) {
      event.preventDefault();
      onMentionClick(decodeURIComponent(user[1]));
      return;
    }
    const ev = MATRIX_TO_EVENT.exec(href);
    if (ev && onEventLinkClick) {
      event.preventDefault();
      onEventLinkClick(decodeURIComponent(ev[1]), decodeURIComponent(ev[2]));
    }
  };

  return (
    <div
      className={cn(messageProseClassName, big && "text-[40px] leading-tight", body.notice && "text-grey-60 dark:text-grey-dark-700", className)}
      onClick={onClick}
      // Sanitised by `sanitizeHtml` / produced by `plainTextToHtml`; both escape text nodes.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
