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
  });
});
