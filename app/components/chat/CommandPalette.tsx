"use client";

import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAtom, useSetAtom } from "jotai";
import type { MatrixClient } from "matrix-js-sdk";
import { Hash, Lock, PenSquare, Plus, Search } from "lucide-react";
import { toast } from "sonner";

import {
  commandPaletteOpenAtom,
  createChannelOpenAtom,
  newMessageOpenAtom,
  rightPanelAtom,
  selectedRoomIdAtom,
  sidebarDrawerOpenAtom,
} from "@/components/chat/chat-ui-atoms";
import {
  dialogContentClassName,
  dialogListClassName,
  dialogListEmptyClassName,
  dialogTitleClassName,
} from "@/components/chat/dialog-styles";
import { useRoomList } from "@/components/chat/hooks/useRoomList";
import UserAvatar from "@/components/chat/UserAvatar";
import FramedDialog from "@/components/ui/FramedDialog";
import {
  inputFieldControlClassName,
  inputFieldShellClassName,
} from "@/components/ui/input";
import {
  type KnownUser,
  type RoomSummary,
  knownUsers,
  openDirectRoom,
} from "@/lib/chat/rooms";
import { errorMessage } from "@/lib/utils/errorUtils";
import { cn } from "@/lib/utils";

type PaletteItem =
  | { kind: "room"; key: string; room: RoomSummary }
  | { kind: "person"; key: string; user: KnownUser }
  | {
      kind: "action";
      key: string;
      label: string;
      icon: "channel" | "message";
      run: () => void;
    };

/** Recently opened rooms, newest first, this app session only. */
const recentRoomIds: string[] = [];
export function rememberRecentRoom(roomId: string): void {
  const i = recentRoomIds.indexOf(roomId);
  if (i >= 0) recentRoomIds.splice(i, 1);
  recentRoomIds.unshift(roomId);
  if (recentRoomIds.length > 8) recentRoomIds.length = 8;
}

/** Test seam: the recency list is module state and would otherwise leak between specs. */
export function resetRecentRoomsForTests(): void {
  recentRoomIds.length = 0;
}

function matches(
  query: string,
  ...haystacks: (string | null | undefined)[]
): boolean {
  const q = query.trim().toLowerCase().replace(/^[#@]/, "");
  if (!q) return true;
  return haystacks.some((h) => h?.toLowerCase().includes(q));
}

/**
 * ⌘/Ctrl+K: jump to a channel or person, or start something new. Filtered
 * by a plain substring match; recent rooms float to the top when the query
 * is empty. Fully keyboard driven: ↑/↓ move, Enter opens, Esc closes.
 */
export default function CommandPalette({ client }: { client: MatrixClient }) {
  const [open, setOpen] = useAtom(commandPaletteOpenAtom);
  const setSelectedRoomId = useSetAtom(selectedRoomIdAtom);
  const setRightPanel = useSetAtom(rightPanelAtom);
  const setDrawerOpen = useSetAtom(sidebarDrawerOpenAtom);
  const setCreateChannelOpen = useSetAtom(createChannelOpenAtom);
  const setNewMessageOpen = useSetAtom(newMessageOpenAtom);
  const { channels, dms } = useRoomList(client);

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const people = useMemo(
    () => (open ? knownUsers(client) : []),
    [client, open],
  );

  const items = useMemo<PaletteItem[]>(() => {
    const rooms = [...channels, ...dms];
    const roomItems: PaletteItem[] = rooms
      .filter((r) => matches(query, r.name, r.topic, r.dmUserId))
      .sort((a, b) => {
        const ra = recentRoomIds.indexOf(a.id);
        const rb = recentRoomIds.indexOf(b.id);
        if (ra !== rb) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
        return b.lastActiveTs - a.lastActiveTs;
      })
      .slice(0, query ? 12 : 8)
      .map((room) => ({ kind: "room", key: `room:${room.id}`, room }));

    const dmUserIds = new Set(dms.map((d) => d.dmUserId));
    const personItems: PaletteItem[] = people
      .filter(
        (u) =>
          !dmUserIds.has(u.userId) && matches(query, u.displayName, u.userId),
      )
      .slice(0, query ? 8 : 3)
      .map((user) => ({ kind: "person", key: `person:${user.userId}`, user }));

    const actions: PaletteItem[] = (
      [
        {
          kind: "action",
          key: "action:new-channel",
          label: "Create a new channel",
          icon: "channel",
          run: () => setCreateChannelOpen(true),
        },
        {
          kind: "action",
          key: "action:new-message",
          label: "Start a new message",
          icon: "message",
          run: () => setNewMessageOpen(true),
        },
      ] satisfies PaletteItem[]
    ).filter((a) => matches(query, a.label));

    return [...roomItems, ...personItems, ...actions];
  }, [channels, dms, people, query, setCreateChannelOpen, setNewMessageOpen]);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(items.length - 1, 0)));
  }, [items.length]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${active}"]`,
    );
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const close = () => setOpen(false);

  const openRoom = (roomId: string) => {
    rememberRecentRoom(roomId);
    setSelectedRoomId(roomId);
    setRightPanel(null);
    setDrawerOpen(false);
    close();
  };

  const run = async (item: PaletteItem) => {
    if (busy) return;
    switch (item.kind) {
      case "room":
        openRoom(item.room.id);
        return;
      case "person":
        setBusy(true);
        try {
          const roomId = await openDirectRoom(client, item.user.userId);
          openRoom(roomId);
        } catch (error) {
          toast.error(errorMessage(error) || "Could not open the conversation");
        } finally {
          setBusy(false);
        }
        return;
      case "action":
        close();
        item.run();
        return;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((a) => (items.length ? (a + 1) % items.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((a) =>
        items.length ? (a - 1 + items.length) % items.length : 0,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = items[active];
      if (item) void run(item);
    }
  };

  return (
    <FramedDialog
      open={open}
      onClose={close}
      title="Jump to"
      icon={<Search className="size-[17px] text-white" aria-hidden />}
      maxWidth="max-w-[600px]"
      contentClassName={dialogContentClassName}
      titleClassName={dialogTitleClassName}
    >
      <div className="mt-4 flex min-h-0 flex-col gap-3 font-geist">
        <div
          className={cn(
            inputFieldShellClassName,
            "min-h-12 items-center px-3 py-2",
          )}
        >
          <Search
            className="size-4 shrink-0 text-grey-60 dark:text-grey-dark-700"
            aria-hidden
          />
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls="chat-palette-list"
            aria-activedescendant={
              items[active] ? `chat-palette-${active}` : undefined
            }
            aria-label="Search channels, people and actions"
            placeholder="Search channels, people…"
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            className={cn(inputFieldControlClassName, "text-sm")}
          />
        </div>

        <ul
          id="chat-palette-list"
          role="listbox"
          aria-label="Jump to"
          ref={listRef}
          className={dialogListClassName}
        >
          {items.length === 0 ? (
            <li className={dialogListEmptyClassName}>
              Nothing matches “{query}”.
            </li>
          ) : (
            items.map((item, index) => (
              <li
                key={item.key}
                id={`chat-palette-${index}`}
                role="option"
                aria-selected={index === active}
                data-index={index}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void run(item)}
                className={cn(
                  "flex h-9 cursor-pointer items-center gap-2 rounded px-2 text-sm",
                  index === active
                    ? "bg-primary-50 text-white dark:bg-primary-50 dark:text-white"
                    : "text-grey-10 dark:text-grey-light-100",
                )}
              >
                <PaletteItemView
                  item={item}
                  client={client}
                  active={index === active}
                />
              </li>
            ))
          )}
        </ul>
        <p className="text-[11px] text-grey-60 dark:text-grey-dark-700">
          ↑↓ to move · Enter to open · Esc to close
        </p>
      </div>
    </FramedDialog>
  );
}

function PaletteItemView({
  item,
  client,
  active,
}: {
  item: PaletteItem;
  client: MatrixClient;
  active: boolean;
}) {
  const muted = active
    ? "text-white/70"
    : "text-grey-60 dark:text-grey-dark-700";
  switch (item.kind) {
    case "room":
      return (
        <>
          {item.room.kind === "dm" ? (
            <UserAvatar
              client={client}
              seed={item.room.dmUserId ?? item.room.id}
              avatarMxc={item.room.avatarMxc}
              size={20}
            />
          ) : item.room.isPublic ? (
            <Hash className="size-4 shrink-0 opacity-70" aria-hidden />
          ) : (
            <Lock className="size-4 shrink-0 opacity-70" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate" title={item.room.name}>
            {item.room.name}
          </span>
          {item.room.topic ? (
            <span
              className={cn(
                "hidden max-w-[45%] truncate text-xs sm:inline",
                muted,
              )}
              title={item.room.topic}
            >
              {item.room.topic}
            </span>
          ) : null}
          {item.room.unread > 0 && !item.room.muted ? (
            <span className={cn("text-xs", muted)}>{item.room.unread} new</span>
          ) : null}
        </>
      );
    case "person":
      return (
        <>
          <UserAvatar
            client={client}
            seed={item.user.userId}
            avatarMxc={item.user.avatarMxc}
            size={20}
          />
          <span
            className="min-w-0 flex-1 truncate"
            title={item.user.displayName}
          >
            {item.user.displayName}
          </span>
          <span className={cn("max-w-[45%] truncate text-xs", muted)}>
            {item.user.userId}
          </span>
        </>
      );
    case "action":
      return (
        <>
          {item.icon === "channel" ? (
            <Plus className="size-4 shrink-0" aria-hidden />
          ) : (
            <PenSquare className="size-4 shrink-0" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
        </>
      );
  }
}
