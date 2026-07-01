import "@testing-library/jest-dom";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// React Testing Library does not auto-unmount between tests under Vitest, so a
// tree mounted by one test can leak its DOM nodes and event listeners into the
// next one (stale `screen` queries, double-fired listeners). Unmounting after
// every test gives each test a clean jsdom document. Wired globally via
// `test.setupFiles` so individual specs no longer repeat this boilerplate.
afterEach(() => {
  cleanup();
});
