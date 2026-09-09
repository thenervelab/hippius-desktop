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
});
