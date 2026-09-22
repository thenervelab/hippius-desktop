"use client";

import { useCallback, useMemo, useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import {
  ClientEvent,
  type MatrixClient,
  RoomEvent,
  ThreadEvent,
} from "matrix-js-sdk";
import {
  Bell,
  BellOff,
  Check,
  CheckCheck,
  ChevronDown,
  FolderInput,
  FolderPlus,
  Hash,
  Link2,
  LogOut,
  MessageSquare,
  PenSquare,
  Search,
  Settings,
  UserPlus,
  X,
} from "lucide-react";
import { toast } from "sonner";

import {
  chatSettingsOpenAtom,
  commandPaletteOpenAtom,
  createChannelCategoryAtom,
  createChannelOpenAtom,
  invitePeopleOpenAtom,
  moveChannelAtom,
  newMessageOpenAtom,
  rightPanelAtom,
  selectedRoomIdAtom,
  sidebarDrawerOpenAtom,
  type WorkspaceSettingsTab,
  workspaceSettingsAtom,
} from "@/components/chat/chat-ui-atoms";
import CategorySection from "@/components/chat/CategorySection";
import ChatAccountMenu from "@/components/chat/ChatAccountMenu";
import ChatMenu, { type ChatMenuItem } from "@/components/chat/ChatMenu";
import { useClientTick } from "@/components/chat/hooks/useClientTick";
import { useCollapsedCategories } from "@/components/chat/hooks/useCollapsedCategories";
import { useJoinableChannels } from "@/components/chat/hooks/useJoinableChannels";
import { usePresence } from "@/components/chat/hooks/usePresence";
import type { WorkspacesState } from "@/components/chat/hooks/useWorkspaces";
import RoomListItem from "@/components/chat/RoomListItem";
import SidebarSection from "@/components/chat/SidebarSection";
import WorkspaceAvatar from "@/components/chat/workspaces/WorkspaceAvatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  markRoomRead,
  type RoomSummary,
  roomPermalink,
  setRoomMuted,
} from "@/lib/chat/rooms";
import type {
  CategoryChannels,
  JoinableChannel,
  WorkspaceSummary,
} from "@/lib/chat/spaces";
import { participatingThreads } from "@/lib/chat/threads";
import { cn } from "@/lib/utils";
import { isMacPlatform } from "@/lib/utils/isMacPlatform";

interface ChatSidebarProps {
  client: MatrixClient;
  /** Shared with the rail and the shell; see `useWorkspaces`. */
  workspaces: WorkspacesState;
  className?: string;
}

const THREAD_EVENTS = [
  ClientEvent.Room,
  RoomEvent.Timeline,
  RoomEvent.Receipt,
  ThreadEvent.Update,
  ThreadEvent.NewReply,
] as const;

/** Case-insensitive substring match on the room name; an empty filter keeps everything. */
export function filterRooms<T extends Pick<RoomSummary, "name">>(
  rooms: T[],
  filter: string,
): T[] {
  const q = filter.trim().toLowerCase();
  if (!q) return rooms;
  return rooms.filter((r) => r.name.toLowerCase().includes(q));
}

/**
 * The workspace menu off the sidebar header: invite, settings (read-only
 * "details" for a plain member) and the one way to leave — through the
 * settings dialog's danger zone, which owns the confirmation and the
 * sole-owner check.
 */
export function workspaceMenu(
  active: Pick<WorkspaceSummary, "myRole">,
  actions: {
    invite: () => void;
    openSettings: (tab: WorkspaceSettingsTab) => void;
  },
): readonly (ChatMenuItem | "separator")[] {
  const canManage = active.myRole !== "member";
  return [
    {
      key: "invite",
      label: "Invite people",
      icon: UserPlus,
      onSelect: actions.invite,
    },
    {
      key: "settings",
      label: canManage ? "Workspace settings" : "Workspace details",
      icon: Settings,
      onSelect: () => actions.openSettings("general"),
    },
    "separator",
    {
      key: "leave",
      label: "Leave workspace",
      icon: LogOut,
      destructive: true,
      onSelect: () => actions.openSettings("danger"),
    },
  ];
}

/**
 * Left column: the active workspace's header, a filter box, then
 * Invitations, the workspace's Channels (uncategorised first, then each
 * category as a folding group, with the workspace's channels we can still
 * join listed under the joined ones), Other channels (outside any
 * workspace we are in), Direct messages (the account's, shared across
 * workspaces) and Threads. Every row opens a room; right-click opens the
 * room menu: mute, mark read, copy link, move to category, leave. Mirrors
 * the console's `ChatSidebar`.
 *
 * While the filter box has text, the Channels section flattens to the
 * matching rows: a filter is a search, not a place to browse categories.
 */
export default function ChatSidebar({
  client,
  workspaces,
  className,
}: ChatSidebarProps) {
  const {
    active,
    channels,
    groups,
    orphans,
    dms,
    roomInvites: invites,
  } = workspaces;
  const [selectedRoomId, setSelectedRoomId] = useAtom(selectedRoomIdAtom);
  const setRightPanel = useSetAtom(rightPanelAtom);
  const setDrawerOpen = useSetAtom(sidebarDrawerOpenAtom);
  const setNewMessageOpen = useSetAtom(newMessageOpenAtom);
  const setPaletteOpen = useSetAtom(commandPaletteOpenAtom);
  const setCreateChannelOpen = useSetAtom(createChannelOpenAtom);
  const setCreateChannelCategory = useSetAtom(createChannelCategoryAtom);
  const setMoveChannel = useSetAtom(moveChannelAtom);
  const setInviteOpen = useSetAtom(invitePeopleOpenAtom);
  const setSettingsOpen = useSetAtom(chatSettingsOpenAtom);
  const setWorkspaceSettings = useSetAtom(workspaceSettingsAtom);
  const [filter, setFilter] = useState("");

  const workspaceMenuItems = useMemo(
    () =>
      active
        ? workspaceMenu(active, {
            invite: () => setInviteOpen(true),
            openSettings: setWorkspaceSettings,
          })
        : [],
    [active, setInviteOpen, setWorkspaceSettings],
  );

  const myUserId = client.getUserId() ?? "";
  const folded = useCollapsedCategories(myUserId, active?.id ?? null);
  const openCreateChannel = useCallback(
    (categoryId: string | null) => {
      setCreateChannelCategory(categoryId);
      setCreateChannelOpen(true);
    },
    [setCreateChannelCategory, setCreateChannelOpen],
  );
  const myProfile = client.getUser(myUserId);
  const dmUserIds = useMemo(
    () => dms.map((d) => d.dmUserId).filter((id): id is string => Boolean(id)),
    [dms],
  );
  const presenceOf = usePresence(client, [myUserId, ...dmUserIds]);

  const threadTick = useClientTick(client, THREAD_EVENTS);
  const visibleRoomIds = useMemo(
    () => new Set([...channels, ...orphans, ...dms].map((r) => r.id)),
    [channels, orphans, dms],
  );
  const threads = useMemo(
    () =>
      participatingThreads(client, true)
        .filter((t) => visibleRoomIds.has(t.roomId))
        .slice(0, 20),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, threadTick, visibleRoomIds],
  );

  const [menu, setMenu] = useState<{
    roomId: string;
    point: { x: number; y: number };
  } | null>(null);
  const [pendingInvite, setPendingInvite] = useState<string | null>(null);

  // Channels of the workspace we are not in: listed under the joined ones so
  // a channel someone else created can be found and joined from here.
  const joinable = useJoinableChannels(client, active?.id ?? null);
  const [joining, setJoining] = useState<string | null>(null);

  const selectRoom = useCallback(
    (roomId: string) => {
      setSelectedRoomId(roomId);
      setRightPanel(null);
      setDrawerOpen(false);
    },
    [setDrawerOpen, setRightPanel, setSelectedRoomId],
  );

  const openContextMenu = useCallback(
    (roomId: string, point: { x: number; y: number }) =>
      setMenu({ roomId, point }),
    [],
  );

  const menuRoom = menu ? client.getRoom(menu.roomId) : null;
  const menuSummary = menu
    ? [...channels, ...orphans, ...dms].find((r) => r.id === menu.roomId)
    : undefined;

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
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not respond to the invite",
      );
    } finally {
      setPendingInvite(null);
    }
  };

  const joinChannel = async (channel: JoinableChannel) => {
    setJoining(channel.roomId);
    try {
      await client.joinRoom(channel.roomId, { viaServers: channel.via });
      selectRoom(channel.roomId);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : `Could not join #${channel.name}`,
      );
    } finally {
      setJoining(null);
    }
  };

  const leaveRoom = () => {
    if (!menuRoom || !menuSummary) return;
    client
      .leave(menuRoom.roomId)
      .then(() => {
        if (selectedRoomId === menuRoom.roomId) setSelectedRoomId(null);
        toast.success(
          menuSummary.kind === "dm"
            ? "Conversation closed"
            : `Left #${menuSummary.name}`,
        );
      })
      .catch((error: unknown) =>
        toast.error(
          error instanceof Error ? error.message : "Could not leave the room",
        ),
      );
  };

  const visibleChannels = filterRooms(channels, filter);
  const visibleOrphans = filterRooms(orphans, filter);
  const visibleDms = filterRooms(dms, filter);
  const unreadThreadCount = threads.reduce((sum, t) => sum + t.unread, 0);
  const unread = [...channels, ...orphans, ...dms].reduce(
    (n, r) => n + (r.muted ? 0 : r.unread),
    0,
  );

  const roomRow = (room: RoomSummary) => (
    <RoomListItem
      key={room.id}
      client={client}
      room={room}
      selected={room.id === selectedRoomId}
      presence={
        room.kind === "dm" && room.dmUserId
          ? presenceOf(room.dmUserId).state
          : undefined
      }
      onSelect={selectRoom}
      onContextMenu={openContextMenu}
    />
  );

  const filtering = filter.trim().length > 0;
  const joinableIn = (categoryId: string | null) =>
    joinable.channels.filter((c) => c.categoryId === categoryId);
  const joinableRow = (channel: JoinableChannel) => (
    <li key={channel.roomId}>
      <button
        type="button"
        onClick={() => joinChannel(channel)}
        disabled={joining !== null}
        aria-label={`Join #${channel.name}`}
        title={channel.topic ?? undefined}
        className="group flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-grey-60 outline-none transition-colors hover:bg-grey-90 hover:text-grey-10 focus-visible:ring-2 focus-visible:ring-primary-50 disabled:opacity-60 dark:text-grey-dark-700 dark:hover:bg-black-500 dark:hover:text-grey-light-100 dark:focus-visible:ring-primary-40"
      >
        <Hash className="size-4 shrink-0 opacity-70" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{channel.name}</span>
        <span className="ml-auto shrink-0 text-[11px] font-medium text-primary-50 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 dark:text-primary-40">
          {joining === channel.roomId ? "Joining…" : "Join"}
        </span>
      </button>
    </li>
  );
  const joinableList = (
    list: JoinableChannel[],
    label: string,
    divider: boolean,
  ) =>
    list.length > 0 ? (
      <ul
        aria-label={label}
        className={cn(
          divider &&
            "mt-1 border-t border-grey-80/70 pt-1 dark:border-black-300",
        )}
      >
        {list.map(joinableRow)}
      </ul>
    ) : null;
  const categoryBlock = (category: CategoryChannels) => {
    const collapsed = folded.isCollapsed(category.id);
    const live = category.channels.filter((c) => !c.muted);
    return (
      <CategorySection
        key={category.id}
        id={category.id}
        name={category.name}
        collapsed={collapsed}
        onToggle={() => folded.toggle(category.id)}
        highlight={live.reduce((n, c) => n + c.highlight, 0)}
        unread={live.reduce((n, c) => n + c.unread, 0)}
        onAdd={
          active?.canCreateChannels
            ? () => openCreateChannel(category.id)
            : undefined
        }
      >
        {category.channels.map(roomRow)}
        {joinableList(
          joinableIn(category.id),
          `Channels in ${category.name} you can join`,
          false,
        )}
      </CategorySection>
    );
  };
  const noChannels =
    channels.length === 0 &&
    joinable.channels.length === 0 &&
    groups.categories.length === 0;

  return (
    <nav
      aria-label="Chat navigation"
      className={cn(
        "flex h-full w-60 shrink-0 flex-col border-r border-grey-80 bg-grey-light-600 dark:border-black-300 dark:bg-black-primary-bg",
        className,
      )}
    >
      {/* Workspace header: the active workspace's mark and name; the
          account's own controls sit on the right. */}
      <div className="flex h-12 items-center gap-1 border-b border-grey-80 px-2 dark:border-black-300">
        {active ? (
          <ChatMenu
            align="start"
            label={active.name}
            items={workspaceMenuItems}
            trigger={
              <button
                type="button"
                aria-label={`${active.name} menu`}
                data-testid="chat-workspace-header"
                className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left outline-none hover:bg-grey-90 focus-visible:ring-2 focus-visible:ring-primary-50 dark:hover:bg-black-300 dark:focus-visible:ring-primary-40"
              >
                <WorkspaceAvatar
                  client={client}
                  name={active.name}
                  avatarMxc={active.avatarMxc}
                  size={24}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold leading-tight text-grey-10 dark:text-grey-light-100">
                    {active.name}
                  </span>
                  <span className="block truncate text-[11px] leading-tight text-grey-60 dark:text-grey-dark-700">
                    {myProfile?.displayName ?? myUserId}
                  </span>
                </span>
                <ChevronDown
                  className="size-3.5 shrink-0 text-grey-60 dark:text-grey-dark-700"
                  aria-hidden
                />
              </button>
            }
          />
        ) : (
          <span
            className="flex min-w-0 flex-1 items-center gap-2 px-1"
            data-testid="chat-workspace-header"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold leading-tight text-grey-10 dark:text-grey-light-100">
                Hippius
              </span>
              <span className="block truncate text-[11px] leading-tight text-grey-60 dark:text-grey-dark-700">
                {myProfile?.displayName ?? myUserId}
              </span>
            </span>
          </span>
        )}
        <ChatAccountMenu
          client={client}
          extraItems={[
            {
              key: "preferences",
              label: "Preferences",
              icon: Settings,
              onSelect: () => setSettingsOpen("account"),
            },
          ]}
        />
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

      <div className="flex items-center gap-2 px-3 py-2">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-grey-80 bg-white px-2 text-xs text-grey-60 transition-colors focus-within:ring-2 focus-within:ring-primary-50 hover:border-grey-70 dark:border-black-300 dark:bg-black-300 dark:text-grey-dark-700 dark:hover:border-grey-dark-500 dark:focus-within:ring-primary-40">
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
        {/* Jump anywhere (rooms across workspaces, people, actions) -> command palette */}
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          aria-label="Jump to a channel or person"
          aria-keyshortcuts="Meta+K Control+K"
          title="Jump to…"
          className="flex h-8 shrink-0 items-center rounded-md border border-grey-80 bg-white px-1.5 font-sans text-[10px] text-grey-60 outline-none transition-colors hover:border-grey-70 hover:text-grey-10 focus-visible:ring-2 focus-visible:ring-primary-50 dark:border-black-300 dark:bg-black-300 dark:text-grey-dark-700 dark:hover:border-grey-dark-500 dark:hover:text-grey-light-100 dark:focus-visible:ring-primary-40"
        >
          <kbd>{isMacPlatform() ? "⌘K" : "Ctrl K"}</kbd>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {invites.length > 0 ? (
          <SidebarSection
            id="invites"
            title="Invitations"
            collapsedBadge={invites.length}
          >
            {invites.map((invite) => (
              <div
                key={invite.id}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-grey-10 dark:text-grey-light-100"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {invite.kind === "dm" ? invite.name : `#${invite.name}`}
                  </p>
                  {invite.inviterId ? (
                    <p className="truncate text-[11px] text-grey-60 dark:text-grey-dark-700">
                      from{" "}
                      {client.getUser(invite.inviterId)?.displayName ??
                        invite.inviterId}
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

        {active && !filter ? (
          <button
            type="button"
            onClick={() => setInviteOpen(true)}
            className="mx-2 mb-1 flex h-8 w-[calc(100%-1rem)] items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-grey-30 outline-none hover:bg-grey-90 hover:text-grey-10 focus-visible:ring-2 focus-visible:ring-primary-50 dark:text-grey-dark-200 dark:hover:bg-black-500 dark:hover:text-grey-light-100 dark:focus-visible:ring-primary-40"
          >
            <UserPlus
              className="size-4 shrink-0 text-grey-60 dark:text-grey-dark-700"
              aria-hidden
            />
            <span className="truncate">Invite people to {active.name}</span>
          </button>
        ) : null}

        <SidebarSection
          id="channels"
          title="Channels"
          collapsedBadge={channels.reduce(
            (n, r) => n + (r.muted ? 0 : r.highlight),
            0,
          )}
          onAdd={
            active?.canCreateChannels
              ? () => openCreateChannel(null)
              : undefined
          }
          addLabel="New channel"
        >
          {!active ? (
            <p className="px-2 py-1 text-xs text-grey-60 dark:text-grey-dark-700">
              Create or join a workspace to get channels.
            </p>
          ) : filtering ? (
            visibleChannels.length === 0 ? (
              <p className="px-2 py-1 text-xs text-grey-60 dark:text-grey-dark-700">
                No channel matches.
              </p>
            ) : (
              visibleChannels.map(roomRow)
            )
          ) : noChannels ? (
            <p className="px-2 py-1 text-xs text-grey-60 dark:text-grey-dark-700">
              {joinable.loading
                ? "Loading channels…"
                : active.canCreateChannels
                  ? "No channels yet. Create one to get your team talking."
                  : "No channels yet. Channels you are invited to appear here."}
            </p>
          ) : (
            <>
              {groups.uncategorised.map(roomRow)}
              {joinableList(
                joinableIn(null),
                `Channels in ${active.name} you can join`,
                groups.uncategorised.length > 0,
              )}
              {groups.categories.map(categoryBlock)}
            </>
          )}
          {active?.canCreateChannels && !filtering ? (
            <button
              type="button"
              onClick={() => openCreateChannel(null)}
              className="mt-0.5 flex h-7 items-center gap-2 rounded-md px-2 text-left text-xs text-grey-60 outline-none hover:bg-grey-90 hover:text-grey-10 focus-visible:ring-2 focus-visible:ring-primary-50 dark:text-grey-dark-700 dark:hover:bg-black-500 dark:hover:text-grey-light-100 dark:focus-visible:ring-primary-40"
            >
              <span className="inline-flex size-4 items-center justify-center rounded bg-grey-90 text-[11px] dark:bg-black-500">
                +
              </span>
              New channel
            </button>
          ) : null}
          {active && active.myRole !== "member" && !filtering ? (
            <button
              type="button"
              onClick={() => setWorkspaceSettings("channels")}
              className="flex h-7 items-center gap-2 rounded-md px-2 text-left text-xs text-grey-60 outline-none hover:bg-grey-90 hover:text-grey-10 focus-visible:ring-2 focus-visible:ring-primary-50 dark:text-grey-dark-700 dark:hover:bg-black-500 dark:hover:text-grey-light-100 dark:focus-visible:ring-primary-40"
            >
              <FolderPlus className="size-4 shrink-0" aria-hidden />
              {groups.categories.length > 0
                ? "Manage categories"
                : "New category"}
            </button>
          ) : null}
        </SidebarSection>

        {/* Channels that belong to no workspace we are in (created before
            workspaces existed, or whose Space we left). Kept reachable. */}
        {visibleOrphans.length > 0 ? (
          <SidebarSection
            id="other-channels"
            title="Other channels"
            collapsedBadge={orphans.reduce(
              (n, r) => n + (r.muted ? 0 : r.highlight),
              0,
            )}
          >
            {visibleOrphans.map(roomRow)}
          </SidebarSection>
        ) : null}

        <SidebarSection
          id="dms"
          title="Direct messages"
          collapsedBadge={dms.reduce((n, r) => n + (r.muted ? 0 : r.unread), 0)}
          onAdd={() => setNewMessageOpen(true)}
          addLabel="New message"
        >
          {dms.length === 0 ? (
            <p className="px-2 py-1 text-xs text-grey-60 dark:text-grey-dark-700">
              No direct messages yet.
            </p>
          ) : visibleDms.length === 0 ? (
            <p className="px-2 py-1 text-xs text-grey-60 dark:text-grey-dark-700">
              No conversation matches.
            </p>
          ) : (
            visibleDms.map(roomRow)
          )}
          <button
            type="button"
            onClick={() => setNewMessageOpen(true)}
            className="mt-0.5 flex h-7 items-center gap-2 rounded-md px-2 text-left text-xs text-grey-60 outline-none hover:bg-grey-90 hover:text-grey-10 focus-visible:ring-2 focus-visible:ring-primary-50 dark:text-grey-dark-700 dark:hover:bg-black-500 dark:hover:text-grey-light-100 dark:focus-visible:ring-primary-40"
          >
            <span className="inline-flex size-4 items-center justify-center rounded bg-grey-90 text-[11px] dark:bg-black-500">
              +
            </span>
            New message
          </button>
        </SidebarSection>

        {threads.length > 0 ? (
          <SidebarSection
            id="threads"
            title="Threads"
            collapsedBadge={unreadThreadCount}
          >
            {threads.map((thread) => (
              <button
                key={`${thread.roomId}:${thread.rootEventId}`}
                type="button"
                onClick={() => {
                  setSelectedRoomId(thread.roomId);
                  setRightPanel({
                    kind: "thread",
                    roomId: thread.roomId,
                    rootEventId: thread.rootEventId,
                  });
                  setDrawerOpen(false);
                }}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-grey-90 focus-visible:ring-2 focus-visible:ring-primary-50 dark:hover:bg-black-500 dark:focus-visible:ring-primary-40"
              >
                <MessageSquare
                  className="mt-0.5 size-3.5 shrink-0 text-grey-60 dark:text-grey-dark-700"
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold text-grey-10 dark:text-grey-light-100">
                    #{thread.roomName}
                  </span>
                  <span className="block truncate text-xs text-grey-60 dark:text-grey-dark-700">
                    {thread.rootPreview || "Thread"}
                  </span>
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
      <DropdownMenu
        open={Boolean(menu)}
        onOpenChange={(open) => (!open ? setMenu(null) : undefined)}
      >
        <DropdownMenuTrigger asChild>
          <span
            aria-hidden
            className="fixed size-0"
            style={{ left: menu?.point.x ?? 0, top: menu?.point.y ?? 0 }}
          />
        </DropdownMenuTrigger>
        {menuRoom && menuSummary ? (
          <DropdownMenuContent align="start" aria-label="Room options">
            <DropdownMenuItem
              onSelect={() =>
                setRoomMuted(client, menuRoom.roomId, !menuSummary.muted).catch(
                  (error: unknown) =>
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : "Could not update notifications",
                    ),
                )
              }
            >
              {menuSummary.muted ? (
                <Bell className="mr-2 size-4" aria-hidden />
              ) : (
                <BellOff className="mr-2 size-4" aria-hidden />
              )}
              {menuSummary.muted ? "Unmute" : "Mute"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                markRoomRead(client, menuRoom).catch((error: unknown) =>
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : "Could not mark as read",
                  ),
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
            {/* A channel of the active workspace, for someone who may edit its links. */}
            {active?.canCreateChannels &&
            groups.categories.length > 0 &&
            channels.some((c) => c.id === menuRoom.roomId) ? (
              <DropdownMenuItem
                onSelect={() => setMoveChannel(menuRoom.roomId)}
              >
                <FolderInput className="mr-2 size-4" aria-hidden />
                Move to category…
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-error-50 focus:text-error-50 dark:text-error-40"
              onSelect={leaveRoom}
            >
              <LogOut className="mr-2 size-4" aria-hidden />
              {menuSummary.kind === "dm"
                ? "Close conversation"
                : "Leave channel"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        ) : null}
      </DropdownMenu>
    </nav>
  );
}
