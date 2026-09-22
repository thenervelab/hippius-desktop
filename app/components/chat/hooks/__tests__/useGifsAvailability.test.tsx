import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { useState } from "react";

import {
  gifsAvailabilityAtom,
  gifsProbeAtom,
} from "@/components/chat/chat-ui-atoms";

// The probe and the picker's pages are IPCs into Rust; mock at that boundary
// so the whole TS layer (wrapper → gifs-api → hook) runs for real.
const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

const { useGifsAvailability } =
  await import("@/components/chat/hooks/useGifsAvailability");
const { default: GifPicker } = await import("@/components/chat/GifPicker");

const EMPTY_PAGE = {
  kind: "page",
  results: [],
  next: null,
  attribution: "Powered by GIPHY",
};
const DISABLED = { kind: "disabled", code: "gifs_not_configured" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderAvailability() {
  const store = createStore();
  const hook = renderHook(() => useGifsAvailability(), {
    wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
  });
  return { store, ...hook };
}

/** The composer's wiring: hover/focus probes, `disabled` greys the trigger. */
function ComposerGifButton() {
  const { availability, ensure } = useGifsAvailability();
  const [open, setOpen] = useState(false);
  return (
    <GifPicker
      open={open}
      onOpenChange={setOpen}
      disabled={availability === "disabled"}
      onPick={() => {}}
      trigger={
        <button
          type="button"
          aria-label="Insert GIF"
          disabled={availability === "disabled"}
          onPointerEnter={() => void ensure()}
          onFocus={() => void ensure()}
        >
          GIF
        </button>
      }
    />
  );
}

const featured = vi.fn<(args: unknown) => unknown>();

beforeEach(() => {
  tauri.reset();
  featured.mockReset();
  tauri.onInvoke("chat_gifs_featured", (args) => featured(args));
});

describe("useGifsAvailability", () => {
  it("probes once with limit=1 and settles `ready` when the proxy answers", async () => {
    featured.mockResolvedValue(EMPTY_PAGE);
    const { store, result } = renderAvailability();
    expect(result.current.availability).toBe("unknown");

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.ensure();
    });
    expect(outcome).toBe("ready");
    expect(result.current.availability).toBe("ready");
    expect(featured).toHaveBeenCalledTimes(1);
    expect(featured).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1 }),
    );
    expect(store.get(gifsProbeAtom)).toBeNull();

    // Settled for the session: no second request.
    await act(async () => {
      await result.current.ensure();
    });
    expect(featured).toHaveBeenCalledTimes(1);
  });

  it("settles `disabled` on the backend's 503 and never asks again", async () => {
    featured.mockResolvedValue(DISABLED);
    const { result } = renderAvailability();
    await act(async () => {
      await expect(result.current.ensure()).resolves.toBe("disabled");
    });
    expect(result.current.availability).toBe("disabled");
    await act(async () => {
      await result.current.ensure();
    });
    expect(featured).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight probe between concurrent callers", async () => {
    const pending = deferred<typeof EMPTY_PAGE>();
    featured.mockReturnValue(pending.promise);
    const { store, result } = renderAvailability();

    const first = result.current.ensure();
    const second = result.current.ensure();
    expect(featured).toHaveBeenCalledTimes(1);
    expect(store.get(gifsProbeAtom)).toBe(first);
    expect(second).toBe(first);

    await act(async () => {
      pending.resolve(EMPTY_PAGE);
      await first;
    });
    expect(result.current.availability).toBe("ready");
    expect(store.get(gifsProbeAtom)).toBeNull();
  });

  it("leaves the question open on a transient failure, so a later call probes again", async () => {
    featured
      .mockRejectedValueOnce({ kind: "Api", message: "network down" })
      .mockResolvedValueOnce(EMPTY_PAGE);
    const { store, result } = renderAvailability();
    await act(async () => {
      await expect(result.current.ensure()).resolves.toBe("unknown");
    });
    expect(result.current.availability).toBe("unknown");
    expect(store.get(gifsProbeAtom)).toBeNull();

    await act(async () => {
      await expect(result.current.ensure()).resolves.toBe("ready");
    });
    expect(featured).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite an answer the picker settled while the probe was in flight", async () => {
    const pending = deferred<typeof EMPTY_PAGE>();
    featured.mockReturnValue(pending.promise);
    const { store, result } = renderAvailability();
    const probe = result.current.ensure();
    act(() => store.set(gifsAvailabilityAtom, "disabled"));
    await act(async () => {
      pending.resolve(EMPTY_PAGE);
      await expect(probe).resolves.toBe("disabled");
    });
    expect(store.get(gifsAvailabilityAtom)).toBe("disabled");
  });
});

describe("composer GIF button with the availability probe", () => {
  it("hovering probes once; on gifs_not_configured the button greys out with the explanation and never opens", async () => {
    featured.mockResolvedValue(DISABLED);
    const store = createStore();
    render(
      <Provider store={store}>
        <ComposerGifButton />
      </Provider>,
    );
    const button = () => screen.getByRole("button", { name: "Insert GIF" });
    expect(button()).toBeEnabled();

    await act(async () => {
      fireEvent.pointerEnter(button());
    });
    // The greyed-out trigger is re-rendered under its tooltip: query afresh.
    await waitFor(() => expect(button()).toBeDisabled());
    expect(featured).toHaveBeenCalledTimes(1);
    expect(featured).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1 }),
    );
    expect(store.get(gifsAvailabilityAtom)).toBe("disabled");

    // The tooltip explains; the picker never renders.
    const wrapper = screen.getByTestId("gif-trigger-disabled");
    await act(async () => {
      fireEvent.pointerMove(wrapper);
      fireEvent.pointerEnter(wrapper);
      fireEvent.focus(wrapper);
    });
    expect(
      await screen.findAllByText("GIFs are not enabled on this deployment"),
    ).not.toHaveLength(0);
    fireEvent.click(button());
    expect(
      screen.queryByRole("textbox", { name: "Search GIFs" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // Only the probe: opening never asked for a page.
    expect(featured).toHaveBeenCalledTimes(1);
  });

  it("when the proxy is configured the button stays enabled and opens the picker", async () => {
    featured.mockResolvedValue(EMPTY_PAGE);
    render(
      <Provider store={createStore()}>
        <ComposerGifButton />
      </Provider>,
    );
    const button = screen.getByRole("button", { name: "Insert GIF" });
    await act(async () => {
      fireEvent.pointerEnter(button);
    });
    await waitFor(() =>
      expect(featured).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 1 }),
      ),
    );
    expect(button).toBeEnabled();

    await act(async () => {
      fireEvent.keyDown(button, { key: "Enter" });
    });
    expect(
      await screen.findByRole("textbox", { name: "Search GIFs" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(featured).toHaveBeenCalledWith(
        expect.objectContaining({ pos: null, limit: null }),
      ),
    );
  });
});
