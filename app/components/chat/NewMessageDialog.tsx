"use client";

import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import type { MatrixClient } from "matrix-js-sdk";
import { ArrowRight, PenSquare } from "lucide-react";
import { toast } from "sonner";

import { chatServerNameAtom, newMessageOpenAtom, rightPanelAtom, selectedRoomIdAtom } from "@/components/chat/chat-ui-atoms";
import {
  dialogContentClassName,
  dialogControlClassName,
  dialogHintClassName,
  dialogLabelClassName,
  dialogListClassName,
  dialogListEmptyClassName,
  dialogPrimaryButtonClassName,
  dialogSecondaryButtonClassName,
  dialogTitleClassName,
} from "@/components/chat/dialog-styles";
import UserAvatar from "@/components/chat/UserAvatar";
import { Button } from "@/components/ui/button";
import FramedDialog from "@/components/ui/FramedDialog";
import { Input } from "@/components/ui/input";
import { type KnownUser, isValidUserId, knownUsers, normaliseUserId, openDirectRoom } from "@/lib/chat/rooms";
import { cn } from "@/lib/utils";

/**
 * "New message": pick someone you already share a room with, or type a
 * Matrix id. Opens the existing DM when there is one, else creates an
 * encrypted one.
 */
export default function NewMessageDialog({ client }: { client: MatrixClient }) {
  const [open, setOpen] = useAtom(newMessageOpenAtom);
  const setSelectedRoomId = useSetAtom(selectedRoomIdAtom);
  const setRightPanel = useSetAtom(rightPanelAtom);
  const serverName = useAtomValue(chatServerNameAtom);

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const people = useMemo(() => (open ? knownUsers(client) : []), [client, open]);
  const q = query.trim().toLowerCase().replace(/^@/, "");
  const suggestions = useMemo(
    () =>
      people
        .filter((u) => !q || u.displayName.toLowerCase().includes(q) || u.userId.toLowerCase().includes(q))
        .slice(0, 6),
    [people, q],
  );

  const typedId = normaliseUserId(query, serverName);
  const typedIsNew = query.trim().length > 0 && isValidUserId(typedId) && !suggestions.some((s) => s.userId === typedId);
  const options: KnownUser[] = typedIsNew
    ? [...suggestions, { userId: typedId, displayName: typedId, avatarMxc: null }]
    : suggestions;
  const me = client.getUserId();

  const close = () => {
    if (submitting) return;
    setOpen(false);
  };

  const start = async (userId: string) => {
    if (submitting) return;
    if (userId === me) {
      toast.error("That is you.");
      return;
    }
    setSubmitting(true);
    try {
      const roomId = await openDirectRoom(client, userId);
      setSelectedRoomId(roomId);
      setRightPanel(null);
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start the conversation");
    } finally {
      setSubmitting(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const pick = options[active] ?? options[0];
    if (pick) void start(pick.userId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((a) => (options.length ? (a + 1) % options.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((a) => (options.length ? (a - 1 + options.length) % options.length : 0));
    }
  };

  return (
    <FramedDialog
      open={open}
      onClose={close}
      title="New message"
      icon={<PenSquare className="size-[17px] text-white" aria-hidden />}
      maxWidth="max-w-[600px]"
      contentClassName={dialogContentClassName}
      titleClassName={dialogTitleClassName}
    >
      <form onSubmit={submit} className="mt-4 flex min-h-0 flex-col gap-4 font-geist">
        <div className="shrink-0">
          <label htmlFor="chat-new-message-to" className={dialogLabelClassName}>
            To
          </label>
          <Input
            id="chat-new-message-to"
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={`Name, or @user:${serverName}`}
            autoComplete="off"
            wrapperClassName={dialogControlClassName}
            role="combobox"
            aria-expanded
            aria-controls="chat-new-message-options"
            aria-activedescendant={options[active] ? `chat-new-message-${active}` : undefined}
          />
          <p className={dialogHintClassName}>Direct messages are end-to-end encrypted.</p>
        </div>

        <ul
          id="chat-new-message-options"
          role="listbox"
          aria-label="People"
          className={dialogListClassName}
        >
          {options.length === 0 ? (
            <li className={dialogListEmptyClassName}>
              {people.length === 0
                ? "Nobody to suggest yet — type a full Matrix id."
                : `No one matches “${query}”.`}
            </li>
          ) : (
            options.map((user, index) => (
              <li
                key={user.userId}
                id={`chat-new-message-${index}`}
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void start(user.userId)}
                className={cn(
                  "flex h-10 cursor-pointer items-center gap-2 rounded px-2 text-sm",
                  index === active
                    ? "bg-primary-50 text-white dark:bg-primary-50 dark:text-white"
                    : "text-grey-10 dark:text-grey-light-100",
                )}
              >
                <UserAvatar client={client} seed={user.userId} avatarMxc={user.avatarMxc} size={24} />
                <span className="min-w-0 flex-1 truncate" title={user.displayName}>{user.displayName}</span>
                {user.displayName !== user.userId ? (
                  <span className={cn("max-w-[45%] truncate text-xs", index === active ? "text-white/70" : "text-grey-60 dark:text-grey-dark-700")}>
                    {user.userId}
                  </span>
                ) : null}
              </li>
            ))
          )}
        </ul>

        <div className="shrink-0 space-y-3 pt-1">
          <Button
            type="submit"
            variant="primary"
            size="auto"
            className={dialogPrimaryButtonClassName}
            disabled={options.length === 0 || submitting}
            loading={submitting}
          >
            <span>Start conversation</span>
            {!submitting ? <ArrowRight className="size-[18px]" strokeWidth={2} aria-hidden /> : null}
          </Button>
          <Button type="button" size="auto" onClick={close} disabled={submitting} className={dialogSecondaryButtonClassName}>
            Cancel
          </Button>
        </div>
      </form>
    </FramedDialog>
  );
}
