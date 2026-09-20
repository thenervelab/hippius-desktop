"use client";

import { useState } from "react";
import type { MatrixClient, Room } from "matrix-js-sdk";

import ChatSkeleton from "@/components/chat/ChatSkeleton";
import Composer from "@/components/chat/Composer";
import { useRoom, useRoomSummary } from "@/components/chat/hooks/useRoom";
import { useTimeline } from "@/components/chat/hooks/useTimeline";
import MessageList from "@/components/chat/MessageList";
import RoomHeader from "@/components/chat/RoomHeader";
import type { RoomSummary } from "@/lib/chat/rooms";

interface RoomViewProps {
  client: MatrixClient;
  roomId: string;
}

/** Centre column: header, timeline, composer. */
export default function RoomView({ client, roomId }: RoomViewProps) {
  const room = useRoom(client, roomId);
  const summary = useRoomSummary(client, room);

  if (!room || !summary) {
    return (
      <div className="flex flex-1 flex-col">
        <ChatSkeleton />
      </div>
    );
  }
  return <LoadedRoom client={client} room={room} summary={summary} />;
}

function LoadedRoom({ client, room, summary }: { client: MatrixClient; room: Room; summary: RoomSummary }) {
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const timeline = useTimeline(client, room);
  const canPost = room.maySendMessage();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RoomHeader client={client} room={room} summary={summary} searchQuery={searchQuery} onSearchChange={setSearchQuery} />
      <MessageList client={client} room={room} summary={summary} searchQuery={searchQuery} timeline={timeline} />
      {canPost ? (
        <Composer
          client={client}
          room={room}
          events={timeline.events}
          placeholder={summary.kind === "dm" ? `Message ${summary.name}` : `Message #${summary.name}`}
        />
      ) : (
        <p className="shrink-0 border-t border-grey-80 px-4 py-3 text-center text-xs text-grey-60 dark:border-black-300 dark:text-grey-dark-700">
          You don’t have permission to post in this channel.
        </p>
      )}
    </div>
  );
}
