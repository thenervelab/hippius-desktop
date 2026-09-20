"use client";

import { memo, useCallback, useMemo, useState } from "react";
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import { useSetAtom } from "jotai";
import { AlertCircle, Check, Clock, Copy, Link2, MessageSquare, MoreHorizontal, Pencil, Reply, RotateCcw, SmilePlus, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import AttachmentView from "@/components/chat/AttachmentView";
import ChatMenu, { type ChatMenuItem } from "@/components/chat/ChatMenu";
import { editingEventIdAtom, jumpToEventAtom, replyToEventIdAtom, rightPanelAtom } from "@/components/chat/chat-ui-atoms";
import EmojiPicker from "@/components/chat/EmojiPicker";
import MessageBody from "@/components/chat/MessageBody";
import Reactions from "@/components/chat/Reactions";
import UserAvatar from "@/components/chat/UserAvatar";
import CustomTooltip from "@/components/chat/ChatTooltip";
import { cancelSend, deleteMessage, retrySend, toggleReaction } from "@/lib/chat/actions";
import { eventPermalink } from "@/lib/chat/rooms";
import { eventPreview } from "@/lib/chat/threads";
import { attachmentCaption, attachmentOf, canEdit, canRedact, formatTime, messageBody, reactionsFor, readersOf, sendStateOf } from "@/lib/chat/timeline";
import { cn } from "@/lib/utils";

interface MessageRowProps {
  client: MatrixClient;
  room: Room;
  event: MatrixEvent;
  groupStart: boolean;
  /** Re-render key: bumps when receipts / reactions / edits change. */
  tick: number;
  /** Highlighted after a permalink jump. */
  highlighted?: boolean;
  /** Thread panel rows hide the "reply in thread" affordances. */
  inThread?: boolean;
  /** Quoted reply target (Slack-style "replying to") shown above the body. */
  replyTo?: MatrixEvent | null;
}

const HOVER_BUTTON =
  "inline-flex size-7 items-center justify-center rounded-md text-grey-60 hover:bg-grey-90 hover:text-grey-10 dark:text-grey-dark-700 dark:hover:bg-black-500 dark:hover:text-grey-light-100";

function MessageRowInner({ client, room, event, groupStart, tick, highlighted, inThread, replyTo }: MessageRowProps) {
  const me = client.getUserId();
  const sender = event.getSender() ?? "";
  const member = room.getMember(sender);
  const senderName = member?.name ?? sender;
  const isMine = sender === me;
  const setRightPanel = useSetAtom(rightPanelAtom);
  const setEditing = useSetAtom(editingEventIdAtom);
  const setReplyTo = useSetAtom(replyToEventIdAtom);
  const setJump = useSetAtom(jumpToEventAtom);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // `tick` is a dependency on purpose: the SDK mutates in place.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const body = useMemo(() => messageBody(event), [event, tick]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reactions = useMemo(() => reactionsFor(room, event, me), [room, event, me, tick]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const attachment = useMemo(() => attachmentOf(event), [event, tick]);
  // An attachment whose body is just its filename gets the card alone; the
  // name is already on it. Text-only messages always render their body.
  const caption = attachment ? attachmentCaption(body.text, attachment) : body.text;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const readers = useMemo(() => (isMine ? readersOf(room, event, me) : []), [room, event, me, isMine, tick]);
  const sendState = sendStateOf(event);
  const thread = event.getThread();
  const threadReplies = !inThread && event.isThreadRoot && thread ? thread.length : 0;

  const onToggleReaction = useCallback((key: string) => toggleReaction(client, room, event, key), [client, room, event]);

  const openThread = () => {
    const id = event.getId();
    if (id) setRightPanel({ kind: "thread", roomId: room.roomId, rootEventId: id });
  };
  const copyLink = async () => {
    const id = event.getId();
    if (!id) return;
    await navigator.clipboard.writeText(eventPermalink(room.roomId, id));
    toast.success("Link copied");
  };
  const copyText = async () => {
    await navigator.clipboard.writeText(body.text);
    toast.success("Text copied");
  };
  const remove = async () => {
    setConfirmDelete(false);
    try {
      await deleteMessage(client, room, event);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete the message");
    }
  };

  const menuItems: (ChatMenuItem | "separator")[] = [
    ...(!inThread ? [{ key: "thread", label: threadReplies ? "Open thread" : "Reply in thread", icon: MessageSquare, onSelect: openThread }] : []),
    { key: "reply", label: "Reply", icon: Reply, onSelect: () => setReplyTo(event.getId() ?? null) },
    { key: "copy-link", label: "Copy link", icon: Link2, onSelect: () => void copyLink() },
    { key: "copy-text", label: "Copy text", icon: Copy, onSelect: () => void copyText(), disabled: !body.text },
    ...(canEdit(client, event) ? [{ key: "edit", label: "Edit message", icon: Pencil, shortcut: "↑", onSelect: () => setEditing(event.getId() ?? null) }] : []),
    ...(canRedact(client, room, event) && !body.redacted
      ? ["separator" as const, { key: "delete", label: "Delete message", icon: Trash2, destructive: true, onSelect: () => setConfirmDelete(true) }]
      : []),
  ];

  const time = formatTime(event.getTs());
  const fullDate = new Date(event.getTs()).toLocaleString();

  return (
    <div
      id={`msg-${event.getId() ?? event.getTxnId() ?? ""}`}
      role="article"
      aria-label={`${senderName} at ${time}`}
      className={cn(
        "group relative flex gap-3 px-4 py-0.5 hover:bg-grey-light-600 dark:hover:bg-black-primary-bg",
        groupStart && "mt-2",
        highlighted && "bg-warning-50/10 dark:bg-warning-50/20",
        sendState === "failed" && "bg-error-50/5 dark:bg-error-50/10",
        (menuOpen || pickerOpen) && "bg-grey-light-600 dark:bg-black-primary-bg",
      )}
    >
      <div className="w-9 shrink-0">
        {groupStart ? (
          <button type="button" onClick={() => setRightPanel({ kind: "member", roomId: room.roomId, userId: sender })} aria-label={`View ${senderName}`}>
            <UserAvatar client={client} seed={sender} avatarMxc={member?.getMxcAvatarUrl() ?? null} size={36} shape="square" />
          </button>
        ) : (
          <span className="block pt-1 text-right text-[10px] leading-4 text-grey-60 opacity-0 group-hover:opacity-100 dark:text-grey-dark-700" aria-hidden>
            {time}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {groupStart ? (
          <div className="flex items-baseline gap-2">
            <button
              type="button"
              onClick={() => setRightPanel({ kind: "member", roomId: room.roomId, userId: sender })}
              className="truncate text-[15px] font-bold text-grey-10 hover:underline dark:text-grey-light-100"
            >
              {senderName}
            </button>
            <time dateTime={new Date(event.getTs()).toISOString()} title={fullDate} className="text-xs text-grey-60 dark:text-grey-dark-700">
              {time}
            </time>
          </div>
        ) : null}

        {replyTo ? (
          <button
            type="button"
            onClick={() => {
              const id = replyTo.getId();
              if (id) setJump({ roomId: room.roomId, eventId: id });
            }}
            className="mb-0.5 flex max-w-full items-center gap-1 border-l-2 border-grey-80 pl-2 text-left text-xs text-grey-60 hover:text-grey-10 dark:border-black-500 dark:text-grey-dark-700 dark:hover:text-grey-light-100"
          >
            <span className="font-medium">{room.getMember(replyTo.getSender() ?? "")?.name ?? replyTo.getSender()}</span>
            <span className="truncate">{eventPreview(replyTo, 80)}</span>
          </button>
        ) : null}

        {caption !== null ? (
          <div className={cn(sendState === "sending" && "opacity-60")}>
            <MessageBody
              body={body}
              senderName={senderName}
              onMentionClick={(userId) => setRightPanel({ kind: "member", roomId: room.roomId, userId })}
              onEventLinkClick={(roomId, eventId) => setJump({ roomId, eventId })}
            />
            {body.edited ? <span className="ml-1 text-[11px] text-grey-60 dark:text-grey-dark-700">(edited)</span> : null}
          </div>
        ) : null}

        {attachment ? <AttachmentView client={client} attachment={attachment} senderName={senderName} /> : null}

        <Reactions client={client} room={room} reactions={reactions} onToggle={onToggleReaction} />

        {threadReplies > 0 ? (
          <button
            type="button"
            onClick={openThread}
            className="mt-1 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-xs font-medium text-primary-50 hover:underline dark:text-primary-40"
          >
            <MessageSquare className="size-3.5" aria-hidden />
            {threadReplies} {threadReplies === 1 ? "reply" : "replies"}
            {thread?.lastReply() ? <span className="font-normal text-grey-60 dark:text-grey-dark-700">· last {formatTime(thread.lastReply()!.getTs())}</span> : null}
          </button>
        ) : null}

        {sendState === "failed" ? (
          <div className="mt-1 flex items-center gap-2 text-xs text-error-50 dark:text-error-50" role="alert">
            <AlertCircle className="size-3.5" aria-hidden />
            <span>Not sent.</span>
            <button type="button" className="inline-flex items-center gap-1 underline" onClick={() => void retrySend(client, room, event).catch(() => toast.error("Still failing"))}>
              <RotateCcw className="size-3" aria-hidden /> Retry
            </button>
            <button type="button" className="inline-flex items-center gap-1 underline" onClick={() => cancelSend(client, event)}>
              <X className="size-3" aria-hidden /> Discard
            </button>
          </div>
        ) : null}
      </div>

      {/* Delivery state for own messages: sending clock, sent tick, read names on hover. */}
      {isMine && sendState !== "failed" ? (
        <div className="absolute bottom-1 right-3 hidden text-grey-60 group-hover:block dark:text-grey-dark-700">
          {sendState === "sending" ? (
            <Clock className="size-3" aria-label="Sending" />
          ) : readers.length ? (
            <CustomTooltip tooltipContent={`Seen by ${readers.map((id) => room.getMember(id)?.name ?? id).join(", ")}`} side="left" asChild>
              <span className="inline-flex items-center text-primary-50 dark:text-primary-40" aria-label={`Seen by ${readers.length}`}>
                <Check className="-mr-1.5 size-3" aria-hidden />
                <Check className="size-3" aria-hidden />
              </span>
            </CustomTooltip>
          ) : (
            <Check className="size-3" aria-label="Sent" />
          )}
        </div>
      ) : null}

      {/* Hover toolbar */}
      {!body.redacted && sendState === "sent" ? (
        <div
          className={cn(
            "absolute -top-3 right-3 z-10 hidden items-center gap-0.5 rounded-md border border-grey-80 bg-white p-0.5 shadow-dialog group-hover:flex group-focus-within:flex dark:border-black-500 dark:bg-black-300",
            (menuOpen || pickerOpen) && "flex",
          )}
          role="toolbar"
          aria-label="Message actions"
        >
          <EmojiPicker
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onPick={(char) => void onToggleReaction(char).catch(() => toast.error("Could not react"))}
            trigger={
              <button type="button" className={HOVER_BUTTON} aria-label="Add reaction">
                <SmilePlus className="size-4" aria-hidden />
              </button>
            }
          />
          {!inThread ? (
            <button type="button" className={HOVER_BUTTON} aria-label="Reply in thread" onClick={openThread}>
              <MessageSquare className="size-4" aria-hidden />
            </button>
          ) : (
            <button type="button" className={HOVER_BUTTON} aria-label="Reply" onClick={() => setReplyTo(event.getId() ?? null)}>
              <Reply className="size-4" aria-hidden />
            </button>
          )}
          {canEdit(client, event) ? (
            <button type="button" className={HOVER_BUTTON} aria-label="Edit message" onClick={() => setEditing(event.getId() ?? null)}>
              <Pencil className="size-4" aria-hidden />
            </button>
          ) : null}
          <ChatMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            items={menuItems}
            label="Message"
            trigger={
              <button type="button" className={HOVER_BUTTON} aria-label="More actions">
                <MoreHorizontal className="size-4" aria-hidden />
              </button>
            }
          />
        </div>
      ) : null}

      {confirmDelete ? (
        <div
          role="alertdialog"
          aria-label="Delete this message?"
          className="absolute right-3 top-1 z-20 flex items-center gap-2 rounded-md border border-grey-80 bg-white px-2 py-1.5 text-xs shadow-dialog dark:border-black-500 dark:bg-black-300"
        >
          <span className="text-grey-10 dark:text-grey-light-100">Delete this message?</span>
          <button type="button" className="rounded px-2 py-0.5 font-medium text-white bg-error-50 hover:opacity-90 dark:bg-error-50 dark:text-white" onClick={() => void remove()}>
            Delete
          </button>
          <button type="button" className="rounded px-2 py-0.5 text-grey-60 hover:text-grey-10 dark:text-grey-dark-700 dark:hover:text-grey-light-100" onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}

const MessageRow = memo(MessageRowInner);
export default MessageRow;
