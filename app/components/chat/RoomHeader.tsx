"use client";

import { type KeyboardEvent, useEffect, useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import { EventType, type MatrixClient, type Room } from "matrix-js-sdk";
import { Hash, Info, Lock, Menu, Phone, Search, Users, X } from "lucide-react";
import { toast } from "sonner";

import { rightPanelAtom, sidebarDrawerOpenAtom } from "@/components/chat/chat-ui-atoms";
import { usePresence } from "@/components/chat/hooks/usePresence";
import UserAvatar from "@/components/chat/UserAvatar";
import { Button } from "@/components/ui/button";
import CustomTooltip from "@/components/chat/ChatTooltip";
import type { RoomSummary } from "@/lib/chat/rooms";
import { presenceLabel } from "@/lib/chat/presence";
import { cn } from "@/lib/utils";

interface RoomHeaderProps {
  client: MatrixClient;
  room: Room;
  summary: RoomSummary;
  /** Current in-room search query; `null` when the search field is closed. */
  searchQuery: string | null;
  onSearchChange: (query: string | null) => void;
}

/** Can the current user change the topic? (power level for m.room.topic) */
export function canEditTopic(client: MatrixClient, room: Room): boolean {
  const me = client.getUserId();
  if (!me) return false;
  return room.currentState.maySendStateEvent(EventType.RoomTopic, me);
}

/**
 * Room header: `#name` (or the DM partner with presence), topic (click to
 * edit when allowed), member count -> details panel, in-room search, and
 * a disabled call button until calls ship.
 */
export default function RoomHeader({ client, room, summary, searchQuery, onSearchChange }: RoomHeaderProps) {
  const [panel, setRightPanel] = useAtom(rightPanelAtom);
  const setDrawerOpen = useSetAtom(sidebarDrawerOpenAtom);
  const presenceOf = usePresence(client, summary.dmUserId ? [summary.dmUserId] : []);

  const [editingTopic, setEditingTopic] = useState(false);
  const [topicDraft, setTopicDraft] = useState(summary.topic ?? "");
  const [savingTopic, setSavingTopic] = useState(false);
  const editable = canEditTopic(client, room);

  useEffect(() => {
    if (!editingTopic) setTopicDraft(summary.topic ?? "");
  }, [summary.topic, editingTopic]);

  const saveTopic = async () => {
    const next = topicDraft.trim();
    setEditingTopic(false);
    if (next === (summary.topic ?? "")) return;
    setSavingTopic(true);
    try {
      await client.setRoomTopic(room.roomId, next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update the topic");
    } finally {
      setSavingTopic(false);
    }
  };

  const onTopicKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveTopic();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setTopicDraft(summary.topic ?? "");
      setEditingTopic(false);
    }
  };

  const detailsOpen = panel?.kind === "details" && panel.roomId === room.roomId;
  const toggleDetails = () =>
    setRightPanel(detailsOpen ? null : { kind: "details", roomId: room.roomId });

  const iconButton =
    "size-8 text-grey-60 hover:text-grey-10 dark:text-grey-dark-700 dark:hover:text-grey-light-100";

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-grey-80 px-3 dark:border-black-300">
      <Button
        variant="ghost"
        size="icon"
        className={cn(iconButton, "lg:hidden")}
        aria-label="Open navigation"
        onClick={() => setDrawerOpen(true)}
      >
        <Menu className="size-4" aria-hidden />
      </Button>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        {summary.kind === "dm" && summary.dmUserId ? (
          <UserAvatar
            client={client}
            seed={summary.dmUserId}
            avatarMxc={summary.avatarMxc}
            size={24}
            presence={presenceOf(summary.dmUserId).state}
          />
        ) : summary.isPublic ? (
          <Hash className="size-4 shrink-0 text-grey-60 dark:text-grey-dark-700" aria-hidden />
        ) : (
          <Lock className="size-4 shrink-0 text-grey-60 dark:text-grey-dark-700" aria-hidden />
        )}
        <div className="min-w-0">
          <button
            type="button"
            onClick={toggleDetails}
            className="block max-w-full truncate text-left text-sm font-semibold text-grey-10 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary-50 dark:text-grey-light-100 dark:focus-visible:ring-primary-40"
            aria-label={`${summary.kind === "dm" ? "" : "#"}${summary.name}, open details`}
          >
            {summary.name}
          </button>
          {summary.kind === "dm" && summary.dmUserId ? (
            <p className="truncate text-[11px] leading-tight text-grey-60 dark:text-grey-dark-700">
              {presenceLabel(presenceOf(summary.dmUserId))}
            </p>
          ) : editingTopic ? (
            <input
              autoFocus
              value={topicDraft}
              onChange={(e) => setTopicDraft(e.target.value)}
              onBlur={() => void saveTopic()}
              onKeyDown={onTopicKeyDown}
              maxLength={250}
              aria-label="Channel topic"
              className="w-full max-w-md bg-transparent text-[11px] leading-tight text-grey-10 outline-none placeholder:text-grey-60 dark:text-grey-light-100 dark:placeholder:text-grey-dark-700"
              placeholder="Add a topic"
            />
          ) : (
            <button
              type="button"
              disabled={!editable || savingTopic}
              onClick={() => setEditingTopic(true)}
              title={editable ? "Edit topic" : undefined}
              className={cn(
                "block max-w-full truncate text-left text-[11px] leading-tight text-grey-60 outline-none dark:text-grey-dark-700",
                editable && "hover:text-grey-10 hover:underline focus-visible:ring-2 focus-visible:ring-primary-50 dark:hover:text-grey-light-100 dark:focus-visible:ring-primary-40",
                !editable && "cursor-default",
              )}
            >
              {savingTopic ? "Saving…" : summary.topic ?? (editable ? "Add a topic" : "No topic")}
            </button>
          )}
        </div>
      </div>

      {searchQuery !== null ? (
        <div className="flex h-8 w-64 max-w-[45%] items-center gap-1 rounded-md border border-grey-80 bg-white px-2 dark:border-black-300 dark:bg-black-300">
          <Search className="size-3.5 shrink-0 text-grey-60 dark:text-grey-dark-700" aria-hidden />
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onSearchChange(null);
            }}
            placeholder="Search in this conversation"
            aria-label="Search in this conversation"
            className="min-w-0 flex-1 bg-transparent text-xs text-grey-10 outline-none placeholder:text-grey-60 dark:text-grey-light-100 dark:placeholder:text-grey-dark-700"
          />
          <button
            type="button"
            onClick={() => onSearchChange(null)}
            aria-label="Close search"
            className="text-grey-60 hover:text-grey-10 dark:text-grey-dark-700 dark:hover:text-grey-light-100"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className={iconButton}
          aria-label="Search in this conversation"
          onClick={() => onSearchChange("")}
        >
          <Search className="size-4" aria-hidden />
        </Button>
      )}

      {summary.kind !== "dm" ? (
        <button
          type="button"
          onClick={toggleDetails}
          aria-label={`${summary.memberCount} members, open member list`}
          className={cn(
            "inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary-50 dark:focus-visible:ring-primary-40",
            detailsOpen
              ? "bg-grey-90 text-grey-10 dark:bg-black-500 dark:text-grey-light-100"
              : "text-grey-60 hover:bg-grey-90 hover:text-grey-10 dark:text-grey-dark-700 dark:hover:bg-black-500 dark:hover:text-grey-light-100",
          )}
        >
          <Users className="size-4" aria-hidden />
          <span>{summary.memberCount}</span>
        </button>
      ) : null}

      <CustomTooltip tooltipContent="Calls arrive with Phase 1.7" side="bottom" asChild>
        <span className="inline-flex">
          <Button variant="ghost" size="icon" className={iconButton} aria-label="Start a call (coming soon)" disabled>
            <Phone className="size-4" aria-hidden />
          </Button>
        </span>
      </CustomTooltip>

      <Button
        variant="ghost"
        size="icon"
        className={cn(iconButton, detailsOpen && "bg-grey-90 text-grey-10 dark:bg-black-500 dark:text-grey-light-100")}
        aria-label={detailsOpen ? "Close details" : "Open details"}
        aria-pressed={detailsOpen}
        onClick={toggleDetails}
      >
        <Info className="size-4" aria-hidden />
      </Button>
    </header>
  );
}
