"use client";

import { useCallback, useMemo, useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import { ClientEvent, type MatrixClient, RoomEvent, ThreadEvent } from "matrix-js-sdk";
import { Bell, BellOff, Check, CheckCheck, Link2, LogOut, MessageSquare, PenSquare, Search, X } from "lucide-react";
import { toast } from "sonner";

import { newMessageOpenAtom, rightPanelAtom, selectedRoomIdAtom, sidebarDrawerOpenAtom } from "@/components/chat/chat-ui-atoms";
import { useClientTick } from "@/components/chat/hooks/useClientTick";
import { usePresence } from "@/components/chat/hooks/usePresence";
import { useRoomList } from "@/components/chat/hooks/useRoomList";
import RoomListItem from "@/components/chat/RoomListItem";
import SidebarSection from "@/components/chat/SidebarSection";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { markRoomRead, type RoomSummary, roomPermalink, setRoomMuted } from "@/lib/chat/rooms";
import { participatingThreads } from "@/lib/chat/threads";
import { cn } from "@/lib/utils";

interface ChatSidebarProps {
  client: MatrixClient;
  className?: string;
}

const THREAD_EVENTS = [ClientEvent.Room, RoomEvent.Timeline, RoomEvent.Receipt, ThreadEvent.Update, ThreadEvent.NewReply] as const;

/** Case-insensitive substring match on the room name; an empty filter keeps everything. */
export function filterRooms<T extends Pick<RoomSummary, "name">>(rooms: T[], filter: string): T[] {
  const q = filter.trim().toLowerCase();
  if (!q) return rooms;
  return rooms.filter((r) => r.name.toLowerCase().includes(q));
}

/**
 * Left column: who is signed in, a filter box, then Invitations, Channels,
 * Direct messages and Threads. Every row opens a room; right-click opens
 * the room menu: mute, mark read, copy link, leave.
 *
 * Deliberately flatter than the console's sidebar: no workspace rail,
 * categories or channel creation — the desktop joins what the account
 * already belongs to, and those are managed from the console.
 */
export default function ChatSidebar({ client, className }: ChatSidebarProps) {
  const { channels, dms, invites } = useRoomList(client);
  const [selectedRoomId, setSelectedRoomId] = useAtom(selectedRoomIdAtom);
  const setRightPanel = useSetAtom(rightPanelAtom);
  const setDrawerOpen = useSetAtom(sidebarDrawerOpenAtom);
  const setNewMessageOpen = useSetAtom(newMessageOpenAtom);
  const [filter, setFilter] = useState("");

  const myUserId = client.getUserId() ?? "";
  const myProfile = client.getUser(myUserId);
  const dmUserIds = useMemo(() => dms.map((d) => d.dmUserId).filter((id): id is string => Boolean(id)), [dms]);
  const presenceOf = usePresence(client, [myUserId, ...dmUserIds]);

  const threadTick = useClientTick(client, THREAD_EVENTS);
  const threads = useMemo(
    () => participatingThreads(client, true).slice(0, 20),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, threadTick],
  );

  const [menu, setMenu] = useState<{ roomId: string; point: { x: number; y: number } } | null>(null);
  const [pendingInvite, setPendingInvite] = useState<string | null>(null);

  const selectRoom = useCallback(
    (roomId: string) => {
      setSelectedRoomId(roomId);
      setRightPanel(null);
      setDrawerOpen(false);
    },
    [setDrawerOpen, setRightPanel, setSelectedRoomId],
  );

  const openContextMenu = useCallback((roomId: string, point: { x: number; y: number }) => setMenu({ roomId, point }), []);

  const menuRoom = menu ? client.getRoom(menu.roomId) : null;
  const menuSummary = menu ? [...channels, ...dms].find((r) => r.id === menu.roomId) : undefined;

  const respondToInvite = async (roomId: string, accept: boolean) => {
    setPendingInvite(roomId);
    try {
      if (accept) {
        await client.joinRoom(roomId);
        selectRoom(roomId);
      } else {
        await client.leave(roomId);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not respond to the invite");
    } finally {
      setPendingInvite(null);
    }
  };

  const leaveRoom = () => {
    if (!menuRoom || !menuSummary) return;
    client
      .leave(menuRoom.roomId)
      .then(() => {
        if (selectedRoomId === menuRoom.roomId) setSelectedRoomId(null);
        toast.success(menuSummary.kind === "dm" ? "Conversation closed" : `Left #${menuSummary.name}`);
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Could not leave the room"));
  };

  const visibleChannels = filterRooms(channels, filter);
  const visibleDms = filterRooms(dms, filter);
  const unreadThreadCount = threads.reduce((sum, t) => sum + t.unread, 0);
  const unread = [...channels, ...dms].reduce((n, r) => n + (r.muted ? 0 : r.unread), 0);

  const roomRow = (room: RoomSummary) => (
    <RoomListItem
      key={room.id}
      client={client}
      room={room}
      selected={room.id === selectedRoomId}
      presence={room.kind === "dm" && room.dmUserId ? presenceOf(room.dmUserId).state : undefined}
      onSelect={selectRoom}
      onContextMenu={openContextMenu}
    />
  );

  return (
    <nav
      aria-label="Chat navigation"
      className={cn(
        "flex h-full w-60 shrink-0 flex-col border-r border-grey-80 bg-grey-light-600 dark:border-black-300 dark:bg-black-primary-bg",
        className,
      )}
    >
      <div className="flex h-12 items-center gap-1 border-b border-grey-80 px-2 dark:border-black-300">
        <span className="min-w-0 flex-1 px-1">
          <span className="block truncate text-sm font-semibold leading-tight text-grey-10 dark:text-grey-light-100">Team chat</span>
          <span className="block truncate text-[11px] leading-tight text-grey-60 dark:text-grey-dark-700">
            {myProfile?.displayName ?? myUserId}
          </span>
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-grey-60 hover:text-grey-10 dark:text-grey-dark-700 dark:hover:text-grey-light-100"
          aria-label="New message"
          onClick={() => setNewMessageOpen(true)}
        >
          <PenSquare className="size-4" aria-hidden />
        </Button>
      </div>

      <div className="px-3 py-2">
        <label className="flex h-8 w-full items-center gap-2 rounded-md border border-grey-80 bg-white px-2 text-xs text-grey-60 transition-colors focus-within:ring-2 focus-within:ring-primary-50 hover:border-grey-70 dark:border-black-300 dark:bg-black-300 dark:text-grey-dark-700 dark:hover:border-grey-dark-500 dark:focus-within:ring-primary-40">
          <Search className="size-3.5 shrink-0" aria-hidden />
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter conversations"
            aria-label="Filter conversations"
            className="min-w-0 flex-1 bg-transparent text-xs text-grey-10 outline-none placeholder:text-grey-60 dark:text-grey-light-100 dark:placeholder:text-grey-dark-700"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {invites.length > 0 ? (
          <SidebarSection id="invites" title="Invitations" collapsedBadge={invites.length}>
            {invites.map((invite) => (
              <div key={invite.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-grey-10 dark:text-grey-light-100">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{invite.kind === "dm" ? invite.name : `#${invite.name}`}</p>
                  {invite.inviterId ? (
                    <p className="truncate text-[11px] text-grey-60 dark:text-grey-dark-700">
                      from {client.getUser(invite.inviterId)?.displayName ?? invite.inviterId}
                    </p>
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-success-50 dark:text-success-40"
                  aria-label={`Accept invitation to ${invite.name}`}
                  loading={pendingInvite === invite.id}
                  onClick={() => respondToInvite(invite.id, true)}
                >
                  <Check className="size-4" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-grey-60 dark:text-grey-dark-700"
                  aria-label={`Decline invitation to ${invite.name}`}
                  disabled={pendingInvite === invite.id}
                  onClick={() => respondToInvite(invite.id, false)}
                >
                  <X className="size-4" aria-hidden />
                </Button>
              </div>
            ))}
          </SidebarSection>
        ) : null}

        <SidebarSection id="channels" title="Channels" collapsedBadge={channels.reduce((n, r) => n + (r.muted ? 0 : r.highlight), 0)}>
          {channels.length === 0 ? (
            <p className="px-2 py-1 text-xs text-grey-60 dark:text-grey-dark-700">No channels yet. Channels you are invited to appear here.</p>
          ) : visibleChannels.length === 0 ? (
            <p className="px-2 py-1 text-xs text-grey-60 dark:text-grey-dark-700">No channel matches.</p>
          ) : (
            visibleChannels.map(roomRow)
          )}
        </SidebarSection>

        <SidebarSection
          id="dms"
          title="Direct messages"
          collapsedBadge={dms.reduce((n, r) => n + (r.muted ? 0 : r.unread), 0)}
          onAdd={() => setNewMessageOpen(true)}
          addLabel="New message"
        >
          {dms.length === 0 ? (
            <p className="px-2 py-1 text-xs text-grey-60 dark:text-grey-dark-700">No direct messages yet.</p>
          ) : visibleDms.length === 0 ? (
            <p className="px-2 py-1 text-xs text-grey-60 dark:text-grey-dark-700">No conversation matches.</p>
          ) : (
            visibleDms.map(roomRow)
          )}
          <button
            type="button"
            onClick={() => setNewMessageOpen(true)}
            className="mt-0.5 flex h-7 items-center gap-2 rounded-md px-2 text-left text-xs text-grey-60 outline-none hover:bg-grey-90 hover:text-grey-10 focus-visible:ring-2 focus-visible:ring-primary-50 dark:text-grey-dark-700 dark:hover:bg-black-500 dark:hover:text-grey-light-100 dark:focus-visible:ring-primary-40"
          >
            <span className="inline-flex size-4 items-center justify-center rounded bg-grey-90 text-[11px] dark:bg-black-500">+</span>
            New message
          </button>
        </SidebarSection>

        {threads.length > 0 ? (
          <SidebarSection id="threads" title="Threads" collapsedBadge={unreadThreadCount}>
            {threads.map((thread) => (
              <button
                key={`${thread.roomId}:${thread.rootEventId}`}
                type="button"
                onClick={() => {
                  setSelectedRoomId(thread.roomId);
                  setRightPanel({ kind: "thread", roomId: thread.roomId, rootEventId: thread.rootEventId });
                  setDrawerOpen(false);
                }}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-grey-90 focus-visible:ring-2 focus-visible:ring-primary-50 dark:hover:bg-black-500 dark:focus-visible:ring-primary-40"
              >
                <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-grey-60 dark:text-grey-dark-700" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold text-grey-10 dark:text-grey-light-100">#{thread.roomName}</span>
                  <span className="block truncate text-xs text-grey-60 dark:text-grey-dark-700">{thread.rootPreview || "Thread"}</span>
                </span>
                <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-error-50 px-1.5 text-[11px] font-semibold text-white dark:bg-error-40">
                  {thread.unread > 99 ? "99+" : thread.unread}
                </span>
              </button>
            ))}
          </SidebarSection>
        ) : null}
      </div>

      <div className="border-t border-grey-80 px-3 py-2 text-[11px] text-grey-60 dark:border-black-300 dark:text-grey-dark-700">
        {unread > 0 ? `${unread} unread` : "All caught up"}
      </div>

      {/* One room menu, anchored where the user right-clicked: the trigger is a
          zero-size fixed element at that point. */}
      <DropdownMenu open={Boolean(menu)} onOpenChange={(open) => (!open ? setMenu(null) : undefined)}>
        <DropdownMenuTrigger asChild>
          <span aria-hidden className="fixed size-0" style={{ left: menu?.point.x ?? 0, top: menu?.point.y ?? 0 }} />
        </DropdownMenuTrigger>
        {menuRoom && menuSummary ? (
          <DropdownMenuContent align="start" aria-label="Room options">
            <DropdownMenuItem
              onSelect={() =>
                setRoomMuted(client, menuRoom.roomId, !menuSummary.muted).catch((error: unknown) =>
                  toast.error(error instanceof Error ? error.message : "Could not update notifications"),
                )
              }
            >
              {menuSummary.muted ? <Bell className="mr-2 size-4" aria-hidden /> : <BellOff className="mr-2 size-4" aria-hidden />}
              {menuSummary.muted ? "Unmute" : "Mute"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                markRoomRead(client, menuRoom).catch((error: unknown) =>
                  toast.error(error instanceof Error ? error.message : "Could not mark as read"),
                )
              }
            >
              <CheckCheck className="mr-2 size-4" aria-hidden />
              Mark as read
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                navigator.clipboard
                  .writeText(roomPermalink(menuRoom))
                  .then(() => toast.success("Link copied"))
                  .catch(() => toast.error("Could not copy the link"))
              }
            >
              <Link2 className="mr-2 size-4" aria-hidden />
              Copy link
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-error-50 focus:text-error-50 dark:text-error-40" onSelect={leaveRoom}>
              <LogOut className="mr-2 size-4" aria-hidden />
              {menuSummary.kind === "dm" ? "Close conversation" : "Leave channel"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        ) : null}
      </DropdownMenu>
    </nav>
  );
}
