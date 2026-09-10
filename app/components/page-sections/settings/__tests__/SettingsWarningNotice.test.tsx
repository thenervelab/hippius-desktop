// Settings standing notices must sit in the same card family as the
// rows around them. A content-hugging highlighter-yellow box next to
// those rows is the look this pins against.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import { SettingsWarningNotice } from "../SettingsWarningNotice";

describe("SettingsWarningNotice", () => {
  it("renders title and description as a note", () => {
    render(
      <SettingsWarningNotice
        title="Keep your API key secure"
        description="Never share your API token with anyone."
      />,
    );

    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Keep your API key secure");
    expect(note).toHaveTextContent("Never share your API token with anyone.");
  });

  it("is a full-width settings card, not a yellow sticker", () => {
    render(
      <SettingsWarningNotice
        title="Keep your Mnemonic key secure"
        description="If you lose it, it is gone."
      />,
    );

    const note = screen.getByRole("note");
    expect(note.className).toContain("w-full");
    expect(note.className).toContain("rounded-[8px]");
    expect(note.className).not.toContain("w-fit");
    expect(note.className).not.toContain("feb101");
    expect(note.className).not.toContain("#feb101");
  });

  it("shows a warning icon by default", () => {
    render(
      <SettingsWarningNotice
        title="Keep your API key secure"
        description="Treat it like a password."
      />,
    );

    expect(screen.getByRole("note").querySelector("svg")).not.toBeNull();
  });

  it("uses a caller-supplied icon instead of the default", () => {
    render(
      <SettingsWarningNotice
        title="Keep your API key secure"
        description="Treat it like a password."
        icon={<span data-testid="custom-icon" />}
      />,
    );

    expect(screen.getByTestId("custom-icon")).toBeInTheDocument();
    expect(screen.getByRole("note").querySelector("svg")).toBeNull();
  });
});
