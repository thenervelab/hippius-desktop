"use client";

import { useEffect, useMemo, useState } from "react";
import { ClientEvent, type MatrixClient, type Room, RoomEvent, RoomStateEvent } from "matrix-js-sdk";

import { useClientTick } from "@/components/chat/hooks/useClientTick";
import { type RoomSummary, directRoomMap, summariseRoom } from "@/lib/chat/rooms";

const ROOM_EVENTS = [
  ClientEvent.Room,
  RoomEvent.Name,
  RoomEvent.MyMembership,
  RoomEvent.UnreadNotifications,
  RoomStateEvent.Events,
  RoomStateEvent.Members,
] as const;

/** The `Room` for an id, following the client when it appears later. */
export function useRoom(client: MatrixClient, roomId: string | null): Room | null {
  const [room, setRoom] = useState<Room | null>(() => (roomId ? client.getRoom(roomId) : null));

  useEffect(() => {
    setRoom(roomId ? client.getRoom(roomId) : null);
    if (!roomId) return;
    const onRoom = (candidate: Room) => {
      if (candidate.roomId === roomId) setRoom(candidate);
    };
    client.on(ClientEvent.Room, onRoom);
    return () => {
      client.off(ClientEvent.Room, onRoom);
    };
  }, [client, roomId]);

  return room;
}

/** Live summary (name, topic, counts) for the open room. */
export function useRoomSummary(client: MatrixClient, room: Room | null): RoomSummary | null {
  const tick = useClientTick(client, ROOM_EVENTS);
  return useMemo(
    () => (room ? summariseRoom(client, room, directRoomMap(client)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, room, tick],
  );
}
