"use client";

import { useMemo } from "react";
import { ClientEvent, type MatrixClient, RoomEvent, RoomStateEvent } from "matrix-js-sdk";

import { useClientTick } from "@/components/chat/hooks/useClientTick";
import { type RoomBuckets, summariseRooms, totalUnread } from "@/lib/chat/rooms";

const ROOM_LIST_EVENTS = [
  ClientEvent.Room,
  ClientEvent.DeleteRoom,
  ClientEvent.AccountData,
  ClientEvent.Sync,
  RoomEvent.Name,
  RoomEvent.Timeline,
  RoomEvent.Receipt,
  RoomEvent.MyMembership,
  RoomEvent.UnreadNotifications,
  RoomEvent.Tags,
  RoomStateEvent.Events,
] as const;

/** Sidebar buckets, recomputed when anything room-shaped changes. */
export function useRoomList(client: MatrixClient): RoomBuckets & { unread: number; highlight: number } {
  const tick = useClientTick(client, ROOM_LIST_EVENTS);
  return useMemo(() => {
    const buckets = summariseRooms(client);
    return { ...buckets, ...totalUnread(buckets) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tick]);
}
