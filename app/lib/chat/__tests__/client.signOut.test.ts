import { beforeEach, describe, expect, it, vi } from "vitest";

// `signOutChat` with no live client: the IndexedDB sweep and the Rust
// bridge are replaced, what is under test is the webview-side state it
// must leave behind for the next account.
const tauri = {
  chatSignOut: vi.fn(async () => undefined),
  chatRefreshTokens: vi.fn(),
};
vi.mock("@/app/lib/tauri/chat", () => tauri);
const stores = {
  chatStoreNamesFor: vi.fn(async () => ({ cryptoPrefix: "p", syncStore: "s", cryptoStores: [] })),
  deleteChatStores: vi.fn(async () => undefined),
  deleteOtherChatStores: vi.fn(async () => 0),
};
vi.mock("@/app/lib/chat/stores", () => stores);

const { signOutChat } = await import("@/app/lib/chat/client");
const { loadDraft, saveDraft } = await import("@/app/lib/chat/compose");

const ALICE = "@alice:hippius.com";
const BOB = "@bob:hippius.com";
const ROOM = "!general:hippius.com";

const session = {
  baseUrl: "https://chat.hippius.com",
  issuer: "https://chat.hippius.com/",
  clientId: "cid",
  userId: ALICE,
  deviceId: "DEV",
  accessToken: "a",
  storeLayout: "user-device" as const,
};

beforeEach(() => {
  window.sessionStorage.clear();
  tauri.chatSignOut.mockClear();
});

describe("signOutChat", () => {
  it("drops the signed-out user's unsent drafts and keeps other users'", async () => {
    saveDraft(ALICE, ROOM, null, "alice's unsent text");
    saveDraft(ALICE, ROOM, "$root", "alice's unsent thread reply");
    saveDraft(BOB, ROOM, null, "bob's unsent text");

    await signOutChat(null, session);

    expect(loadDraft(ALICE, ROOM, null)).toBe("");
    expect(loadDraft(ALICE, ROOM, "$root")).toBe("");
    expect(loadDraft(BOB, ROOM, null)).toBe("bob's unsent text");
    expect(tauri.chatSignOut).toHaveBeenCalledTimes(1);
  });
});
