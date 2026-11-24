import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { Provider, createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import React from "react";

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { DriveStarMark, StarMark } from "../StarMark";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);
vi.mock("@/app/lib/wallet-auth-context", () => ({ useWalletAuth: () => ({ polkadotAddress: "5Me" }) }));

const HASH = "0123456789abcdef";

function renderWith(node: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = createStore();
  store.set(queryClientAtom, queryClient);
  return render(<Provider store={store}>{node}</Provider>);
}

const folder: FormattedUserFile = {
  name: "Trips",
  actualFileName: "Trips",
  createdAt: 0,
  arionHash: "",
  arionCid: "",
  minerIds: [],
  isAssigned: true,
  lastChargedAt: 0,
  isFolder: true,
  isErasureCoded: false,
  mainReqHash: "",
  label: "Photos",
};

beforeEach(() => {
  tauri.reset();
  tauri.onInvoke("star_scopes", (args) =>
    Object.fromEntries(((args?.labels as string[]) ?? []).map((l) => [l, { ownerSs58: "5Me", folderHash: HASH, rootPath: "" }])),
  );
  tauri.onInvoke("list_starred", () => ({
    available: true,
    items: [{ key: `5Me|${HASH}|drive` }, { key: `5Me|${HASH}|d:2026/Trips` }],
  }));
});

describe("StarMark", () => {
  it("marks a starred drive and a starred folder, and says Starred to a screen reader", async () => {
    renderWith(
      <>
        <DriveStarMark label="Photos" />
        <StarMark file={folder} basePath="2026" />
      </>,
    );
    expect((await screen.findAllByRole("img", { name: "Starred" })).length).toBe(2);
  });

  it("draws nothing for an item that is not starred, and trusts the row's own answer", async () => {
    renderWith(
      <>
        <StarMark file={folder} basePath="Elsewhere" />
        <StarMark file={{ ...folder, favorite: false }} basePath="2026" />
        <span>done</span>
      </>,
    );
    await screen.findByText("done");
    // Give the listing and the scope time to land.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("img", { name: "Starred" })).toBeNull();
  });
});
