"use client";

import { useAtomValue } from "jotai";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { chatConfigAtom } from "@/app/lib/global-atoms/chatAtoms";
import { ChatProvider, useChat } from "@/components/chat/ChatProvider";
import { selectedRoomIdAtom } from "@/components/chat/chat-ui-atoms";
import { useChatNotifications } from "@/components/chat/hooks/useChatNotifications";
import { useChatUnreadBadge } from "@/components/chat/hooks/useChatUnreadBadge";

/** Route prefix of the chat surface (`app/(pages)/chat`). */
export const CHAT_ROUTE = "/chat";

/**
 * Which room is on screen: the selected room only while the chat page is
 * the current route. Pure so the "a selected room on another page must not
 * silence its own notifications" rule is unit-tested.
 */
export function openRoomFor(
  pathname: string | null,
  selectedRoomId: string | null,
): string | null {
  if (!pathname) return null;
  if (pathname !== CHAT_ROUTE && !pathname.startsWith(`${CHAT_ROUTE}/`))
    return null;
  return selectedRoomId;
}

/**
 * Hosts the chat client for the signed-in app. Mounted once in the
 * protected layout so the Matrix client syncs in the background and the
 * desktop surfaces — OS notifications, dock/taskbar badge, `(N) Hippius`
 * title, tray popover count — work while the user is anywhere in the app.
 * `/chat` (`ChatRoute`) only consumes the context this provides.
 *
 * Always renders the provider, gated through its `active` prop, so the
 * Rust config landing after first paint does not remount the app tree.
 */
export default function ChatHost({ children }: { children: ReactNode }) {
  const config = useAtomValue(chatConfigAtom);
  return (
    <ChatProvider active={config?.enabled === true}>
      <ChatBackground />
      {children}
    </ChatProvider>
  );
}

/** Renders nothing; runs the background hooks against the live client. */
function ChatBackground() {
  const { client } = useChat();
  const pathname = usePathname();
  const selectedRoomId = useAtomValue(selectedRoomIdAtom);
  useChatNotifications(client, openRoomFor(pathname, selectedRoomId));
  useChatUnreadBadge(client);
  return null;
}
