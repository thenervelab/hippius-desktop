"use client";

import { useEffect } from "react";
import { useAtom } from "jotai";
import { type MatrixClient, SyncState } from "matrix-js-sdk";
import { WifiOff } from "lucide-react";

import { rightPanelAtom, selectedRoomIdAtom, sidebarDrawerOpenAtom } from "@/components/chat/chat-ui-atoms";
import { useChat } from "@/components/chat/ChatProvider";
import ChatSidebar from "@/components/chat/ChatSidebar";
import EncryptionBanner from "@/components/chat/EncryptionBanner";
import { useRoomList } from "@/components/chat/hooks/useRoomList";
import NewMessageDialog from "@/components/chat/NewMessageDialog";
import RightPanelContent from "@/components/chat/RightPanel";
import RoomView from "@/components/chat/RoomView";
import SidePanel from "@/components/chat/SidePanel";
import NoEntriesFound from "@/components/ui/NoEntriesFound";
import { subscribeToRoom } from "@/lib/chat/client";
import { LG_MEDIA_QUERY, useMediaQuery } from "@/lib/hooks/useMediaQuery";

/**
 * The connected chat surface: sidebar, room view, optional right panel,
 * plus the "New message" dialog. Room selection lives in a Jotai atom so
 * the sidebar, headers and thread links can all drive it.
 */
export default function ChatShell({ client }: { client: MatrixClient }) {
  const { connection, encryption, syncState, unlockEncryption, repairEncryption } = useChat();
  const [selectedRoomId, setSelectedRoomId] = useAtom(selectedRoomIdAtom);
  const [rightPanel, setRightPanel] = useAtom(rightPanelAtom);
  const [drawerOpen, setDrawerOpen] = useAtom(sidebarDrawerOpenAtom);
  const { channels, dms } = useRoomList(client);

  // Above `lg` the sidebar and the right panel are static columns; below
  // (the window can go down to 900px, minus the app's own sidebar), they are
  // slide-in sheets. Decided here, once, so a sheet is never mounted on a
  // wide layout: an open Radix Dialog traps focus and locks scrolling even
  // when its content is display:none.
  const wide = useMediaQuery(LG_MEDIA_QUERY);

  // Default to the first channel once rooms exist.
  useEffect(() => {
    if (selectedRoomId) return;
    const first = channels[0] ?? dms[0];
    if (first) setSelectedRoomId(first.id);
  }, [channels, dms, selectedRoomId, setSelectedRoomId]);

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
  const hasRooms = channels.length + dms.length > 0;

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
          <ChatSidebar client={client} />
        ) : (
          <SidePanel side="left" open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Navigation">
            <ChatSidebar client={client} className="w-full border-r-0" />
          </SidePanel>
        )}

        <main className="flex min-w-0 flex-1 flex-col" aria-label="Conversation">
          {selectedRoomId ? (
            <RoomView key={selectedRoomId} client={client} roomId={selectedRoomId} />
          ) : !wide ? (
            // Narrow, nothing open: the only way into the drawer is a room
            // header's menu button, which does not exist yet. Show the
            // navigation itself as the page.
            <ChatSidebar client={client} className="w-full border-r-0" />
          ) : (
            <div className="flex flex-1 items-center justify-center p-6">
              <NoEntriesFound
                title={hasRooms ? "Pick a conversation" : "No conversations yet"}
                description={
                  hasRooms
                    ? "Choose a channel or a person from the sidebar."
                    : "Start a direct message, or accept an invitation, to get going."
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
    </div>
  );
}
