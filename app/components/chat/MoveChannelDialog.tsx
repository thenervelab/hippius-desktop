"use client";

import { useState } from "react";
import { useAtom } from "jotai";
import type { MatrixClient } from "matrix-js-sdk";
import { Check, FolderInput, Hash } from "lucide-react";
import { toast } from "sonner";

import { moveChannelAtom } from "@/components/chat/chat-ui-atoms";
import { dialogContentClassName, dialogListClassName, dialogSecondaryButtonClassName, dialogTitleClassName } from "@/components/chat/dialog-styles";
import type { WorkspacesState } from "@/components/chat/hooks/useWorkspaces";
import { Button } from "@/components/ui/button";
import FramedDialog from "@/components/ui/FramedDialog";
import { moveChannelToCategory } from "@/lib/chat/spaces";
import { cn } from "@/lib/utils";

const rowClassName =
  "flex h-9 w-full items-center gap-2 rounded px-2 text-left text-sm text-grey-10 outline-none hover:bg-grey-90 focus-visible:ring-2 focus-visible:ring-primary-50 disabled:opacity-60 dark:text-grey-light-100 dark:hover:bg-black-500 dark:focus-visible:ring-primary-40";

/**
 * "Move to category…" from a channel's menu: the workspace's categories
 * plus "No category"; one click moves the channel and closes. The current
 * home is ticked and not clickable.
 */
export default function MoveChannelDialog({ client, workspaces }: { client: MatrixClient; workspaces: WorkspacesState }) {
  const [roomId, setRoomId] = useAtom(moveChannelAtom);
  const [moving, setMoving] = useState<string | null>(null);
  const { active, groups, channels } = workspaces;
  const channel = roomId ? (channels.find((c) => c.id === roomId) ?? null) : null;
  const currentCategory = roomId ? (groups.categories.find((c) => c.channels.some((ch) => ch.id === roomId)) ?? null) : null;
  const open = Boolean(roomId && channel && active);

  const close = () => {
    if (moving) return;
    setRoomId(null);
  };

  const moveTo = async (targetId: string, targetName: string) => {
    if (!active || !channel || moving) return;
    const space = client.getRoom(active.id);
    if (!space) return;
    setMoving(targetId);
    try {
      await moveChannelToCategory(client, space, channel.id, targetId);
      toast.success(targetId === active.id ? `#${channel.name} is no longer in a category` : `#${channel.name} moved to ${targetName}`);
      setRoomId(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not move the channel");
    } finally {
      setMoving(null);
    }
  };

  const options = active ? [{ id: active.id, name: "No category" }, ...groups.categories.map((c) => ({ id: c.id, name: c.name }))] : [];
  const currentId = currentCategory?.id ?? active?.id ?? null;

  return (
    <FramedDialog
      open={open}
      onClose={close}
      title={channel ? <span title={channel.name}>Move #{channel.name} to…</span> : "Move channel"}
      icon={<FolderInput className="size-[17px] text-white" aria-hidden />}
      maxWidth="max-w-[480px]"
      contentClassName={dialogContentClassName}
      titleClassName={dialogTitleClassName}
    >
      <div className="mt-4 flex flex-col gap-4 font-geist">
        <ul aria-label="Categories" className={cn(dialogListClassName, "h-auto max-h-60")}>
          {options.map((option) => {
            const current = option.id === currentId;
            return (
              <li key={option.id}>
                <button
                  type="button"
                  onClick={() => moveTo(option.id, option.name)}
                  disabled={current || moving !== null}
                  aria-current={current ? "true" : undefined}
                  className={rowClassName}
                >
                  {option.id === active?.id ? (
                    <Hash className="size-4 shrink-0 text-grey-60 dark:text-grey-dark-700" aria-hidden />
                  ) : (
                    <FolderInput className="size-4 shrink-0 text-grey-60 dark:text-grey-dark-700" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1 truncate" title={option.name}>
                    {option.name}
                  </span>
                  {current ? <Check className="size-4 shrink-0 text-primary-50 dark:text-primary-40" aria-hidden /> : null}
                  {moving === option.id ? <span className="text-xs text-grey-60 dark:text-grey-dark-700">Moving…</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
        <Button type="button" size="auto" onClick={close} disabled={moving !== null} className={dialogSecondaryButtonClassName}>
          Cancel
        </Button>
      </div>
    </FramedDialog>
  );
}
