import { MatrixError } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";

import {
  applyRefreshedTokens,
  buildSlidingSyncLists,
  initialSyncError,
  isStoreAccountMismatch,
} from "@/app/lib/chat/client";
import type { ChatSession } from "@/app/lib/tauri/chat";

const session: ChatSession = {
  baseUrl: "https://chat.hippius.com",
  issuer: "https://chat.hippius.com/",
  clientId: "cid",
  userId: "@dubs:hippius.com",
  deviceId: "DEV",
  accessToken: "old-access",
  refreshToken: "old-refresh",
  expiresAt: 1_000,
  storeLayout: "device",
};

// Rust persisted the rotation before answering; the in-memory copy must
// follow it exactly, including keeping the old refresh token when the
// issuer did not rotate it (MAS does, but the field is optional).
describe("applyRefreshedTokens", () => {
  it("takes the new access token and expiry, and the new refresh token when given", () => {
    const next = applyRefreshedTokens(session, {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: 2_000,
    });
    expect(next).toEqual({
      ...session,
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: 2_000,
    });
  });

  it("keeps the previous refresh token when the issuer did not rotate it", () => {
    const next = applyRefreshedTokens(session, { accessToken: "new-access" });
    expect(next.refreshToken).toBe("old-refresh");
    expect(next.expiresAt).toBeUndefined();
    expect(next.userId).toBe(session.userId);
  });
});

describe("isStoreAccountMismatch", () => {
  const msg =
    "the account in the store doesn't match the account in the constructor: expected @a:x:DEV, got @b:x:DEV";
  it("recognises the rust-crypto store mismatch in every shape it arrives as", () => {
    expect(isStoreAccountMismatch(new Error(msg))).toBe(true);
    expect(isStoreAccountMismatch(msg)).toBe(true);
    expect(isStoreAccountMismatch({ message: msg })).toBe(true);
  });
  it("does not match other errors", () => {
    expect(isStoreAccountMismatch(new Error("network down"))).toBe(false);
    expect(isStoreAccountMismatch(null)).toBe(false);
    expect(isStoreAccountMismatch(undefined)).toBe(false);
  });
});

describe("initialSyncError", () => {
  it("names an expired session", () => {
    const e = new MatrixError({ errcode: "M_UNKNOWN_TOKEN", error: "x" }, 401);
    expect(initialSyncError(e).message).toMatch(/expired/i);
  });
  it("names a server failure with its status", () => {
    const e = new MatrixError({ errcode: "M_UNKNOWN", error: "x" }, 502);
    expect(initialSyncError(e).message).toMatch(/HTTP 502/);
  });
  it("falls back to a connectivity message", () => {
    expect(initialSyncError(new TypeError("fetch failed")).message).toMatch(
      /reach the chat server/i,
    );
  });
});

describe("buildSlidingSyncLists", () => {
  it("separates joined rooms from invites and asks for the space hierarchy state", () => {
    const lists = buildSlidingSyncLists();
    expect(lists.get("rooms")?.filters).toEqual({ is_invite: false });
    expect(lists.get("invites")?.filters).toEqual({ is_invite: true });
    const state = lists.get("rooms")?.required_state ?? [];
    expect(state).toContainEqual(["m.space.child", "*"]);
    expect(state).toContainEqual(["m.room.encryption", ""]);
    expect(state).toContainEqual(["m.room.member", "$ME"]);
  });
});
