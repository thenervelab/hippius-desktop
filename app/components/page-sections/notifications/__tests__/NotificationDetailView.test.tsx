// A finished sync's notification lists its files. A remote delete the
// engine sent to Trash (Rust marks it `trashed`) can still be restored, so
// it is counted and labelled "moved to Trash", never "deleted".

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
// jsdom has no IntersectionObserver, which the view's read tracking uses.
class NoIntersections {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
vi.stubGlobal("IntersectionObserver", NoIntersections);
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "1.0.0") }));

import NotificationDetailView from "../NotificationDetailView";

function show(files: Array<{ fileName: string; action: string; trashed?: boolean }>) {
  render(
    <NotificationDetailView
      selectedNotification={{
        id: 1,
        icon: (() => null) as never,
        type: "Files",
        title: "Sync Complete",
        description: "",
        releaseNotes: JSON.stringify(files.map((f) => ({ totalBytes: 0, ...f }))),
        time: 0,
      }}
    />,
  );
}

describe("NotificationDetailView sync file list", () => {
  it("counts and labels deletes that went to Trash apart from real deletes", () => {
    show([
      { fileName: "a.txt", action: "remote_delete", trashed: true },
      { fileName: "b.txt", action: "remote_delete", trashed: true },
      { fileName: "c.txt", action: "local_delete" },
    ]);
    expect(screen.getByTestId("sync-summary-trashed")).toHaveTextContent("2 moved to Trash");
    expect(screen.getByText("1 deleted")).toBeInTheDocument();
    expect(screen.getAllByText("Moved to Trash")).toHaveLength(2);
    expect(screen.getAllByText("Deleted")).toHaveLength(1);
  });

  it("keeps the deleted wording when nothing went to Trash", () => {
    show([
      { fileName: "a.txt", action: "remote_delete" },
      { fileName: "b.txt", action: "upload" },
    ]);
    expect(screen.queryByTestId("sync-summary-trashed")).not.toBeInTheDocument();
    expect(screen.getByText("1 deleted")).toBeInTheDocument();
    expect(screen.queryByText("Moved to Trash")).not.toBeInTheDocument();
  });
});
