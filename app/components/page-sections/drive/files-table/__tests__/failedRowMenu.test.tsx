import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import { failedRowMenuItem } from "../failedRowMenu";
import type { FileFailureRecord } from "@/app/lib/types/fileFailure";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const notifyFilesMutated = vi.fn();
vi.mock("@/app/lib/utils/fileMutationEvents", () => ({
  notifyFilesMutated: (...args: unknown[]) => notifyFilesMutated(...args),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function failure(kind: FileFailureRecord["kind"]): FileFailureRecord {
  return {
    label: "photos",
    relativePath: "trip/Beach.JPG",
    fileName: "Beach.JPG",
    kind,
    message: "Not synced: collides with beach.jpg",
    httpStatus: null,
    balanceCents: null,
    requiredCents: null,
    failureCount: 1,
    lastFailedAt: 1,
  };
}

function itemFor(saved: FileFailureRecord[] | undefined) {
  const queryClient = new QueryClient();
  if (saved) queryClient.setQueryData(["drive-failures", "photos"], saved);
  const item = failedRowMenuItem({
    label: "photos",
    relativePath: "trip/Beach.JPG",
    queryClient,
    polkadotAddress: "5Grw",
    disabled: false,
  });
  return { item, queryClient };
}

describe("failedRowMenuItem", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    notifyFilesMutated.mockReset();
  });

  // hcfs reports a refusal once per revision: Retry would clear the row and
  // the next cycle would refuse the file again without saying so.
  it("offers Dismiss for a refused file, which drops the row without syncing", async () => {
    const { item, queryClient } = itemFor([failure("refused")]);
    expect(item?.itemTitle).toBe("Dismiss");

    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    item?.onItemClick?.();
    await vi.waitFor(() => expect(notifyFilesMutated).toHaveBeenCalled());

    expect(invoke).toHaveBeenCalledWith("clear_file_failure", {
      label: "photos",
      relativePath: "trip/Beach.JPG",
    });
    expect(invoke).not.toHaveBeenCalledWith("retry_file_failure", expect.anything());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["drive-failures", "photos"] });
  });

  it("offers Retry for a retryable kind and for a failure with no saved row", () => {
    expect(itemFor([failure("network")]).item?.itemTitle).toBe("Retry sync");
    expect(itemFor(undefined).item?.itemTitle).toBe("Retry sync");
    expect(itemFor([{ ...failure("refused"), relativePath: "other/Beach.JPG" }]).item?.itemTitle).toBe(
      "Retry sync",
    );
  });

  it("offers nothing for an undecryptable file", () => {
    expect(itemFor([failure("undecryptable")]).item).toBeNull();
  });
});
