// Coverage for `FinderShareListener`: it maps the backend's
// `finder:share-choosing` event onto the `finderShareAtom` `choosing` state that
// `ShareFileModal` renders its picker from. This is the ONLY signal path from a
// Finder right-click into the app after the redesign, so a broken map here means
// a click that silently does nothing.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import React from "react";

import FinderShareListener from "../FinderShareListener";
import { finderShareAtom } from "@/app/lib/global-atoms/sharesAtoms";

// `listen` captures each registered handler so the test can dispatch a Rust
// event by invoking it directly.
const listenHandlers = new Map<string, (event: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    listenHandlers.set(event, handler);
    return Promise.resolve(() => listenHandlers.delete(event));
  }),
}));

function renderWithStore() {
  const store = createStore();
  const { unmount } = render(
    <Provider store={store}>
      <FinderShareListener />
    </Provider>,
  );
  return { store, unmount };
}

describe("FinderShareListener", () => {
  beforeEach(() => listenHandlers.clear());

  it("registers a finder:share-choosing listener", async () => {
    renderWithStore();
    await waitFor(() => expect(listenHandlers.has("finder:share-choosing")).toBe(true));
  });

  it("maps the event payload onto the choosing atom", async () => {
    const { store } = renderWithStore();
    await waitFor(() => expect(listenHandlers.has("finder:share-choosing")).toBe(true));

    listenHandlers.get("finder:share-choosing")!({
      payload: {
        id: "req-42",
        name: "report.pdf",
        sizeBytes: 6_765_321,
        modifiedSecsAgo: 4,
        isFolder: true,
        isFolderCopy: true,
      },
    });

    expect(store.get(finderShareAtom)).toEqual({
      kind: "choosing",
      id: "req-42",
      name: "report.pdf",
      sizeBytes: 6_765_321,
      modifiedSecsAgo: 4,
      isFolder: true,
      isFolderCopy: true,
    });
  });

  // Rust could not read the drive roots, so it cannot say whether the
  // folder is in a drive. The explicit `null` must survive into the atom:
  // collapsing it to `false` would promise a live link for what may be a
  // copy.
  it("keeps an unknown folder placement unknown", async () => {
    const { store } = renderWithStore();
    await waitFor(() => expect(listenHandlers.has("finder:share-choosing")).toBe(true));

    listenHandlers.get("finder:share-choosing")!({
      payload: {
        id: "req-44",
        name: "Somewhere",
        sizeBytes: null,
        modifiedSecsAgo: 9,
        isFolder: true,
        isFolderCopy: null,
      },
    });

    expect(store.get(finderShareAtom)).toMatchObject({
      id: "req-44",
      isFolder: true,
      isFolderCopy: null,
    });
  });

  // An older backend emits only `{id, name}`. The chooser must still open —
  // degraded to no size, exactly what it showed before — rather than seeding
  // `undefined` into the atom and rendering "undefined B".
  it("tolerates a payload without the stat fields", async () => {
    const { store } = renderWithStore();
    await waitFor(() => expect(listenHandlers.has("finder:share-choosing")).toBe(true));

    listenHandlers.get("finder:share-choosing")!({
      payload: { id: "req-43", name: "legacy.pdf" },
    });

    expect(store.get(finderShareAtom)).toEqual({
      kind: "choosing",
      id: "req-43",
      name: "legacy.pdf",
      sizeBytes: null,
      modifiedSecsAgo: null,
      // An older backend says neither; it reads as a file share, as before.
      isFolder: false,
      isFolderCopy: false,
    });
  });
});
