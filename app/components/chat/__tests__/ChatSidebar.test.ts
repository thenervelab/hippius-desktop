// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { filterRooms, workspaceMenu } from "@/components/chat/ChatSidebar";

const rooms = [
  { name: "general" },
  { name: "Design Review" },
  { name: "ops-alerts" },
];

describe("filterRooms", () => {
  it("keeps everything for an empty or whitespace filter", () => {
    expect(filterRooms(rooms, "")).toBe(rooms);
    expect(filterRooms(rooms, "   ")).toBe(rooms);
  });

  it("matches a case-insensitive substring of the name", () => {
    expect(filterRooms(rooms, "DES").map((r) => r.name)).toEqual([
      "Design Review",
    ]);
    expect(filterRooms(rooms, "al").map((r) => r.name)).toEqual([
      "general",
      "ops-alerts",
    ]);
    expect(filterRooms(rooms, "zzz")).toEqual([]);
  });
});

describe("workspaceMenu", () => {
  const labels = (role: "owner" | "admin" | "member") =>
    workspaceMenu(
      { myRole: role },
      { invite: vi.fn(), openSettings: vi.fn() },
    ).map((i) => (i === "separator" ? i : i.label));

  it("offers settings to admins and owners, read-only details to members", () => {
    expect(labels("owner")).toEqual([
      "Invite people",
      "Workspace settings",
      "separator",
      "Leave workspace",
    ]);
    expect(labels("admin")).toEqual([
      "Invite people",
      "Workspace settings",
      "separator",
      "Leave workspace",
    ]);
    expect(labels("member")).toEqual([
      "Invite people",
      "Workspace details",
      "separator",
      "Leave workspace",
    ]);
  });

  it("routes each entry to its dialog: invite, general settings, and leave via the danger zone", () => {
    const invite = vi.fn();
    const openSettings = vi.fn<(tab: string) => void>();
    const items = workspaceMenu(
      { myRole: "member" },
      { invite, openSettings },
    ).filter((i) => i !== "separator");
    items.find((i) => i.key === "invite")?.onSelect();
    expect(invite).toHaveBeenCalledTimes(1);
    items.find((i) => i.key === "settings")?.onSelect();
    expect(openSettings).toHaveBeenLastCalledWith("general");
    items.find((i) => i.key === "leave")?.onSelect();
    expect(openSettings).toHaveBeenLastCalledWith("danger");
    expect(items.find((i) => i.key === "leave")?.destructive).toBe(true);
  });
});
