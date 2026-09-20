// @vitest-environment node
import { describe, expect, it } from "vitest";

import { filterRooms } from "@/components/chat/ChatSidebar";

const rooms = [{ name: "general" }, { name: "Design Review" }, { name: "ops-alerts" }];

describe("filterRooms", () => {
  it("keeps everything for an empty or whitespace filter", () => {
    expect(filterRooms(rooms, "")).toBe(rooms);
    expect(filterRooms(rooms, "   ")).toBe(rooms);
  });

  it("matches a case-insensitive substring of the name", () => {
    expect(filterRooms(rooms, "DES").map((r) => r.name)).toEqual(["Design Review"]);
    expect(filterRooms(rooms, "al").map((r) => r.name)).toEqual(["general", "ops-alerts"]);
    expect(filterRooms(rooms, "zzz")).toEqual([]);
  });
});
