import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import InfoTooltip from "./info-tooltip";

const { openUrlMock } = vi.hoisted(() => ({ openUrlMock: vi.fn() }));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: openUrlMock,
}));

// Radix owns hover/focus visibility. Rendering its slots directly keeps these
// tests focused on our contract: accessible trigger copy and desktop-safe docs
// navigation from the action rendered inside the tooltip.
vi.mock("@radix-ui/react-tooltip", () => ({
  Provider: ({ children }: { children: ReactNode }) => children,
  Root: ({ children }: { children: ReactNode }) => children,
  Trigger: ({ children }: { children: ReactNode }) => children,
  Portal: ({ children }: { children: ReactNode }) => children,
  Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Arrow: () => null,
}));

describe("InfoTooltip", () => {
  beforeEach(() => {
    openUrlMock.mockReset();
  });

  it("opens the supplied documentation URL from Learn More", () => {
    const docsUrl = "https://docs.hippius.com/use/desktop/drive";

    render(
      <InfoTooltip ariaLabel="Drive information" learnMoreUrl={docsUrl}>
        Upload and sync encrypted files.
      </InfoTooltip>,
    );

    expect(
      screen.getByRole("button", { name: "Drive information" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Upload and sync encrypted files.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Learn More" }));

    expect(openUrlMock).toHaveBeenCalledOnce();
    expect(openUrlMock).toHaveBeenCalledWith(docsUrl);
  });

  it("omits the documentation action when no URL is supplied", () => {
    render(<InfoTooltip>Local-only information.</InfoTooltip>);

    expect(
      screen.getByRole("button", { name: "More information" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Learn More" }),
    ).not.toBeInTheDocument();
  });
});
