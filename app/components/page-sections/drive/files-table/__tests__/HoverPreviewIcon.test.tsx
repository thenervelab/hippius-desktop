import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { HoverPreviewIcon } from "../HoverPreviewIcon";

describe("HoverPreviewIcon", () => {
  it("renders the icon by default", () => {
    render(
      <HoverPreviewIcon>
        <span data-testid="icon" />
      </HoverPreviewIcon>,
    );
    expect(screen.getByTestId("hover-preview-icon")).toBeInTheDocument();
    expect(screen.getByTestId("icon")).toBeInTheDocument();
  });

  it("renders nothing when hidden, so it can't overlap a status pill", () => {
    // Failed rows pass `hidden` so the hover icon doesn't fade in on top of
    // their persistent "Failed" pill — the bug this guards against.
    const { container } = render(
      <HoverPreviewIcon hidden>
        <span data-testid="icon" />
      </HoverPreviewIcon>,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("icon")).not.toBeInTheDocument();
  });
});
