"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAtom } from "jotai";
import { type MatrixClient, SyncState } from "matrix-js-sdk";
import { WifiOff } from "lucide-react";

import { rightPanelAtom, selectedRoomIdAtom, sidebarDrawerOpenAtom } from "@/components/chat/chat-ui-atoms";
import { useChat } from "@/components/chat/ChatProvider";
import ChatSidebar from "@/components/chat/ChatSidebar";
import EncryptionBanner from "@/components/chat/EncryptionBanner";
import CreateChannelDialog from "@/components/chat/CreateChannelDialog";
import { useWorkspaces } from "@/components/chat/hooks/useWorkspaces";
import MoveChannelDialog from "@/components/chat/MoveChannelDialog";
import NewMessageDialog from "@/components/chat/NewMessageDialog";
import RightPanelContent from "@/components/chat/RightPanel";
import RoomView from "@/components/chat/RoomView";
import SidePanel from "@/components/chat/SidePanel";
import CreateWorkspaceDialog from "@/components/chat/workspaces/CreateWorkspaceDialog";
import InvitePeopleDialog from "@/components/chat/workspaces/InvitePeopleDialog";
import JoinWorkspaceDialog from "@/components/chat/workspaces/JoinWorkspaceDialog";
import WorkspaceOnboarding from "@/components/chat/workspaces/WorkspaceOnboarding";
import WorkspaceRail from "@/components/chat/workspaces/WorkspaceRail";
import NoEntriesFound from "@/components/ui/NoEntriesFound";
import { subscribeToRoom } from "@/lib/chat/client";
import { LG_MEDIA_QUERY, useMediaQuery } from "@/lib/hooks/useMediaQuery";

/**
 * The connected chat surface: workspace rail, sidebar, room view, optional
 * right panel, plus the dialogs. Room selection lives in a Jotai atom so
 * the sidebar, headers and thread links can all drive it. Mirrors the
 * console's `ChatShell`.
 */
export default function ChatShell({ client }: { client: MatrixClient }) {
  const { connection, encryption, syncState, unlockEncryption, repairEncryption } = useChat();
  const [selectedRoomId, setSelectedRoomId] = useAtom(selectedRoomIdAtom);
  const [rightPanel, setRightPanel] = useAtom(rightPanelAtom);
  const [drawerOpen, setDrawerOpen] = useAtom(sidebarDrawerOpenAtom);

  // Above `lg` the sidebar and the right panel are static columns; below
  // (the window can go down to 900px, minus the app's own sidebar), they are
  // slide-in sheets. Decided here, once, so a sheet is never mounted on a
  // wide layout: an open Radix Dialog traps focus and locks scrolling even
  // when its content is display:none.
  const wide = useMediaQuery(LG_MEDIA_QUERY);
  const workspaces = useWorkspaces(client);
  const { workspaces: workspaceList, invites: spaceInvites, badges, byWorkspace, active, activeWorkspaceId, channels, dms, orphans } = workspaces;

  // Slack remembers where you were in each workspace; switching back lands
  // you there rather than on #general again.
  const lastRoomByWorkspace = useRef(new Map<string, string>());
  useEffect(() => {
    if (activeWorkspaceId && selectedRoomId && channels.some((c) => c.id === selectedRoomId)) {
      lastRoomByWorkspace.current.set(activeWorkspaceId, selectedRoomId);
    }
  }, [activeWorkspaceId, selectedRoomId, channels]);

  const selectWorkspace = useCallback(
    (spaceId: string) => {
      if (spaceId === activeWorkspaceId) return;
      workspaces.setActiveWorkspaceId(spaceId);
      const rooms = byWorkspace.get(spaceId) ?? [];
      const remembered = lastRoomByWorkspace.current.get(spaceId);
      const next = rooms.find((r) => r.id === remembered) ?? rooms[0];
      setSelectedRoomId(next?.id ?? null);
      setRightPanel(null);
    },
    [activeWorkspaceId, byWorkspace, setRightPanel, setSelectedRoomId, workspaces],
  );

  // A room opened from outside the sidebar (notification, thread link)
  // may belong to another workspace: follow it there.
  useEffect(() => {
    if (!selectedRoomId || channels.some((c) => c.id === selectedRoomId) || dms.some((d) => d.id === selectedRoomId)) return;
    for (const [spaceId, rooms] of byWorkspace) {
      if (spaceId !== activeWorkspaceId && rooms.some((r) => r.id === selectedRoomId)) {
        workspaces.setActiveWorkspaceId(spaceId);
        return;
      }
    }
  }, [selectedRoomId, channels, dms, byWorkspace, activeWorkspaceId, workspaces]);

  // Default to the first channel (Slack opens #general) once rooms exist.
  // With no workspace at all the onboarding pane takes the stage instead,
  // even for someone who already has direct messages.
  useEffect(() => {
    if (selectedRoomId || workspaceList.length === 0) return;
    const first = channels[0] ?? dms[0];
    if (first) setSelectedRoomId(first.id);
  }, [channels, dms, selectedRoomId, setSelectedRoomId, workspaceList.length]);

  // Stream the open room's full timeline through sliding sync.
  useEffect(() => {
    if (connection.kind !== "ready") return;
    subscribeToRoom(connection.handle, selectedRoomId);
  }, [connection, selectedRoomId]);

  // Announce ourselves online once syncing (presence is polled, see presence.ts).
  useEffect(() => {
    if (syncState === SyncState.Syncing || syncState === SyncState.Prepared) {
      client.setPresence({ presence: "online" }).catch(() => undefined);
    }
  }, [client, syncState]);

  // The drawer is only for narrow layouts: close it if the viewport grows.
  useEffect(() => {
    if (wide) setDrawerOpen(false);
  }, [wide, setDrawerOpen]);

  const offline = syncState === SyncState.Error || syncState === SyncState.Reconnecting;
  const hasRooms = channels.length + dms.length + orphans.length > 0;

  const rail = useMemo(
    () => (
      <WorkspaceRail
        client={client}
        workspaces={workspaceList}
        invites={spaceInvites}
        badges={badges}
        activeWorkspaceId={activeWorkspaceId}
        onSelect={selectWorkspace}
      />
    ),
    [activeWorkspaceId, badges, client, selectWorkspace, spaceInvites, workspaceList],
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col bg-white dark:bg-black-primary-bg">
      {offline ? (
        <div
          role="status"
          className="flex items-center gap-2 border-b border-warning-50/40 bg-warning-50/10 px-4 py-1.5 text-xs text-grey-10 dark:border-warning-50/50 dark:bg-warning-50/20 dark:text-grey-light-100"
        >
          <WifiOff className="size-3.5 shrink-0 text-warning-50 dark:text-warning-50" aria-hidden />
          <span className="flex-1">
            {syncState === SyncState.Reconnecting ? "Reconnecting…" : "You’re offline. Messages will send when the connection is back."}
          </span>
        </div>
      ) : null}
      <EncryptionBanner encryption={encryption} onUnlock={unlockEncryption} onRepair={repairEncryption} />

      <div className="flex min-h-0 flex-1">
        {wide ? (
          <>
            {rail}
            <ChatSidebar client={client} workspaces={workspaces} />
          </>
        ) : (
          <SidePanel side="left" open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Navigation">
            <div className="flex h-full min-h-0">
              {rail}
              {/* The rail is fixed-width; the sidebar takes what is left, not the whole drawer. */}
              <ChatSidebar client={client} workspaces={workspaces} className="w-auto min-w-0 flex-1 shrink border-r-0" />
            </div>
          </SidePanel>
        )}

        <main className="flex min-w-0 flex-1 flex-col" aria-label="Conversation">
          {workspaceList.length === 0 && !selectedRoomId ? (
            // Nobody belongs to anything at account creation; the chat opens
            // on the choice. A DM or orphan channel still opens if selected.
            <WorkspaceOnboarding
              client={client}
              workspaces={workspaces}
              // On a wide layout the sidebar is already next to this pane. On
              // a narrow one it lives in a drawer whose only opener is a room
              // header, and no room is open: offer the drawer from here.
              onOpenConversations={!wide && hasRooms ? () => setDrawerOpen(true) : undefined}
            />
          ) : selectedRoomId ? (
            <RoomView key={selectedRoomId} client={client} roomId={selectedRoomId} />
          ) : !wide ? (
            // Narrow, nothing open: the only way into the drawer is a room
            // header's menu button, which does not exist yet. Show the
            // navigation itself as the page.
            <div className="flex min-h-0 flex-1">
              {rail}
              <ChatSidebar client={client} workspaces={workspaces} className="w-auto min-w-0 flex-1 shrink border-r-0" />
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6">
              <NoEntriesFound
                title={hasRooms ? "Pick a conversation" : active ? "No channels yet" : "No conversations yet"}
                description={
                  hasRooms
                    ? "Choose a channel or a person from the sidebar."
                    : active
                      ? `Create a channel in ${active.name} or start a direct message.`
                      : "Create a channel or start a direct message to get going."
                }
                className="max-w-md"
              />
            </div>
          )}
        </main>

        {wide ? (
          rightPanel ? (
            <aside className="flex w-[360px] shrink-0 flex-col border-l border-grey-80 dark:border-black-300" aria-label="Details">
              <RightPanelContent client={client} />
            </aside>
          ) : null
        ) : (
          <SidePanel side="right" open={Boolean(rightPanel)} onClose={() => setRightPanel(null)} title="Details">
            <RightPanelContent client={client} />
          </SidePanel>
        )}
      </div>

      <NewMessageDialog client={client} />
      <CreateChannelDialog client={client} workspaces={workspaces} />
      <MoveChannelDialog client={client} workspaces={workspaces} />
      <CreateWorkspaceDialog client={client} workspaces={workspaces} />
      <JoinWorkspaceDialog client={client} workspaces={workspaces} />
      <InvitePeopleDialog client={client} workspaces={workspaces} />
    </div>
  );
}
