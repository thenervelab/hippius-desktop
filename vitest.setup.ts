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

// jsdom is missing the layout/pointer APIs Radix popover-style components
// (e.g. the shared `Select`) touch when they open: floating-ui observes the
// trigger with ResizeObserver, and the focused item is scrolled into view /
// pointer-captured. Stub them once here so any test can open those components
// without each spec re-declaring the same boilerplate. Guarded on `window`
// because a few pure-logic suites opt into the node environment.
if (typeof window !== "undefined") {
  if (!("ResizeObserver" in window)) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.assign(window, { ResizeObserver: ResizeObserverStub });
  }
  if (!window.HTMLElement.prototype.scrollIntoView) {
    window.HTMLElement.prototype.scrollIntoView = () => {};
  }
  if (!window.HTMLElement.prototype.hasPointerCapture) {
    window.HTMLElement.prototype.hasPointerCapture = () => false;
  }
  if (!window.HTMLElement.prototype.releasePointerCapture) {
    window.HTMLElement.prototype.releasePointerCapture = () => {};
  }
}
