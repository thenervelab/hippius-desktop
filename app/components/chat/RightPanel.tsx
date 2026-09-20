"use client";

import { useAtomValue } from "jotai";
import type { MatrixClient } from "matrix-js-sdk";

import { rightPanelAtom } from "@/components/chat/chat-ui-atoms";
import { useRoom, useRoomSummary } from "@/components/chat/hooks/useRoom";
import MemberProfilePanel from "@/components/chat/MemberProfilePanel";
import PanelHeader from "@/components/chat/PanelHeader";
import RoomDetailsPanel from "@/components/chat/RoomDetailsPanel";
import ThreadPanel from "@/components/chat/ThreadPanel";

/** Right column: thread, room details or a member profile. */
export default function RightPanelContent({ client }: { client: MatrixClient }) {
  const panel = useAtomValue(rightPanelAtom);
  const room = useRoom(client, panel?.roomId ?? null);
  const summary = useRoomSummary(client, room);
  if (!panel) return null;
  if (!room || !summary) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PanelHeader title="Details" />
        <p className="px-4 py-10 text-center text-sm text-grey-60 dark:text-grey-dark-700">This conversation is not available.</p>
      </div>
    );
  }
  switch (panel.kind) {
    case "thread":
      return <ThreadPanel key={panel.rootEventId} client={client} room={room} summary={summary} rootEventId={panel.rootEventId} />;
    case "details":
      return <RoomDetailsPanel key={room.roomId} client={client} room={room} summary={summary} />;
    case "member":
      return <MemberProfilePanel key={panel.userId} client={client} room={room} summary={summary} userId={panel.userId} />;
  }
}
