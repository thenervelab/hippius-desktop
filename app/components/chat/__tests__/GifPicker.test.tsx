import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { ComponentProps } from "react";

import { gifsAvailabilityAtom } from "@/components/chat/chat-ui-atoms";
import type { GifPage, GifResult } from "@/lib/chat/gifs-api";

type GifsApi = typeof import("@/lib/chat/gifs-api");
const searchGifs = vi.fn<GifsApi["searchGifs"]>();
const featuredGifs = vi.fn<GifsApi["featuredGifs"]>();
vi.mock("@/lib/chat/gifs-api", async () => {
  const actual = await vi.importActual<GifsApi>("@/lib/chat/gifs-api");
  return {
    ...actual,
    searchGifs: (...args: Parameters<typeof searchGifs>) => searchGifs(...args),
    featuredGifs: (...args: Parameters<typeof featuredGifs>) =>
      featuredGifs(...args),
  };
});

const { default: GifPicker } = await import("@/components/chat/GifPicker");
const { GifsUnavailableError } = await import("@/lib/chat/gifs-api");

const gif = (id: string, title: string): GifResult => ({
  id,
  title,
  preview: {
    url: `https://media1.giphy.com/media/${id}/100w.gif`,
    width: 200,
    height: 120,
  },
  full: {
    url: `https://media1.giphy.com/media/${id}/giphy.gif`,
    width: 400,
    height: 240,
    size: 1000,
  },
  mp4: null,
});

const page = (results: GifResult[], extra: Partial<GifPage> = {}): GifPage => ({
  results,
  next: null,
  attribution: "Powered by GIPHY",
  ...extra,
});

const TRENDING = page([
  gif("a", "Alpha"),
  gif("b", "Bravo"),
  gif("c", "Charlie"),
  gif("d", "Delta"),
]);

function renderPicker(props: Partial<ComponentProps<typeof GifPicker>> = {}) {
  const store = createStore();
  const onPick = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <Provider store={store}>
      <GifPicker
        open
        onOpenChange={onOpenChange}
        onPick={onPick}
        trigger={<button type="button">GIF</button>}
        {...props}
      />
    </Provider>,
  );
  return { store, onPick, onOpenChange };
}

describe("GifPicker", () => {
  beforeEach(() => {
    vi.useRealTimers();
    searchGifs.mockReset();
    featuredGifs.mockReset();
    featuredGifs.mockResolvedValue(TRENDING);
  });

  it("shows Trending from the featured endpoint when the search is empty, with the attribution the proxy sent", async () => {
    renderPicker();
    expect(
      await screen.findByRole("option", { name: "Alpha" }),
    ).toBeInTheDocument();
    expect(featuredGifs).toHaveBeenCalledWith({ pos: null });
    expect(searchGifs).not.toHaveBeenCalled();
    expect(screen.getByText("Trending")).toBeInTheDocument();
    expect(screen.getByTestId("gif-attribution")).toHaveTextContent(
      "Powered by GIPHY",
    );
    // Previews are the small renditions, lazy-loaded.
    const img = screen
      .getByRole("option", { name: "Alpha" })
      .querySelector("img");
    expect(img).toHaveAttribute(
      "src",
      "https://media1.giphy.com/media/a/100w.gif",
    );
    expect(img).toHaveAttribute("loading", "lazy");
  });

  it("shows whatever attribution the proxy sends, and none when it sends nothing", async () => {
    featuredGifs.mockResolvedValue(
      page([gif("a", "Alpha")], { attribution: "Powered by Tenor" }),
    );
    renderPicker();
    await screen.findByRole("option", { name: "Alpha" });
    expect(screen.getByTestId("gif-attribution")).toHaveTextContent(
      "Powered by Tenor",
    );
  });

  it("does not invent an attribution when the proxy sends none", async () => {
    featuredGifs.mockResolvedValue(
      page([gif("a", "Alpha")], { attribution: null }),
    );
    renderPicker();
    await screen.findByRole("option", { name: "Alpha" });
    expect(screen.queryByTestId("gif-attribution")).not.toBeInTheDocument();
    expect(screen.queryByText(/powered by/i)).not.toBeInTheDocument();
  });

  it("debounces the search by 300 ms and hits the search endpoint once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    searchGifs.mockResolvedValue(page([gif("x", "X-ray")]));
    renderPicker();
    await screen.findByRole("option", { name: "Alpha" });

    const input = screen.getByRole("textbox", { name: "Search GIFs" });
    fireEvent.change(input, { target: { value: "ca" } });
    fireEvent.change(input, { target: { value: "cat" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(searchGifs).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(searchGifs).toHaveBeenCalledTimes(1);
    expect(searchGifs).toHaveBeenCalledWith("cat", { pos: null });
    expect(
      await screen.findByRole("option", { name: "X-ray" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Results for “cat”")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("navigates with the arrow keys in a two-column grid and picks with Enter", async () => {
    const { onPick, onOpenChange } = renderPicker();
    await screen.findByRole("option", { name: "Alpha" });
    const grid = screen.getByRole("listbox", { name: "GIFs" });
    const selected = () =>
      screen.getByRole("option", { selected: true }).getAttribute("aria-label");

    expect(selected()).toBe("Alpha");
    grid.focus();
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(selected()).toBe("Bravo");
    fireEvent.keyDown(grid, { key: "ArrowDown" }); // +2 columns
    expect(selected()).toBe("Delta");
    fireEvent.keyDown(grid, { key: "ArrowLeft" });
    expect(selected()).toBe("Charlie");
    fireEvent.keyDown(grid, { key: "ArrowUp" });
    expect(selected()).toBe("Alpha");
    fireEvent.keyDown(grid, { key: "End" });
    expect(selected()).toBe("Delta");
    fireEvent.keyDown(grid, { key: "ArrowRight" }); // clamps at the end
    expect(selected()).toBe("Delta");

    fireEvent.keyDown(grid, { key: "Enter" });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toMatchObject({ id: "d", title: "Delta" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("moves from the search field into the grid with ArrowDown and closes on Escape", async () => {
    const { onOpenChange } = renderPicker();
    await screen.findByRole("option", { name: "Alpha" });
    const input = screen.getByRole("textbox", { name: "Search GIFs" });
    const grid = screen.getByRole("listbox", { name: "GIFs" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(grid).toHaveFocus();
    fireEvent.keyDown(grid, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("picks on click too", async () => {
    const { onPick } = renderPicker();
    fireEvent.click(await screen.findByRole("option", { name: "Charlie" }));
    expect(onPick.mock.calls[0][0]).toMatchObject({ id: "c" });
  });

  it("marks GIFs as disabled for the session when a page answers 503, and keeps the popover open to say so", async () => {
    featuredGifs.mockRejectedValue(
      new GifsUnavailableError("gifs_not_configured"),
    );
    const { store, onOpenChange } = renderPicker();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "GIFs are not enabled on this deployment",
    );
    await waitFor(() =>
      expect(store.get(gifsAvailabilityAtom)).toBe("disabled"),
    );
    // Nothing to retry on a deployment without a key; the picker itself stays.
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Search GIFs" }),
    ).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("marks GIFs as ready after a successful page", async () => {
    const { store } = renderPicker();
    await screen.findByRole("option", { name: "Alpha" });
    expect(store.get(gifsAvailabilityAtom)).toBe("ready");
  });

  it("reports other failures inline with a Retry, keeps the popover open and does not disable GIFs", async () => {
    featuredGifs.mockRejectedValueOnce(new Error("boom"));
    const { store, onOpenChange } = renderPicker();
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(store.get(gifsAvailabilityAtom)).toBe("unknown");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: "Search GIFs" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("option", { name: "Alpha" }),
    ).toBeInTheDocument();
    expect(featuredGifs).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(store.get(gifsAvailabilityAtom)).toBe("ready");
  });

  it("reaches Retry from the keyboard: ArrowDown leaves the search field on the button, Enter retries, ArrowUp returns", async () => {
    // Radix menus swallow Tab, so the arrow keys are the only way down from the field.
    featuredGifs.mockRejectedValueOnce(new Error("boom"));
    renderPicker();
    const retry = await screen.findByRole("button", { name: "Retry" });
    const input = screen.getByRole("textbox", { name: "Search GIFs" });
    const grid = screen.getByRole("listbox", { name: "GIFs" });
    // The empty list is not a focus stop of its own while the button is the thing to reach.
    expect(grid).toHaveAttribute("tabindex", "-1");

    input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(retry).toHaveFocus();
    fireEvent.keyDown(retry, { key: "ArrowUp" });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(retry).toHaveFocus();

    // A native button activates on Enter with a click.
    fireEvent.click(retry);
    expect(
      await screen.findByRole("option", { name: "Alpha" }),
    ).toBeInTheDocument();
    expect(featuredGifs).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("listbox", { name: "GIFs" })).toHaveAttribute(
      "tabindex",
      "0",
    );
  });

  it("greys the trigger out with an explanation when disabled, and never fetches", async () => {
    renderPicker({ open: false, disabled: true });
    const trigger = screen.getByRole("button", { name: "GIF" });
    expect(trigger).toHaveAttribute("data-disabled");
    const wrapper = screen.getByTestId("gif-trigger-disabled");
    await act(async () => {
      fireEvent.pointerMove(wrapper);
      fireEvent.pointerEnter(wrapper);
      fireEvent.focus(wrapper);
    });
    expect(
      await screen.findAllByText("GIFs are not enabled on this deployment"),
    ).not.toHaveLength(0);
    expect(featuredGifs).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("textbox", { name: "Search GIFs" }),
    ).not.toBeInTheDocument();
  });

  it("opens pre-filled from the slash command", async () => {
    searchGifs.mockResolvedValue(page([gif("h", "High five")]));
    renderPicker({ initialQuery: "high five" });
    expect(screen.getByRole("textbox", { name: "Search GIFs" })).toHaveValue(
      "high five",
    );
    expect(
      await screen.findByRole("option", { name: "High five" }),
    ).toBeInTheDocument();
    expect(searchGifs).toHaveBeenCalledWith("high five", { pos: null });
  });
});
