import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import EditedImageSetting from "../EditedImageSetting";

const pressed = () =>
  screen
    .getAllByRole("button")
    .filter((b) => b.getAttribute("aria-pressed") === "true")
    .map((b) => b.textContent);

beforeEach(() => {
  tauri.reset();
  toast.error.mockClear();
});

describe("Settings: when saving an edited image", () => {
  it("shows the saved choice and changes it through Rust", async () => {
    tauri.onInvoke("capture_editor_save_preference", () => "copy");
    tauri.onInvoke("capture_editor_set_save_preference", () => null);
    render(<EditedImageSetting rowClassName="row" />);
    expect(screen.getByRole("group", { name: "When saving an edited image" })).toBeInTheDocument();
    await waitFor(() => expect(pressed()).toEqual(["Save a copy"]));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Replace the original" })));
    expect(pressed()).toEqual(["Replace the original"]);
    const sets = tauri.core.invoke.mock.calls.filter(([c]) => c === "capture_editor_set_save_preference");
    expect(sets[0][1]).toEqual({ preference: "replace" });
  });

  it("puts the choice back and says why when Rust refuses it", async () => {
    tauri.onInvoke("capture_editor_save_preference", () => "ask");
    tauri.onInvoke("capture_editor_set_save_preference", () => {
      throw { kind: "Other", message: "The setting couldn't be saved." };
    });
    render(<EditedImageSetting rowClassName="row" />);
    await waitFor(() => expect(pressed()).toEqual(["Ask"]));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save a copy" })));
    await waitFor(() => expect(pressed()).toEqual(["Ask"]));
    expect(toast.error).toHaveBeenCalled();
  });
});
