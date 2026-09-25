// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import UploaderCell from "../UploaderCell";

const VIEWER = "5DSQAMf3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5TMdSK63";
const OWNER = "5HHap2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbYdsT";
const OTHER = "5CV9U6cccccccccccccccccccccccccccccccccccccccccMFXb";

describe("UploaderCell", () => {
  it("names the owner for a file the server never attributed", () => {
    render(
      <UploaderCell
        uploadedBy={null}
        sessionSs58={VIEWER}
        driveOwnerSs58={OWNER}
      />,
    );
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.queryByText("—")).toBeNull();
  });

  it("still keeps the dash where there is no owner to fall back on", () => {
    render(<UploaderCell uploadedBy={null} sessionSs58={VIEWER} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("never names anybody for a folder", () => {
    render(
      <UploaderCell
        uploadedBy={null}
        isFolder
        sessionSs58={VIEWER}
        driveOwnerSs58={OWNER}
      />,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("Owner")).toBeNull();
  });

  it("puts the viewer ahead of the owner", () => {
    render(
      <UploaderCell
        uploadedBy={VIEWER}
        sessionSs58={VIEWER}
        driveOwnerSs58={VIEWER}
      />,
    );
    expect(screen.getByText("You")).toBeInTheDocument();
  });

  it("names another member when the server sends a name", () => {
    render(
      <UploaderCell
        uploadedBy={OTHER}
        uploadedByName="Grace Hopper"
        sessionSs58={VIEWER}
        driveOwnerSs58={OWNER}
      />,
    );
    expect(screen.getByText("Grace Hopper")).toBeInTheDocument();
    expect(screen.queryByText("Owner")).toBeNull();
  });

  it("shows the ss58, shortened in the middle, for another member when no name is sent", () => {
    render(
      <UploaderCell
        uploadedBy={OTHER}
        sessionSs58={VIEWER}
        driveOwnerSs58={OWNER}
      />,
    );
    // Must not fall back to Owner — that label is only for the drive owner
    // (or the unattributed-but-was-private case when uploadedBy is missing).
    expect(screen.queryByText("Owner")).toBeNull();
    expect(screen.queryByText("You")).toBeNull();
    const cell = screen.getByText((_, el) => el?.getAttribute("data-ss58") === OTHER);
    expect(cell).toBeInTheDocument();
    expect(cell.textContent).not.toBe("Owner");
    // The whole address goes to a line that shortens it in the middle to the
    // column's width; no character budget first, no end ellipsis after.
    const line = cell.querySelector("[data-middle-truncate]");
    expect(line).not.toBeNull();
    expect(line?.className).not.toMatch(/\btruncate\b/);
  });
});

describe("UploaderCell attribution keys", () => {
  it("renders the name, never the email, when both keys are present", () => {
    render(
      <UploaderCell
        uploadedBy={OTHER}
        uploadedByName="Grace Hopper"
        uploadedByEmail="grace@example.com"
        sessionSs58={VIEWER}
        driveOwnerSs58={OWNER}
      />,
    );
    expect(screen.getByText("Grace Hopper")).toBeInTheDocument();
    expect(screen.queryByText("grace@example.com")).toBeNull();
  });
});
