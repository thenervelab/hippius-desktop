import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import HostedRootNote, { hostedRootMessage } from "../HostedRootNote";

describe("hostedRootMessage", () => {
  it("names the other provider and that Finder sharing will not appear there", () => {
    const message = hostedRootMessage({
      kind: "fileProvider",
      name: "Google Drive",
    });
    expect(message).toContain("inside Google Drive");
    expect(message).toContain("Share with Hippius");
    expect(message).toContain("download each file");
  });

  it("names a macOS special folder without claiming another provider will download files", () => {
    const message = hostedRootMessage({
      kind: "specialFolder",
      name: "Documents",
    });
    expect(message).toContain("Documents");
    expect(message).toContain("special");
    expect(message).not.toContain("download each file");
  });
});

describe("HostedRootNote", () => {
  it("renders the message as a note", () => {
    render(
      <HostedRootNote host={{ kind: "fileProvider", name: "Dropbox" }} />,
    );
    expect(screen.getByRole("note")).toHaveTextContent("inside Dropbox");
  });
});
