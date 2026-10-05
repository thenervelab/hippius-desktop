import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { useDriveHighlight } from "../useDriveHighlight";
import {
  HIGHLIGHT_ATTRIBUTE,
  HIGHLIGHT_MS,
  HIGHLIGHT_RETRY_EVERY_MS,
  HIGHLIGHT_WAIT_MS,
  type HighlightRequest,
} from "../highlightEntry";

const file = (name: string): FormattedUserFile =>
  ({ name, actualFileName: name, isFolder: false }) as unknown as FormattedUserFile;
const level = (n: number) => Array.from({ length: n }, (_, i) => file(`${i}.png`));

/** A row as the table paints it. */
function paint(name: string): HTMLElement {
  const row = document.createElement("div");
  row.setAttribute("data-drive-entry", name);
  const control = document.createElement("button");
  row.appendChild(control);
  document.body.appendChild(row);
  return row;
}

type Props = Parameters<typeof useDriveHighlight>[0];

function setup(over: Partial<Props> = {}) {
  const calls = {
    done: vi.fn(),
    setPage: vi.fn(),
    refresh: vi.fn(),
    locate: vi.fn(async () => null as number | null),
  };
  const request: HighlightRequest = { label: "Work", folder: "Captures", name: "new.png", until: Date.now() + 60_000 };
  const base: Props = {
    request,
    onDone: calls.done,
    level: { label: "Work", folder: "Captures" },
    ready: true,
    ordered: level(3),
    rendered: {},
    serverPaged: false,
    paged: true,
    page: 1,
    pageSize: 20,
    setPage: calls.setPage,
    refresh: calls.refresh,
    locate: calls.locate,
    ...over,
  };
  const hook = renderHook((props: Props) => useDriveHighlight(props), { initialProps: base });
  return { ...calls, locate: base.locate, setPage: base.setPage, hook, base };
}

let scrollSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "Date"] });
  scrollSpy = vi.fn();
  HTMLElement.prototype.scrollIntoView = scrollSpy;
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("useDriveHighlight", () => {
  // The card offers Show in folder as soon as the file is written; the
  // folder's first listing can predate it.
  it("asks the listing again until the file is listed, then points it out", async () => {
    const { hook, base, refresh, done } = setup();
    await act(() => vi.advanceTimersByTimeAsync(HIGHLIGHT_RETRY_EVERY_MS));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();

    const row = paint("new.png");
    hook.rerender({ ...base, ordered: [...level(3), file("new.png")], rendered: {} });
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(row.hasAttribute(HIGHLIGHT_ATTRIBUTE)).toBe(true);
    expect(scrollSpy).toHaveBeenCalledWith(expect.objectContaining({ block: "center" }));
    expect(document.activeElement).toBe(row.querySelector("button"));
    expect(done).toHaveBeenCalledTimes(1);

    // The highlight fades and goes.
    await act(() => vi.advanceTimersByTimeAsync(HIGHLIGHT_MS));
    expect(row.hasAttribute(HIGHLIGHT_ATTRIBUTE)).toBe(false);
  });

  it("gives up quietly when the file never appears", async () => {
    const { done, refresh } = setup();
    for (let t = 0; t <= HIGHLIGHT_WAIT_MS; t += HIGHLIGHT_RETRY_EVERY_MS) {
      await act(() => vi.advanceTimersByTimeAsync(HIGHLIGHT_RETRY_EVERY_MS));
    }
    expect(done).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls.length).toBeGreaterThan(1);
    expect(document.querySelector(`[${HIGHLIGHT_ATTRIBUTE}]`)).toBeNull();
  });

  it("goes to the page that holds it before pointing it out", async () => {
    const rows = level(40);
    const { setPage, done } = setup({ ordered: rows, request: { label: "Work", folder: "Captures", name: "25.png", until: Date.now() + 60_000 } });
    expect(setPage).toHaveBeenCalledWith(2);
    expect(done).not.toHaveBeenCalled();
  });

  it("asks Rust which server page lists it, and goes there", async () => {
    const { locate, setPage } = setup({ serverPaged: true, locate: vi.fn(async () => 3) });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(locate).toHaveBeenCalledWith("new.png");
    expect(setPage).toHaveBeenCalledWith(3);
  });

  it("waits while another folder is on screen", async () => {
    const { setPage, refresh, done } = setup({ level: { label: "Work", folder: "" }, ordered: [file("new.png")] });
    await act(() => vi.advanceTimersByTimeAsync(HIGHLIGHT_RETRY_EVERY_MS * 2));
    expect(setPage).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });
});
