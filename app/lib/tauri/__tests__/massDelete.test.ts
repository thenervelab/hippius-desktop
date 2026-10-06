import { describe, it, expect } from "vitest";
import { classifyMassDeleteError } from "@/app/lib/tauri/massDelete";

// Rust's `AppError::NotReady` shape for the four refusals (pinned by
// `refusals_map_to_the_subkinds_the_frontend_matches` and
// `hold_changed_carries_the_new_count`). The message is the same on purpose:
// classification must come from `subkind`, never from the words.
const notReady = (subkind: string, extra: Record<string, unknown> = {}) => ({
  kind: "NotReady",
  subkind,
  message: "the same words",
  ...extra,
});

describe("classifyMassDeleteError", () => {
  it("matches each refusal by subkind", () => {
    expect(classifyMassDeleteError(notReady("MASS_DELETE_NOTHING_HELD"))).toEqual({
      type: "nothingHeld",
      message: "the same words",
    });
    expect(classifyMassDeleteError(notReady("MASS_DELETE_HOLD_CHANGED", { held: 180 }))).toEqual({
      type: "holdChanged",
      held: 180,
      message: "the same words",
    });
    expect(classifyMassDeleteError(notReady("MASS_DELETE_RESTORE_IN_PROGRESS"))).toEqual({
      type: "restoreInProgress",
      message: "the same words",
    });
    expect(classifyMassDeleteError(notReady("MASS_DELETE_MEMBER_CANNOT_RESTORE"))).toEqual({
      type: "memberCannotRestore",
      message: "the same words",
    });
  });

  it("a changed hold without a count refreshes instead", () => {
    expect(classifyMassDeleteError(notReady("MASS_DELETE_HOLD_CHANGED"))).toEqual({
      type: "nothingHeld",
      message: "",
    });
  });

  it("anything else is a plain failure", () => {
    expect(classifyMassDeleteError({ kind: "Hcfs", message: "disk full" })).toEqual({
      type: "other",
    });
    expect(classifyMassDeleteError(notReady("SYNC_IN_PROGRESS"))).toEqual({ type: "other" });
    expect(classifyMassDeleteError("boom")).toEqual({ type: "other" });
  });
});
