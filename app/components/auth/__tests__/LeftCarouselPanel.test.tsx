import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SWIPE_CONTENT } from "../SwipeContent";

vi.mock("@/lib/theme-context", () => ({
  useAppTheme: () => ({ isLoaded: true, resolvedTheme: "light" }),
}));
vi.mock("../AuthTitleBar", () => ({ default: () => null }));
vi.mock("react-intersection-observer", () => ({
  InView: ({
    children,
  }: {
    children: (o: { inView: boolean; ref: () => void }) => React.ReactNode;
  }) => <>{children({ inView: true, ref: () => {} })}</>,
}));

import LeftCarouselPanel from "../LeftCarouselPanel";

describe("LeftCarouselPanel", () => {
  // A decoded GIF holds every frame in memory, and the sign-in screen can sit
  // open for a long time. Only the slide on screen may mount its clip.
  it("mounts only the active slide's clip", () => {
    const { container } = render(<LeftCarouselPanel />);
    const clips = container.querySelectorAll("img");
    expect(clips).toHaveLength(1);
    expect(clips[0].getAttribute("src")).toBe(SWIPE_CONTENT[0].gif);
  });

  it("lists every slide's title", () => {
    const { getByText } = render(<LeftCarouselPanel />);
    for (const slide of SWIPE_CONTENT) {
      expect(getByText(slide.title)).toBeInTheDocument();
    }
  });
});
