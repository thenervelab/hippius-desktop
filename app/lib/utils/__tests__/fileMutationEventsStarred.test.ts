import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import { notifyFilesMutated } from "../fileMutationEvents";

// A delete drops the item's star on the server, and a rename or move changes
// where Starred says it is: every mutation reads the Starred list again.
describe("notifyFilesMutated and Starred", () => {
  it("invalidates the Starred listing with the file lists", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await notifyFilesMutated(queryClient, "5Me");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["starred"] });
  });
});
