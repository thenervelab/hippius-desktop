// @vitest-environment node
import { describe, expect, it } from "vitest";

import { workspaceRailLabel } from "@/components/chat/workspaces/WorkspaceRail";

describe("workspaceRailLabel", () => {
  it("names the workspace and prefers mentions over plain unread", () => {
    expect(workspaceRailLabel("Acme", { unread: 0, highlight: 0 })).toBe("Acme");
    expect(workspaceRailLabel("Acme", { unread: 7, highlight: 0 })).toBe("Acme, 7 unread");
    expect(workspaceRailLabel("Acme", { unread: 7, highlight: 1 })).toBe("Acme, 1 mention");
    expect(workspaceRailLabel("Acme", { unread: 7, highlight: 3 })).toBe("Acme, 3 mentions");
  });
});
