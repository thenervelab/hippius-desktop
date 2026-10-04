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
      // Already sized, so nothing is pending.
      sizePending: false,
      refusal: null,
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
      sizePending: false,
      refusal: null,
    });
  });

  // An outside folder's chooser opens before Rust has scanned it; the size,
  // or the share's refusal, follows in `finder:share-facts`.
  describe("finder:share-facts", () => {
    async function openFolderCopy(id: string) {
      const rendered = renderWithStore();
      await waitFor(() => expect(listenHandlers.has("finder:share-facts")).toBe(true));
      listenHandlers.get("finder:share-choosing")!({
        payload: {
          id,
          name: "T2-KD",
          sizeBytes: null,
          modifiedSecsAgo: 30,
          isFolder: true,
          isFolderCopy: true,
        },
      });
      return rendered;
    }

    it("marks a folder copy's size as pending until the facts arrive", async () => {
      const { store } = await openFolderCopy("req-50");
      expect(store.get(finderShareAtom)).toMatchObject({ sizeBytes: null, sizePending: true });

      listenHandlers.get("finder:share-facts")!({
        payload: { id: "req-50", sizeBytes: 3_048, refusal: null },
      });

      expect(store.get(finderShareAtom)).toMatchObject({
        id: "req-50",
        sizeBytes: 3_048,
        sizePending: false,
        refusal: null,
      });
    });

    it("carries the share's refusal into the chooser", async () => {
      const { store } = await openFolderCopy("req-51");
      const refusal = { kind: "Validation", message: "This folder has no files to share." };

      listenHandlers.get("finder:share-facts")!({
        payload: { id: "req-51", sizeBytes: null, refusal },
      });

      expect(store.get(finderShareAtom)).toMatchObject({ sizeBytes: null, sizePending: false, refusal });
    });

    // A newer click replaced the chooser; the older folder's facts must not
    // land on it (Rust drops them too, but an emit can race the new click).
    it("ignores facts for a chooser that is no longer open", async () => {
      const { store } = await openFolderCopy("req-52");
      const before = store.get(finderShareAtom);

      listenHandlers.get("finder:share-facts")!({
        payload: { id: "req-older", sizeBytes: 9_999, refusal: null },
      });

      expect(store.get(finderShareAtom)).toBe(before);
    });
  });
});
