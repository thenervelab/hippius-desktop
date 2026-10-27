import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import React from "react";

import SyncFolderBreadcrumb from "../SyncFolderBreadcrumb";

describe("breadcrumb root", () => {
  // It used to say "Local" or "Remote" depending on the drive. Both clicked
  // through to the same folder list, so the two labels named an
  // implementation detail and invited the question of what differed.
  it('reads "Drive" wherever the folder is synced', () => {
    render(
      <SyncFolderBreadcrumb onLocalClick={vi.fn()} segments={[{ label: "chains" }]} />,
    );
    expect(screen.getByRole("button", { name: "Drive" })).toBeInTheDocument();
    expect(screen.queryByText("Local")).not.toBeInTheDocument();
    expect(screen.queryByText("Remote")).not.toBeInTheDocument();
  });

  it("takes the user back to the folder list", async () => {
    const onLocalClick = vi.fn();
    render(
      <SyncFolderBreadcrumb
        onLocalClick={onLocalClick}
        segments={[{ label: "chains" }, { label: "nested" }]}
      />,
    );
    screen.getByRole("button", { name: "Drive" }).click();
    expect(onLocalClick).toHaveBeenCalledOnce();
  });

  // At the root there is no trail and nothing above to go to.
  it("shows the root alone when nothing is open", () => {
    render(<SyncFolderBreadcrumb onLocalClick={vi.fn()} segments={[]} />);
    expect(screen.getByRole("button", { name: "Drive" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Back to/)).not.toBeInTheDocument();
  });

  // The Captures page shows one drive: the drive is the top of the trail.
  it("leaves the root out on a page pinned to one drive", () => {
    render(
      <SyncFolderBreadcrumb onLocalClick={vi.fn()} segments={[{ label: "Hippius Captures" }]} hideRoot />,
    );
    expect(screen.queryByRole("button", { name: "Drive" })).not.toBeInTheDocument();
    expect(screen.getByText("Hippius Captures")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Back to/)).not.toBeInTheDocument();
  });

  // A drive opened from the Shared Drives page: the trail starts there, and
  // the root crumb and Back from the drive's root both go back there.
  describe("opened from Shared Drives", () => {
    it('reads "Shared Drives" and goes back to it', () => {
      const onLocalClick = vi.fn();
      render(
        <SyncFolderBreadcrumb
          onLocalClick={onLocalClick}
          segments={[{ label: "Design team" }]}
          rootLabel="Shared Drives"
        />,
      );
      expect(screen.queryByRole("button", { name: "Drive" })).not.toBeInTheDocument();
      screen.getByRole("button", { name: "Shared Drives" }).click();
      screen.getByRole("button", { name: "Back to Shared Drives" }).click();
      expect(onLocalClick).toHaveBeenCalledTimes(2);
    });

    it("lets every level of a deep trail take the user to it", () => {
      const toDrive = vi.fn();
      const toClients = vi.fn();
      render(
        <SyncFolderBreadcrumb
          onLocalClick={vi.fn()}
          rootLabel="Shared Drives"
          segments={[
            { label: "Design team", onClick: toDrive },
            { label: "Clients", onClick: toClients },
            { label: "ACME" },
          ]}
        />,
      );
      screen.getByRole("button", { name: "Design team" }).click();
      expect(toDrive).toHaveBeenCalledOnce();
      // Back goes up one level, to the folder above, not out of the drive.
      screen.getByRole("button", { name: "Back to Clients" }).click();
      expect(toClients).toHaveBeenCalledOnce();
      // The folder on screen is not a link.
      expect(screen.queryByRole("button", { name: "ACME" })).not.toBeInTheDocument();
      expect(screen.getByText("ACME")).toBeInTheDocument();
    });

    // Long names are cut short on screen; hovering shows the whole name.
    it("keeps a long name whole on hover", () => {
      const long = "Quarterly planning and board materials for the whole design team";
      render(
        <SyncFolderBreadcrumb
          onLocalClick={vi.fn()}
          rootLabel="Shared Drives"
          segments={[{ label: long, title: long, onClick: vi.fn() }, { label: long, title: long }]}
        />,
      );
      const crumbs = screen.getAllByTitle(long);
      expect(crumbs).toHaveLength(2);
      for (const crumb of crumbs) expect(crumb.className).toMatch(/\btruncate\b/);
    });
  });
});
