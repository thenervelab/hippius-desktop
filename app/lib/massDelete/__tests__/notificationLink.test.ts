// The held-delete notification is the way back to a banner the user put off
// with "Decide later": Rust writes the drive and side into the row's link
// (`create_mass_delete_held_notification`), and opening it shows that
// banner again.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/components/updater/checkForUpdates", () => ({ checkForUpdates: vi.fn() }));

import { heldDeleteFromLink, revealHeldDelete } from "@/app/lib/massDelete/notificationLink";
import { applyHeld, holdKey, updateHold } from "@/app/lib/massDelete/holds";
import { massDeleteHoldsAtom } from "@/app/lib/store/syncAtoms";
import { appStore } from "@/lib/store/jotaiStore";
import { handleButtonLink } from "@/app/lib/utils/links";
import type { MassDeleteHold } from "@/app/lib/tauri/massDelete";
import type React from "react";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

const hold = (overrides: Partial<MassDeleteHold> = {}): MassDeleteHold => ({
  label: "Photo & Video",
  side: "server",
  state: "held",
  count: 150,
  syncedCount: 200,
  emptyRoot: false,
  canRestore: true,
  title: "Rust's title",
  body: ["Rust's line"],
  ...overrides,
});

// Rust's exact spelling (pinned in `notifications::credits` tests).
const LINK = "/files?heldDelete=server&drive=Photo+%26+Video";

function click(link: string) {
  const router = { push: vi.fn() } as unknown as AppRouterInstance;
  const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.MouseEvent;
  handleButtonLink(event, link, router);
  return router.push as ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  appStore.set(massDeleteHoldsAtom, new Map());
});

describe("held-delete notification link", () => {
  it("names the drive and side Rust wrote", () => {
    expect(heldDeleteFromLink(LINK)).toEqual({ label: "Photo & Video", side: "server" });
    expect(heldDeleteFromLink("/files?heldDelete=local&drive=Docs")).toEqual({
      label: "Docs",
      side: "local",
    });
  });

  it("is not any other link", () => {
    expect(heldDeleteFromLink("/files")).toBeNull();
    expect(heldDeleteFromLink("/files?heldDelete=both&drive=Docs")).toBeNull();
    expect(heldDeleteFromLink("/files?heldDelete=server")).toBeNull();
    expect(heldDeleteFromLink("/settings?heldDelete=server&drive=Docs")).toBeNull();
    expect(heldDeleteFromLink("BILLING")).toBeNull();
  });

  it("opening it shows the banner put off with Decide later, on the Files page", () => {
    const key = holdKey("Photo & Video", "server");
    const other = holdKey("Docs", "server");
    let holds = applyHeld(applyHeld(new Map(), hold()), hold({ label: "Docs" }));
    holds = updateHold(holds, key, { dismissed: true });
    holds = updateHold(holds, other, { dismissed: true });
    appStore.set(massDeleteHoldsAtom, holds);

    const push = click(LINK);

    expect(push).toHaveBeenCalledWith("/files");
    expect(appStore.get(massDeleteHoldsAtom).get(key)?.dismissed).toBe(false);
    expect(appStore.get(massDeleteHoldsAtom).get(other)?.dismissed).toBe(true);
  });

  it("opening it after the hold ended just opens the Files page", () => {
    const push = click(LINK);
    expect(push).toHaveBeenCalledWith("/files");
    expect(appStore.get(massDeleteHoldsAtom).size).toBe(0);
  });

  // Selecting the row in the bell or on the notifications page brings the
  // banner back too, not only its "Review" button.
  it("selecting the notification shows its banner again", () => {
    const key = holdKey("Photo & Video", "server");
    appStore.set(massDeleteHoldsAtom, updateHold(applyHeld(new Map(), hold()), key, { dismissed: true }));

    expect(revealHeldDelete(LINK)).toBe(true);
    expect(appStore.get(massDeleteHoldsAtom).get(key)?.dismissed).toBe(false);
    expect(revealHeldDelete("/files")).toBe(false);
    expect(revealHeldDelete(undefined)).toBe(false);
  });

  it("leaves other in-app links as they were", () => {
    expect(click("/files")).toHaveBeenCalledWith("/files");
  });
});
