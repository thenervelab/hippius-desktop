import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import HeldRecordings, { HELD_CHANGED_EVENT, heldTitle } from "../HeldRecordings";
import { BILLING_ROUTE } from "@/app/lib/routes";
import type { HeldRecordings as Held } from "@/app/lib/tauri/capture";

const MESSAGE = "You've used your 25 free recordings. Upgrade to share this one, or delete an older recording.";
const held = (...names: string[]): Held => ({
  message: MESSAGE,
  items: names.map((fileName, i) => ({ id: `id-${i}`, fileName, heldAt: i })),
});

const called = (cmd: string) => tauri.core.invoke.mock.calls.filter(([c]) => c === cmd);

async function setup(answer: () => Held) {
  tauri.onInvoke("capture_held_recordings", answer);
  tauri.onInvoke("capture_held_delete", () => null);
  render(<HeldRecordings />);
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  tauri.reset();
  push.mockReset();
});

describe("recordings held at the free plan's limit", () => {
  it("shows nothing while none are held", async () => {
    await setup(() => held());
    expect(screen.queryByTestId("held-recordings")).toBeNull();
  });

  it("lists them oldest first with Rust's sentence and the two ways out", async () => {
    await setup(() => held("Recording A.mp4", "Recording B.mp4"));
    const section = screen.getByTestId("held-recordings");
    expect(within(section).getByText("2 recordings are waiting to upload")).toBeInTheDocument();
    expect(within(section).getByText(MESSAGE)).toBeInTheDocument();
    expect(within(section).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("Recording A.mp4"),
      expect.stringContaining("Recording B.mp4"),
    ]);
    fireEvent.click(within(section).getByRole("button", { name: "Upgrade" }));
    expect(push).toHaveBeenCalledWith(BILLING_ROUTE);
  });

  it("deletes one through Rust and reads the list again", async () => {
    let items = held("Recording A.mp4", "Recording B.mp4");
    await setup(() => items);
    items = held("Recording B.mp4");
    fireEvent.click(screen.getByRole("button", { name: "Delete Recording A.mp4" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(called("capture_held_delete")).toEqual([["capture_held_delete", { id: "id-0" }]]);
    expect(screen.queryByText("Recording A.mp4")).toBeNull();
    expect(screen.getByText("1 recording is waiting to upload")).toBeInTheDocument();
  });

  it("follows Rust's event when one is held or released", async () => {
    let items = held("Recording A.mp4");
    await setup(() => items);
    items = held();
    await act(async () => {
      await tauri.emitEvent(HELD_CHANGED_EVENT, null);
    });
    expect(screen.queryByTestId("held-recordings")).toBeNull();
  });

  it("counts in plain words", () => {
    expect(heldTitle(1)).toBe("1 recording is waiting to upload");
    expect(heldTitle(3)).toBe("3 recordings are waiting to upload");
  });
});
