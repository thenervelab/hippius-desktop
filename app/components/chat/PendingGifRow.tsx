"use client";

import { useSetAtom } from "jotai";
import type { MatrixClient, Room } from "matrix-js-sdk";
import { AlertCircle, X } from "lucide-react";

import { fitBox } from "@/components/chat/AttachmentView";
import {
  type PendingGif,
  pendingGifsAtom,
} from "@/components/chat/chat-ui-atoms";
import UserAvatar from "@/components/chat/UserAvatar";
import { formatTime } from "@/lib/chat/timeline";
import { cn } from "@/lib/utils";

interface PendingGifRowProps {
  client: MatrixClient;
  room: Room;
  item: PendingGif;
}

/**
 * Optimistic row for a GIF on its way out: the provider preview plays locally
 * while the real bytes are fetched, encrypted and uploaded. Replaced by the
 * SDK's local echo once `sendMessage` resolves; on failure it stays with
 * the reason until dismissed.
 */
export default function PendingGifRow({
  client,
  room,
  item,
}: PendingGifRowProps) {
  const setPending = useSetAtom(pendingGifsAtom);
  const me = client.getUserId() ?? "";
  const member = room.getMember(me);
  const name = member?.name ?? me;
  const box = fitBox(item.width || null, item.height || null);
  const failed = item.status === "failed";

  return (
    <div
      role="article"
      aria-label={`${name}, sending a GIF`}
      aria-busy={!failed}
      className={cn(
        "group relative mt-2 flex gap-3 px-4 py-0.5",
        failed && "bg-error-50/5 dark:bg-error-50/10",
      )}
    >
      <div className="w-9 shrink-0">
        <UserAvatar
          client={client}
          seed={me}
          avatarMxc={member?.getMxcAvatarUrl() ?? null}
          size={36}
          shape="square"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[15px] font-bold text-grey-10 dark:text-grey-light-100">
            {name}
          </span>
          <span className="text-xs text-grey-60 dark:text-grey-dark-700">
            {formatTime(Date.now())}
          </span>
        </div>
        <p
          className={cn(
            "whitespace-pre-wrap break-words text-[15px] leading-[1.45] text-grey-10 dark:text-grey-light-100",
            !failed && "opacity-60",
          )}
        >
          {item.title}
        </p>
        <div
          style={{ width: box.width, height: box.height }}
          className={cn(
            "relative mt-1 overflow-hidden rounded-lg border border-grey-80 bg-grey-90 dark:border-black-500 dark:bg-black-500",
            !failed && "opacity-60",
          )}
        >
          <img
            src={item.previewUrl}
            alt=""
            width={box.width}
            height={box.height}
            className="size-full object-cover"
          />
          <span
            className="absolute bottom-1.5 left-1.5 rounded bg-black-900/70 px-1 py-0.5 text-[10px] font-bold leading-none text-white dark:bg-black-900/70 dark:text-white"
            aria-hidden
          >
            GIF
          </span>
        </div>
        {failed ? (
          <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-error-50 dark:text-error-50">
            <AlertCircle className="size-3.5" aria-hidden />
            {item.error ?? "Could not send the GIF"}
            <button
              type="button"
              onClick={() =>
                setPending((prev) => prev.filter((p) => p.id !== item.id))
              }
              aria-label="Dismiss"
              className="ml-1 inline-flex items-center text-grey-60 hover:text-grey-10 dark:text-grey-dark-700 dark:hover:text-grey-light-100"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </p>
        ) : (
          <p className="mt-1 text-[11px] text-grey-60 dark:text-grey-dark-700">
            Sending GIF…
          </p>
        )}
      </div>
    </div>
  );
}
