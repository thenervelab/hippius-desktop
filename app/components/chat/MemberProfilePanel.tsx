"use client";

import { useEffect, useState } from "react";
import { useSetAtom } from "jotai";
import { type MatrixClient, type Room, RoomMemberEvent, RoomStateEvent } from "matrix-js-sdk";
import { Check, Copy, MessageSquare, UserMinus } from "lucide-react";
import { toast } from "sonner";

import { rightPanelAtom, selectedRoomIdAtom } from "@/components/chat/chat-ui-atoms";
import { useClientTick } from "@/components/chat/hooks/useClientTick";
import { usePresence } from "@/components/chat/hooks/usePresence";
import PanelHeader from "@/components/chat/PanelHeader";
import UserAvatar from "@/components/chat/UserAvatar";
import { presenceLabel } from "@/lib/chat/presence";
import { type RoomSummary, openDirectRoom } from "@/lib/chat/rooms";

interface MemberProfilePanelProps {
  client: MatrixClient;
  room: Room;
  summary: RoomSummary;
  userId: string;
}

const ACTION =
  "inline-flex items-center gap-2 rounded-md border border-grey-80 px-3 py-1.5 text-sm font-medium text-grey-10 hover:bg-grey-light-600 disabled:opacity-50 dark:border-black-500 dark:text-grey-light-100 dark:hover:bg-black-primary-bg";

/** Right column: one person — avatar, presence, message, remove. */
export default function MemberProfilePanel({ client, room, summary, userId }: MemberProfilePanelProps) {
  const setRightPanel = useSetAtom(rightPanelAtom);
  const setSelectedRoomId = useSetAtom(selectedRoomIdAtom);
  useClientTick(client, [RoomStateEvent.Members, RoomMemberEvent.Name]);
  const presence = usePresence(client, [userId]);
  const info = presence(userId);
  const me = client.getUserId();
  const member = room.getMember(userId);
  const [profile, setProfile] = useState<{ displayname?: string; avatar_url?: string } | null>(null);
  const [busy, setBusy] = useState<"dm" | "kick" | null>(null);
  const [copied, setCopied] = useState(false);

  // Members not in this room (e.g. a mention of someone who left) still get a profile.
  useEffect(() => {
    if (member) return;
    let cancelled = false;
    client
      .getProfileInfo(userId)
      .then((p) => !cancelled && setProfile(p))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, userId, member]);

  const displayName = member?.name ?? profile?.displayname ?? userId;
  const avatarMxc = member?.getMxcAvatarUrl() ?? profile?.avatar_url ?? null;
  const canKick = Boolean(member) && userId !== me && room.currentState.hasSufficientPowerLevelFor("kick", room.getMember(me ?? "")?.powerLevel ?? 0);

  const startDm = async () => {
    setBusy("dm");
    try {
      setSelectedRoomId(await openDirectRoom(client, userId));
      setRightPanel(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open a conversation");
    } finally {
      setBusy(null);
    }
  };

  const kick = async () => {
    if (!window.confirm(`Remove ${displayName} from #${summary.name}?`)) return;
    setBusy("kick");
    try {
      await client.kick(room.roomId, userId);
      setRightPanel({ kind: "details", roomId: room.roomId });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove");
    } finally {
      setBusy(null);
    }
  };

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(userId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title="Profile" onBack={() => setRightPanel({ kind: "details", roomId: room.roomId })} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div className="flex flex-col items-center text-center">
          <UserAvatar client={client} seed={userId} avatarMxc={avatarMxc} size={96} presence={info.state} />
          <h3 className="mt-3 text-lg font-semibold text-grey-10 dark:text-grey-light-100">{displayName}</h3>
          <button type="button" onClick={() => void copyId()} className="mt-0.5 inline-flex items-center gap-1 font-mono text-xs text-grey-60 hover:text-grey-10 dark:text-grey-dark-700 dark:hover:text-grey-light-100">
            {userId}
            {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
          </button>
          <p className="mt-2 text-sm text-grey-60 dark:text-grey-dark-700">
            {presenceLabel(info)}
            {info.statusMsg ? ` · ${info.statusMsg}` : ""}
          </p>
          {member && member.powerLevel >= 50 ? (
            <span className="mt-2 rounded bg-grey-90 px-2 py-0.5 text-[10px] font-medium uppercase text-grey-60 dark:bg-black-500 dark:text-grey-dark-700">
              {member.powerLevel >= 100 ? "Admin" : "Moderator"}
            </span>
          ) : null}
          {!member ? <p className="mt-2 text-xs text-grey-60 dark:text-grey-dark-700">Not in this channel</p> : null}
        </div>

        {userId !== me ? (
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <button type="button" onClick={() => void startDm()} disabled={busy === "dm"} className={ACTION}>
              <MessageSquare className="size-4" aria-hidden />
              Message
            </button>
            {canKick ? (
              <button type="button" onClick={() => void kick()} disabled={busy === "kick"} className={`${ACTION} text-error-50 dark:text-error-50`}>
                <UserMinus className="size-4" aria-hidden />
                Remove from channel
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
