import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useState } from "react";
import { Provider, createStore } from "jotai";

// The URL the page reads, changed between renders the way a navigation would.
const url = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(url.search),
}));
vi.mock("@/components/ui/page-header", () => ({
  default: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
// The list keeps its own tab in state; the stub stands in for that state.
vi.mock("@/components/page-sections/shared-drives/SharedDrivesView", () => ({
  default: function ListStub() {
    const [tab, setTab] = useState("All");
    return (
      <section data-testid="list-view">
        <span>Tab: {tab}</span>
        <button type="button" onClick={() => setTab("Shared with you")}>
          Shared with you
        </button>
      </section>
    );
  },
}));
// The drive is Drive's own container (pinned by its own tests); the stub
// shows the route it is hosted under.
vi.mock("@/components/page-sections/drive/DriveContainer", async () => {
  const { useDriveRoute } = await import("@/components/page-sections/drive/driveRoute");
  return {
    default: function DriveStub() {
      const route = useDriveRoute();
      return (
        <section
          data-testid="drive"
          data-base={route.basePath}
          data-root={route.parent?.label}
          data-back={route.parent?.href}
        />
      );
    },
  };
});

import SharedDrivesPage from "../shared-drives/page";
import { sharedDrivesDriveRoute } from "@/app/lib/routes";

const go = (href: string) => {
  url.search = href.includes("?") ? href.slice(href.indexOf("?")) : "";
};

const renderPage = () => {
  const store = createStore();
  const view = render(
    <Provider store={store}>
      <SharedDrivesPage />
    </Provider>,
  );
  return {
    ...view,
    navigate: (href: string) => {
      go(href);
      view.rerender(
        <Provider store={store}>
          <SharedDrivesPage />
        </Provider>,
      );
    },
  };
};

const DRIVE = sharedDrivesDriveRoute({ label: "shared:5Owner~abc", remote: true, name: "Design team" });

describe("the Shared Drives page", () => {
  beforeEach(() => go("/shared-drives"));

  it("shows the list when no drive is open", () => {
    renderPage();
    expect(screen.getByTestId("list-view")).toBeVisible();
    expect(screen.queryByTestId("drive")).not.toBeInTheDocument();
  });

  // The drive opens here, so its trail starts at Shared Drives and Back from
  // its root returns to this page rather than to Drive's folder list.
  it("opens a drive on this page, with this page above it", () => {
    go(DRIVE);
    renderPage();
    const drive = screen.getByTestId("drive");
    expect(drive).toHaveAttribute("data-base", "/shared-drives");
    expect(drive).toHaveAttribute("data-root", "Shared Drives");
    expect(drive).toHaveAttribute("data-back", "/shared-drives");
    expect(screen.getByTestId("shared-drives-list")).not.toBeVisible();
  });

  // A reload inside a folder of the drive: the nested params alone say a
  // drive is open, so the trail still starts at Shared Drives.
  it("stays in the drive when the window reloads inside a folder of it", () => {
    go(
      "/shared-drives?folderName=ACME&folderActualName=ACME&mainFolderActualName=Clients" +
        "&subFolderPath=Clients%2FACME&folderSource=remote%3A%2F%2Fshared%3A5Owner~abc",
    );
    renderPage();
    expect(screen.getByTestId("drive")).toHaveAttribute("data-root", "Shared Drives");
  });

  it("comes back to the list on the tab it was left on", () => {
    const { navigate } = renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Shared with you" }));
    expect(screen.getByText("Tab: Shared with you")).toBeInTheDocument();

    navigate(DRIVE);
    expect(screen.getByTestId("drive")).toBeInTheDocument();

    navigate("/shared-drives");
    expect(screen.queryByTestId("drive")).not.toBeInTheDocument();
    expect(screen.getByTestId("list-view")).toBeVisible();
    expect(screen.getByText("Tab: Shared with you")).toBeInTheDocument();
  });
});
