"use client";

import { useState } from "react";
import type { MatrixClient, Room } from "matrix-js-sdk";
import { SmilePlus } from "lucide-react";
import { toast } from "sonner";

import EmojiPicker from "@/components/chat/EmojiPicker";
import CustomTooltip from "@/components/chat/ChatTooltip";
import type { Reaction } from "@/lib/chat/timeline";
import { cn } from "@/lib/utils";

interface ReactionsProps {
  client: MatrixClient;
  room: Room;
  reactions: Reaction[];
  onToggle: (key: string) => Promise<void>;
}

function namesFor(room: Room, senders: string[], me: string | null): string {
  const names = senders.map((id) => (id === me ? "You" : room.getMember(id)?.name ?? id));
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/** Reaction chips under a message, plus the "add reaction" chip. */
export default function Reactions({ client, room, reactions, onToggle }: ReactionsProps) {
  const me = client.getUserId();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const toggle = async (key: string) => {
    if (busyKey) return;
    setBusyKey(key);
    try {
      await onToggle(key);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update reaction");
    } finally {
      setBusyKey(null);
    }
  };

  if (reactions.length === 0) return null;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" role="group" aria-label="Reactions">
      {reactions.map((reaction) => {
        const mine = Boolean(reaction.myEventId);
        return (
          <CustomTooltip
            key={reaction.key}
            tooltipContent={`${namesFor(room, reaction.senders, me)} reacted with ${reaction.key}`}
            side="top"
            asChild
          >
            <button
              type="button"
              onClick={() => void toggle(reaction.key)}
              aria-pressed={mine}
              aria-label={`${reaction.key} ${reaction.count}${mine ? ", you reacted" : ""}`}
              disabled={busyKey === reaction.key}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-full border px-1.5 text-xs transition-colors",
                mine
                  ? "border-primary-50 bg-primary-50/10 text-primary-50 dark:border-primary-40 dark:bg-primary-40/20 dark:text-primary-40"
                  : "border-grey-80 bg-grey-light-600 text-grey-10 hover:border-grey-60 dark:border-black-500 dark:bg-black-primary-bg dark:text-grey-light-100 dark:hover:border-grey-dark-700",
              )}
            >
              <span className="text-sm leading-none">{reaction.key}</span>
              <span className="tabular-nums">{reaction.count}</span>
            </button>
          </CustomTooltip>
        );
      })}
      <EmojiPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={(char) => void toggle(char)}
        trigger={
          <button
            type="button"
            aria-label="Add reaction"
            className="inline-flex h-6 items-center rounded-full border border-grey-80 bg-grey-light-600 px-1.5 text-grey-60 hover:border-grey-60 hover:text-grey-10 dark:border-black-500 dark:bg-black-primary-bg dark:text-grey-dark-700 dark:hover:border-grey-dark-700 dark:hover:text-grey-light-100"
          >
            <SmilePlus className="size-3.5" aria-hidden />
          </button>
        }
      />
    </div>
  );
}
