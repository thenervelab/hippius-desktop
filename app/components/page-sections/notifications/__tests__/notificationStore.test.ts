import { describe, it, expect, vi, beforeEach } from "vitest";

// notificationStore imports `invoke` at module load for a dev-only debug helper.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// Drive the refresh atom against mocked Rust helpers so the tests assert the
// frontend never needs an address to load notifications.
const getEnabledNotificationTypes = vi.fn();
const listNotifications = vi.fn();
vi.mock("@/app/lib/helpers/notificationsDb", () => ({
  getEnabledNotificationTypes: (...a: unknown[]) => getEnabledNotificationTypes(...a),
  listNotifications: (...a: unknown[]) => listNotifications(...a),
  markRead: vi.fn(),
  markUnread: vi.fn(),
  markAllRead: vi.fn(),
}));

import { createStore } from "jotai";
import {
  buildNotificationView,
  refreshNotificationsAtom,
  notificationsAtom,
  unreadCountAtom,
} from "../notificationStore";
import type { NotificationRow } from "@/app/lib/helpers/notificationsDb";

const row = (over: Partial<NotificationRow> = {}): NotificationRow => ({
  id: 1,
  userAddress: "5CRyFwmSHJC7EeGLGbU1G8ycuoxu8sQxExhfBhkwNPtQU5n2",
  notificationType: "Files",
  notificationSubtype: "FileSyncError-2026-06-09T07:06:56.224Z",
  titleText: "Sync Failed",
  description: "",
  linkText: "",
  link: "",
  isUnread: true,
  creationTime: 1717000000000,
  isDeleted: false,
  deletedAt: null,
  releaseNotes: null,
  ...over,
});

describe("buildNotificationView", () => {
  it("keeps rows whose type is enabled and tallies the unread count", () => {
    const { notifications, unreadCount } = buildNotificationView(
      [row({ id: 1, isUnread: true }), row({ id: 2, isUnread: false })],
      ["Files", "Credits"],
    );
    expect(notifications.map((n) => n.id)).toEqual([1, 2]);
    expect(unreadCount).toBe(1);
  });

  it("always shows Hippius system rows even when nothing is enabled", () => {
    const { notifications } = buildNotificationView(
      [row({ id: 5, notificationType: "Hippius", notificationSubtype: "Welcome" })],
      [],
    );
    expect(notifications.map((n) => n.id)).toEqual([5]);
  });

  it("drops rows whose category is not enabled", () => {
    const { notifications } = buildNotificationView(
      [row({ id: 7, notificationType: "Credits" })],
      ["Files"],
    );
    expect(notifications).toHaveLength(0);
  });
});

describe("refreshNotificationsAtom", () => {
  beforeEach(() => {
    getEnabledNotificationTypes.mockReset();
    listNotifications.mockReset();
  });

  // Regression: the bell rendered "Nothing here" while the database held rows
  // because the refresh short-circuited whenever the frontend address atom was
  // falsy. Rust scopes the read to the session account, so the refresh must run
  // and populate the list/badge with NO frontend address present.
  it("loads notifications from Rust without any frontend address being set", async () => {
    getEnabledNotificationTypes.mockResolvedValue(["Files"]);
    listNotifications.mockResolvedValue([row({ id: 11, isUnread: true })]);

    const store = createStore();
    await store.set(refreshNotificationsAtom);

    expect(listNotifications).toHaveBeenCalledWith(100);
    expect(store.get(notificationsAtom).map((n) => n.id)).toEqual([11]);
    expect(store.get(unreadCountAtom)).toBe(1);
  });
});
