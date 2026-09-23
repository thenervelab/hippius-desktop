"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useAtom, useAtomValue } from "jotai";
import { KnownMembership, type MatrixClient } from "matrix-js-sdk";

import { activeWorkspaceIdAtom, chatCommunitySpaceAliasAtom } from "@/components/chat/chat-ui-atoms";
import { useRoomList } from "@/components/chat/hooks/useRoomList";
import type { RoomSummary } from "@/lib/chat/rooms";
import {
  type WorkspaceBadge,
  type WorkspaceChannelGroups,
  type WorkspaceInvite,
  type WorkspaceSummary,
  groupChannelsByWorkspace,
  isSpaceRoom,
  joinNewCategories,
  listWorkspaces,
  spaceChildren,
  workspaceBadges,
} from "@/lib/chat/spaces";
import { loadActiveWorkspace, resolveActiveWorkspace, saveActiveWorkspace } from "@/lib/chat/workspace-store";

const NO_GROUPS: WorkspaceChannelGroups = { uncategorised: [], categories: [] };

export interface WorkspacesState {
  workspaces: WorkspaceSummary[];
  /** Pending Space invitations. */
  invites: WorkspaceInvite[];
  /** Space id -> channels in Space order (uncategorised first, then category by category). */
  byWorkspace: Map<string, RoomSummary[]>;
  /** Space id -> the same channels split by category. */
  groupsByWorkspace: Map<string, WorkspaceChannelGroups>;
  /** Joined channels that belong to no workspace we are in. */
  orphans: RoomSummary[];
  badges: Map<string, WorkspaceBadge>;
  /** The active workspace, once resolved; null with zero workspaces. */
  active: WorkspaceSummary | null;
  activeWorkspaceId: string | null;
  /** Channels of the active workspace, flat. */
  channels: RoomSummary[];
  /** Channels of the active workspace, by category. */
  groups: WorkspaceChannelGroups;
  /** Direct messages: the account's, not a workspace's. */
  dms: RoomSummary[];
  /** Room invites (channels and DMs), not Space invites. */
  roomInvites: RoomSummary[];
  setActiveWorkspaceId: (spaceId: string) => void;
}

/**
 * Workspaces derived from the room list, plus the active one. The active
 * id lives in a Jotai atom so the rail, sidebar and shortcuts share it; this
 * hook reconciles it with what is actually joined (a left or deleted
 * workspace falls back to the first) and persists it per account.
 *
 * Ported from the console's `hooks/useWorkspaces.ts`; the community alias
 * comes from the Rust-provided config rather than a constant.
 */
export function useWorkspaces(client: MatrixClient): WorkspacesState {
  const { channels: allChannels, dms, invites: roomInvites } = useRoomList(client);
  const [activeWorkspaceId, setActiveAtom] = useAtom(activeWorkspaceIdAtom);
  const communitySpaceAlias = useAtomValue(chatCommunitySpaceAliasAtom);
  const me = client.getUserId() ?? "";

  const derived = useMemo(() => {
    const { workspaces, invites } = listWorkspaces(client, communitySpaceAlias);
    const { byWorkspace, groupsByWorkspace, orphans } = groupChannelsByWorkspace(client, allChannels);
    return { workspaces, invites, byWorkspace, groupsByWorkspace, orphans, badges: workspaceBadges(byWorkspace) };
    // `allChannels` is a fresh array every time the room list ticks, so it
    // is the dependency that carries "something room-shaped changed".
  }, [client, allChannels, communitySpaceAlias]);

  // Reconcile: remembered -> first -> null.
  useEffect(() => {
    const next = resolveActiveWorkspace(activeWorkspaceId ?? loadActiveWorkspace(me), derived.workspaces);
    if (next !== activeWorkspaceId) setActiveAtom(next);
  }, [derived.workspaces, activeWorkspaceId, me, setActiveAtom]);

  const setActiveWorkspaceId = useCallback(
    (spaceId: string) => {
      saveActiveWorkspace(me, spaceId);
      setActiveAtom(spaceId);
    },
    [me, setActiveAtom],
  );

  const active = derived.workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const channels = active ? (derived.byWorkspace.get(active.id) ?? []) : [];
  const groups = active ? (derived.groupsByWorkspace.get(active.id) ?? NO_GROUPS) : NO_GROUPS;

  // Categories another admin added since we joined: the workspace links a
  // child we have no room for (or a Space we are only invited to). Ask the
  // server once per change of that set and join the Spaces among them, so
  // they can group the sidebar.
  const unknownChildren = useMemo(() => {
    const space = active ? client.getRoom(active.id) : null;
    if (!space) return "";
    return spaceChildren(space, (id) => id)
      .filter((c) => {
        const room = client.getRoom(c.roomId);
        return !room || (isSpaceRoom(room) && room.getMyMembership() === KnownMembership.Invite);
      })
      .map((c) => c.roomId)
      .join("|");
    // `allChannels` ticks with the room list, which is what tells us a child appeared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, active, allChannels]);
  useEffect(() => {
    const space = active && unknownChildren ? client.getRoom(active.id) : null;
    if (!space) return;
    joinNewCategories(client, space).catch(() => {
      // Offline or no /hierarchy: the channels still work, ungrouped.
    });
  }, [client, active, unknownChildren]);

  return {
    ...derived,
    active,
    activeWorkspaceId: active?.id ?? null,
    channels,
    groups,
    dms,
    roomInvites,
    setActiveWorkspaceId,
  };
}
