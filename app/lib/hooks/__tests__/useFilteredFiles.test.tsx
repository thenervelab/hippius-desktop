import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { useFilteredFiles, type FileFilterRequest } from "../useFilteredFiles";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

// The no-op path never calls the IPC; mock it so the import resolves and any
// non-no-op path stays inert in the test.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve([])),
}));

const FILES = [] as FormattedUserFile[];

/**
 * Mount a component that calls `useFilteredFiles` with criteria built FRESH on
 * every render — mirroring how `DriveContainer` builds `criteria` inline. A
 * render loop manifests as either a thrown "Maximum update depth exceeded" or
 * an unbounded render count, so we assert on both.
 */
function mountWithFreshCriteria(makeCriteria: () => FileFilterRequest) {
  let renders = 0;
  function Harness() {
    renders += 1;
    useFilteredFiles(FILES, makeCriteria());
    return null;
  }
  const result = render(<Harness />);
  return { renders: () => renders, ...result };
}

describe("useFilteredFiles", () => {
  it("does not loop when a no-op criterion is passed by a fresh reference each render", () => {
    // Regression: the files page passes `fileExtensions: <new []>` every
    // render. The old reference-keyed identity + unconditional forceRender in
    // the no-op branch re-rendered the host forever (the main-screen
    // "Maximum update depth exceeded" crash). It must now settle immediately.
    expect(() =>
      mountWithFreshCriteria(() => ({ fileExtensions: [] })),
    ).not.toThrow();

    const { renders } = mountWithFreshCriteria(() => ({ fileExtensions: [] }));
    expect(renders()).toBeLessThan(5);
  });

  it("does not loop when an empty no-op criteria object is passed fresh each render", () => {
    const { renders } = mountWithFreshCriteria(() => ({}));
    expect(renders()).toBeLessThan(5);
  });
});
