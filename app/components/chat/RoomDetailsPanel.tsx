"use client";

import { type KeyboardEvent, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { EventType, type MatrixClient, type Room, RoomMemberEvent, RoomStateEvent } from "matrix-js-sdk";
import { Bell, BellOff, Check, Copy, Hash, Lock, LogOut, Pencil, Search, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { chatServerNameAtom, rightPanelAtom, selectedRoomIdAtom } from "@/components/chat/chat-ui-atoms";
import { useClientTick } from "@/components/chat/hooks/useClientTick";
import { usePresence } from "@/components/chat/hooks/usePresence";
import PanelHeader from "@/components/chat/PanelHeader";
import ToggleSwitch from "@/components/chat/ToggleSwitch";
import UserAvatar from "@/components/chat/UserAvatar";
import { presenceLabel } from "@/lib/chat/presence";
import { type RoomSummary, isValidUserId, normaliseUserId, roomLabel, roomPermalink, setRoomMuted } from "@/lib/chat/rooms";
import { cn } from "@/lib/utils";

interface RoomDetailsPanelProps {
  client: MatrixClient;
  room: Room;
  summary: RoomSummary;
}

const ROW = "flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-grey-10 hover:bg-grey-light-600 dark:text-grey-light-100 dark:hover:bg-black-primary-bg";
const FIELD =
  "w-full rounded-md border border-grey-80 bg-white px-2.5 py-1.5 text-sm text-grey-10 outline-none placeholder:text-grey-60 focus:border-primary-50 dark:border-black-500 dark:bg-black-300 dark:text-grey-light-100 dark:placeholder:text-grey-dark-700 dark:focus:border-primary-40";

/** Right column: about, members, notifications, leave. */
export default function RoomDetailsPanel({ client, room, summary }: RoomDetailsPanelProps) {
  const setRightPanel = useSetAtom(rightPanelAtom);
  const setSelectedRoomId = useSetAtom(selectedRoomIdAtom);
  const serverName = useAtomValue(chatServerNameAtom);
  const tick = useClientTick(client, [RoomStateEvent.Members, RoomMemberEvent.Name, RoomMemberEvent.PowerLevel, RoomStateEvent.Events]);
  const me = client.getUserId() ?? "";
  const [memberQuery, setMemberQuery] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteValue, setInviteValue] = useState("");
  const [busy, setBusy] = useState<"mute" | "leave" | "invite" | "name" | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(summary.name);
  const [copied, setCopied] = useState(false);

  const members = useMemo(
    () => room.getJoinedMembers().sort((a, b) => b.powerLevel - a.powerLevel || a.name.localeCompare(b.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room, tick],
  );
  const invited = useMemo(
    () => room.getMembersWithMembership("invite"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room, tick],
  );
  const presence = usePresence(
    client,
    members.map((m) => m.userId),
  );
  const filtered = memberQuery
    ? members.filter((m) => m.name.toLowerCase().includes(memberQuery.toLowerCase()) || m.userId.toLowerCase().includes(memberQuery.toLowerCase()))
    : members;

  const canInvite = room.canInvite(me);
  const canRename = room.currentState.maySendStateEvent(EventType.RoomName, me) && summary.kind === "channel";
  const isDm = summary.kind === "dm";

  const toggleMute = async (muted: boolean) => {
    setBusy("mute");
    try {
      await setRoomMuted(client, room.roomId, muted);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update notifications");
    } finally {
      setBusy(null);
    }
  };

  const leave = async () => {
    if (!window.confirm(`Leave ${roomLabel(summary)}?`)) return;
    setBusy("leave");
    try {
      await client.leave(room.roomId);
      setRightPanel(null);
      setSelectedRoomId(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not leave");
    } finally {
      setBusy(null);
    }
  };

  const sendInvite = async () => {
    const id = normaliseUserId(inviteValue.trim(), serverName);
    if (!isValidUserId(id)) {
      toast.error("Enter a user id like @name:server");
      return;
    }
    setBusy("invite");
    try {
      await client.invite(room.roomId, id);
      toast.success(`Invited ${id}`);
      setInviteValue("");
      setInviting(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not invite");
    } finally {
      setBusy(null);
    }
  };

  const saveName = async () => {
    const next = nameDraft.trim();
    if (!next || next === summary.name) {
      setEditingName(false);
      return;
    }
    setBusy("name");
    try {
      await client.setRoomName(room.roomId, next);
      setEditingName(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not rename");
    } finally {
      setBusy(null);
    }
  };

  const onNameKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") void saveName();
    if (event.key === "Escape") {
      setNameDraft(summary.name);
      setEditingName(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(roomPermalink(room));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title={isDm ? "Details" : "Channel details"} subtitle={roomLabel(summary)} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* About */}
        <section className="border-b border-grey-80 px-4 py-4 dark:border-black-300">
          <div className="flex items-start gap-3">
            {isDm && summary.dmUserId ? (
              <UserAvatar client={client} seed={summary.dmUserId} avatarMxc={summary.avatarMxc} size={40} />
            ) : (
              <span className="flex size-10 items-center justify-center rounded-md bg-grey-90 text-grey-60 dark:bg-black-500 dark:text-grey-dark-700">
                {summary.encrypted ? <Lock className="size-5" aria-hidden /> : <Hash className="size-5" aria-hidden />}
              </span>
            )}
            <div className="min-w-0 flex-1">
              {editingName ? (
                <input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={onNameKey}
                  onBlur={() => void saveName()}
                  autoFocus
                  aria-label="Channel name"
                  className={FIELD}
                />
              ) : (
                <div className="flex items-center gap-1">
                  <h3 className="truncate text-base font-semibold text-grey-10 dark:text-grey-light-100">{roomLabel(summary)}</h3>
                  {canRename ? (
                    <button
                      type="button"
                      onClick={() => {
                        setNameDraft(summary.name);
                        setEditingName(true);
                      }}
                      aria-label="Rename channel"
                      className="text-grey-60 hover:text-grey-10 dark:text-grey-dark-700 dark:hover:text-grey-light-100"
                    >
                      <Pencil className="size-3.5" aria-hidden />
                    </button>
                  ) : null}
                </div>
              )}
              <p className="mt-0.5 text-xs text-grey-60 dark:text-grey-dark-700">
                {isDm
                  ? summary.dmUserId
                  : `${summary.isPublic ? "Public" : "Private"} · ${summary.encrypted ? "end-to-end encrypted" : "not encrypted"} · ${summary.memberCount} ${summary.memberCount === 1 ? "member" : "members"}`}
              </p>
            </div>
          </div>
          {summary.topic ? <p className="mt-3 whitespace-pre-wrap break-words text-sm text-grey-10 dark:text-grey-light-100">{summary.topic}</p> : null}
          {!isDm ? (
            <button type="button" onClick={() => void copyLink()} className="mt-3 inline-flex items-center gap-1.5 text-xs text-primary-50 hover:underline dark:text-primary-40">
              {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
              {copied ? "Link copied" : "Copy channel link"}
            </button>
          ) : null}
        </section>

        {/* Notifications */}
        <section className="border-b border-grey-80 dark:border-black-300">
          <div className={cn(ROW, "cursor-default hover:bg-transparent dark:hover:bg-transparent")}>
            {summary.muted ? <BellOff className="size-4 text-grey-60 dark:text-grey-dark-700" aria-hidden /> : <Bell className="size-4 text-grey-60 dark:text-grey-dark-700" aria-hidden />}
            <span className="flex-1">
              Notifications
              <span className="block text-xs text-grey-60 dark:text-grey-dark-700">{summary.muted ? "Muted — no badges or alerts" : "On"}</span>
            </span>
            <ToggleSwitch checked={!summary.muted} onChange={(on) => void toggleMute(!on)} disabled={busy === "mute"} ariaLabel="Notifications" />
          </div>
        </section>

        {/* Members */}
        <section className="border-b border-grey-80 py-2 dark:border-black-300">
          <div className="flex items-center gap-2 px-4 pb-2">
            <h4 className="flex-1 text-xs font-semibold uppercase tracking-wide text-grey-60 dark:text-grey-dark-700">Members · {members.length}</h4>
            {canInvite ? (
              <button
                type="button"
                onClick={() => setInviting((v) => !v)}
                className="inline-flex items-center gap-1 text-xs text-primary-50 hover:underline dark:text-primary-40"
              >
                <UserPlus className="size-3.5" aria-hidden />
                Add people
              </button>
            ) : null}
          </div>
          {inviting ? (
            <div className="flex gap-2 px-4 pb-2">
              <input
                value={inviteValue}
                onChange={(e) => setInviteValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void sendInvite()}
                placeholder={`@name:${serverName}`}
                aria-label="User to invite"
                autoFocus
                className={FIELD}
              />
              <button
                type="button"
                onClick={() => void sendInvite()}
                disabled={busy === "invite" || !inviteValue.trim()}
                className="shrink-0 rounded-md bg-primary-50 px-3 text-sm font-medium text-white disabled:opacity-50 dark:bg-primary-40 dark:text-white"
              >
                Invite
              </button>
            </div>
          ) : null}
          {members.length > 8 ? (
            <div className="relative px-4 pb-2">
              <Search className="pointer-events-none absolute left-6 top-1/2 size-3.5 -translate-y-[calc(50%+4px)] text-grey-60 dark:text-grey-dark-700" aria-hidden />
              <input
                value={memberQuery}
                onChange={(e) => setMemberQuery(e.target.value)}
                placeholder="Find members"
                aria-label="Find members"
                className={cn(FIELD, "pl-7")}
              />
            </div>
          ) : null}
          <ul>
            {filtered.map((member) => {
              const info = presence(member.userId);
              return (
                <li key={member.userId}>
                  <button type="button" className={ROW} onClick={() => setRightPanel({ kind: "member", roomId: room.roomId, userId: member.userId })}>
                    <UserAvatar client={client} seed={member.userId} avatarMxc={member.getMxcAvatarUrl() ?? null} size={28} presence={info.state} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {member.name}
                        {member.userId === me ? <span className="ml-1 text-xs font-normal text-grey-60 dark:text-grey-dark-700">(you)</span> : null}
                      </span>
                      <span className="block truncate text-xs text-grey-60 dark:text-grey-dark-700">{presenceLabel(info)}</span>
                    </span>
                    {member.powerLevel >= 100 ? (
                      <span className="rounded bg-grey-90 px-1.5 py-0.5 text-[10px] font-medium uppercase text-grey-60 dark:bg-black-500 dark:text-grey-dark-700">Admin</span>
                    ) : member.powerLevel >= 50 ? (
                      <span className="rounded bg-grey-90 px-1.5 py-0.5 text-[10px] font-medium uppercase text-grey-60 dark:bg-black-500 dark:text-grey-dark-700">Mod</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 ? <li className="px-4 py-3 text-sm text-grey-60 dark:text-grey-dark-700">No members match.</li> : null}
          </ul>
          {invited.length > 0 ? (
            <>
              <h4 className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-grey-60 dark:text-grey-dark-700">Invited · {invited.length}</h4>
              <ul>
                {invited.map((member) => (
                  <li key={member.userId} className={cn(ROW, "cursor-default opacity-70 hover:bg-transparent dark:hover:bg-transparent")}>
                    <UserAvatar client={client} seed={member.userId} avatarMxc={member.getMxcAvatarUrl() ?? null} size={28} />
                    <span className="min-w-0 flex-1 truncate">{member.name}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>

        {/* Leave */}
        <section className="py-2">
          <button type="button" onClick={() => void leave()} disabled={busy === "leave"} className={cn(ROW, "text-error-50 dark:text-error-50")}>
            <LogOut className="size-4" aria-hidden />
            {isDm ? "Close conversation" : "Leave channel"}
          </button>
        </section>
      </div>
    </div>
  );
}
