// Render-level coverage for the Review Changes dialog.
//
// The pure projections are pinned in `stagedChangesLogic.test.ts`; this file
// asserts the component is actually wired to them — the original bug was a
// correct value that nothing rendered. Each case maps to something visible in
// the 2026-07-31 screen recording.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import StagedChangesDialog from "../StagedChangesDialog";
import type { StagedChanges } from "@/lib/types/syncTypes";
import type { ResolutionMap } from "../stagedChangesLogic";

const HASH = "91c60cf7a26c14d7389bc0b7c35b570689f9cc4a1b2c3d4e5f60718293a4b5c6";

function makeStaged(overrides: Partial<StagedChanges> = {}): StagedChanges {
  return {
    uploads: [{ file_id: "u1", path: "out/server/app-paths-manifest.json" }],
    downloads: [],
    local_deletes: [],
    remote_deletes: [{ file_id: "r1", path: HASH }],
    conflicts: [
      {
        file_id: "c1",
        path: "out/cache/webpack/client-production.pack",
        conflict_type: "modify_modify",
        has_local: true,
        has_remote: true,
      },
      {
        file_id: "c2",
        path: "out/static/chunks/main.js",
        conflict_type: "create_create",
        has_local: true,
        has_remote: true,
      },
    ],
    unchanged_count: 12,
    ...overrides,
  };
}

function renderDialog({
  resolutions = {},
  staged = makeStaged(),
}: { resolutions?: ResolutionMap; staged?: StagedChanges } = {}) {
  const onResolutionsChange = vi.fn();
  const onSync = vi.fn();
  render(
    <StagedChangesDialog
      open
      onClose={vi.fn()}
      stagedChanges={staged}
      isSyncing={false}
      resolutions={resolutions}
      onResolutionsChange={onResolutionsChange}
      onSync={onSync}
      onCancel={vi.fn()}
    />,
  );
  return { onResolutionsChange, onSync };
}

describe("StagedChangesDialog", () => {
  it("never renders a bare FileId as if it were a filename", () => {
    renderDialog();
    // "Delete from Server" is collapsed; open it to reach the row.
    fireEvent.click(screen.getByRole("button", { name: /delete from server/i }));

    expect(screen.getByText("Unknown file")).toBeInTheDocument();
    // The id is still discoverable (truncated), just not presented as a name.
    expect(screen.getByText(`${HASH.slice(0, 12)}…`)).toBeInTheDocument();
    expect(screen.queryByText(HASH)).not.toBeInTheDocument();
  });

  it("leads with conflicts and collapses the informational sections", () => {
    renderDialog();

    // Conflict rows are visible without expanding anything — the report's
    // dialog buried them under 60+ rows in one flat scroll container.
    expect(
      screen.getByText("out/cache/webpack/client-production.pack"),
    ).toBeInTheDocument();

    // Counts are legible while collapsed, contents are not.
    expect(screen.getByRole("button", { name: /upload/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(
      screen.queryByText("out/server/app-paths-manifest.json"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /upload/i }));
    expect(
      screen.getByText("out/server/app-paths-manifest.json"),
    ).toBeInTheDocument();
  });

  it("shows no active bulk segment while the rows disagree", () => {
    // The reported bug inverted: the bar must not claim a selection that the
    // rows don't share. Previously "Keep Both" was always highlighted.
    renderDialog({ resolutions: { c1: "keep_local", c2: "keep_both" } });

    const bar = screen.getByRole("group", { name: /apply one resolution/i });
    for (const label of ["Keep Local", "Accept Remote", "Keep Both", "Skip for now"]) {
      expect(
        within(bar).getByRole("button", { name: label }),
      ).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("marks the bulk segment that every row actually shares", () => {
    renderDialog({ resolutions: { c1: "accept_remote", c2: "accept_remote" } });

    const bar = screen.getByRole("group", { name: /apply one resolution/i });
    expect(
      within(bar).getByRole("button", { name: "Accept Remote" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(bar).getByRole("button", { name: "Keep Both" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("applies a bulk choice to every conflict", () => {
    const { onResolutionsChange } = renderDialog();
    const bar = screen.getByRole("group", { name: /apply one resolution/i });

    fireEvent.click(within(bar).getByRole("button", { name: "Accept Remote" }));

    expect(onResolutionsChange).toHaveBeenCalledWith({
      c1: "accept_remote",
      c2: "accept_remote",
    });
  });

  it("gates Sync Now until every conflict is resolved", () => {
    renderDialog({ resolutions: { c1: "keep_local" } });
    expect(screen.getByRole("button", { name: /sync now/i })).toBeDisabled();
  });

  it("warns that an all-skip review resolves nothing", () => {
    // What the user in the report actually submitted.
    renderDialog({ resolutions: { c1: "skip", c2: "skip" } });

    expect(screen.getByRole("button", { name: /sync now/i })).toBeEnabled();
    expect(screen.getByText(/none will be resolved/i)).toBeInTheDocument();
  });

  it("does not warn when the review genuinely resolves something", () => {
    renderDialog({ resolutions: { c1: "skip", c2: "keep_both" } });
    expect(screen.queryByText(/none will be resolved/i)).not.toBeInTheDocument();
  });
});
