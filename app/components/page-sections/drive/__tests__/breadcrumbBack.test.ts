import { describe, it, expect, vi } from "vitest";
import { resolveBreadcrumbBack } from "../breadcrumbBack";

describe("resolveBreadcrumbBack", () => {
  // At the root there is nowhere to go up to. Rendering a disabled control
  // would be a permanent dead button on the most-visited view.
  it("offers nothing at the root", () => {
    expect(resolveBreadcrumbBack([], vi.fn())).toBeNull();
  });

  it("goes to the folder list from one level deep", () => {
    const root = vi.fn();
    const back = resolveBreadcrumbBack([{ label: "chains" }], root);
    expect(back?.label).toBe("Back to all folders");
    back?.go();
    expect(root).toHaveBeenCalledOnce();
  });

  // Names the parent, so the user does not have to work out which word in
  // the trail is the one above them.
  it("names the parent when deeper in", () => {
    const parent = vi.fn();
    const back = resolveBreadcrumbBack(
      [{ label: "chains" }, { label: "Photos", onClick: parent }, { label: "2024" }],
      vi.fn(),
    );
    expect(back?.label).toBe("Back to Photos");
    back?.go();
    expect(parent).toHaveBeenCalledOnce();
  });

  // A button that does nothing is worse than one that overshoots: the
  // user's intent is to get out, and the root still serves that.
  it("falls back to the root when the parent has no handler", () => {
    const root = vi.fn();
    const back = resolveBreadcrumbBack(
      [{ label: "chains" }, { label: "Photos" }, { label: "2024" }],
      root,
    );
    back?.go();
    expect(root).toHaveBeenCalledOnce();
  });
});
