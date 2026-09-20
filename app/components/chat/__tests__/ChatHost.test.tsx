import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Provider as JotaiProvider, createStore } from "jotai";
import type { ReactNode } from "react";

import ChatHost, { openRoomFor } from "@/components/chat/ChatHost";
import { selectedRoomIdAtom } from "@/components/chat/chat-ui-atoms";
import { chatConfigAtom } from "@/app/lib/global-atoms/chatAtoms";
import type { ChatConfig } from "@/app/lib/tauri/chat";

/**
 * The host's contract: the provider is ALWAYS in the tree (gated through
 * `active`, so the Rust config landing late never remounts the app under
 * it), the children always render, and the background hooks receive the
 * live client plus the room that is genuinely on screen.
 */

const pathname = vi.hoisted(() => ({ current: "/" }));
vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
}));

const seen = vi.hoisted(() => ({
  active: [] as boolean[],
  notifications: [] as Array<[unknown, string | null]>,
  badge: [] as unknown[],
}));
const fakeClient = vi.hoisted(() => ({ id: "client" }));
vi.mock("@/components/chat/ChatProvider", () => ({
  ChatProvider: ({ children, active }: { children: ReactNode; active?: boolean }) => {
    seen.active.push(active === true);
    return <>{children}</>;
  },
  useChat: () => ({ client: fakeClient }),
}));
vi.mock("@/components/chat/hooks/useChatNotifications", () => ({
  useChatNotifications: (client: unknown, open: string | null) => {
    seen.notifications.push([client, open]);
  },
}));
vi.mock("@/components/chat/hooks/useChatUnreadBadge", () => ({
  useChatUnreadBadge: (client: unknown) => {
    seen.badge.push(client);
  },
}));

const CONFIG: ChatConfig = {
  enabled: true,
  serverName: "hippius.com",
  fallbackBaseUrl: "https://chat.hippius.com",
  communitySpaceAlias: "#hippius:hippius.com",
  secretStorageKeyId: "hippius-console-v1",
  secretStorageKeyName: "Hippius Console recovery key",
  apiBaseUrl: "https://api.hippius.com",
};

function mount(config: ChatConfig | null, selectedRoomId: string | null = null) {
  const store = createStore();
  store.set(chatConfigAtom, config);
  store.set(selectedRoomIdAtom, selectedRoomId);
  return render(
    <JotaiProvider store={store}>
      <ChatHost>
        <span>app</span>
      </ChatHost>
    </JotaiProvider>,
  );
}

beforeEach(() => {
  seen.active.length = 0;
  seen.notifications.length = 0;
  seen.badge.length = 0;
  pathname.current = "/";
});

describe("ChatHost", () => {
  it("always renders the app and the provider, inactive until Rust enables chat", () => {
    mount(null);
    expect(screen.getByText("app")).toBeInTheDocument();
    expect(seen.active).toEqual([false]);

    mount({ ...CONFIG, enabled: false });
    expect(seen.active.at(-1)).toBe(false);

    mount(CONFIG);
    expect(seen.active.at(-1)).toBe(true);
  });

  it("feeds the live client to the badge and notification hooks", () => {
    pathname.current = "/chat";
    mount(CONFIG, "!g");
    expect(seen.badge.at(-1)).toBe(fakeClient);
    expect(seen.notifications.at(-1)).toEqual([fakeClient, "!g"]);
  });

  // A room selected earlier stays selected while the user is on Files: it
  // is not on screen, so its messages must still notify.
  it("reports no open room when the chat page is not the current route", () => {
    pathname.current = "/files";
    mount(CONFIG, "!g");
    expect(seen.notifications.at(-1)).toEqual([fakeClient, null]);
  });
});

describe("openRoomFor", () => {
  it("is the selected room only on the chat route", () => {
    expect(openRoomFor("/chat", "!g")).toBe("!g");
    expect(openRoomFor("/chat/", "!g")).toBe("!g");
    expect(openRoomFor("/chat", null)).toBeNull();
    expect(openRoomFor("/files", "!g")).toBeNull();
    expect(openRoomFor("/chatter", "!g")).toBeNull();
    expect(openRoomFor(null, "!g")).toBeNull();
  });
});
