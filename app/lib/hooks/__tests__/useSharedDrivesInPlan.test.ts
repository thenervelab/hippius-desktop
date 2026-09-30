import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

import { useSharedDrivesInPlan } from "../useSharedDrivesInPlan";

// The hook only reads Rust's `canShareDrives`; the plan rule itself is
// tested in `billing/sharing_entitlement.rs`.
const query = vi.hoisted(() => ({
  value: {} as { data?: unknown; isError?: boolean },
}));
vi.mock("@/app/lib/hooks/api/useStorageOverview", () => ({
  useStorageOverview: () => query.value,
}));

beforeEach(() => {
  query.value = {};
});

describe("useSharedDrivesInPlan", () => {
  it("reads Rust's verdict", () => {
    query.value = { data: { canShareDrives: true } };
    expect(renderHook(() => useSharedDrivesInPlan()).result.current).toBe(true);
    query.value = { data: { canShareDrives: false } };
    expect(renderHook(() => useSharedDrivesInPlan()).result.current).toBe(
      false,
    );
  });

  it("is unknown while the overview loads", () => {
    query.value = { data: undefined, isError: false };
    expect(
      renderHook(() => useSharedDrivesInPlan()).result.current,
    ).toBeUndefined();
  });

  // A plan that cannot be loaded must not block sharing: the server decides.
  it("allows sharing when the overview could not be loaded", () => {
    query.value = { data: undefined, isError: true };
    expect(renderHook(() => useSharedDrivesInPlan()).result.current).toBe(true);
  });
});
