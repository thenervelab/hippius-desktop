import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

const {
  GIFS_DISABLED_MESSAGE,
  GIFS_THROTTLED_MESSAGE,
  GifsThrottledError,
  GifsUnavailableError,
  featuredGifs,
  gifErrorMessage,
  isGifsUnavailable,
  probeGifsAvailability,
  searchGifs,
  unwrapGifFetch,
} = await import("@/lib/chat/gifs-api");

const PAGE = {
  kind: "page" as const,
  results: [
    {
      id: "a",
      title: "Alpha",
      preview: {
        url: "https://media1.giphy.com/media/a/100w.gif",
        width: 200,
        height: 120,
      },
      full: {
        url: "https://media1.giphy.com/media/a/giphy.gif",
        width: 400,
        height: 240,
        size: 1000,
      },
      mp4: null,
    },
  ],
  next: "cursor-2",
  attribution: "Powered by GIPHY",
};

beforeEach(() => tauri.reset());

describe("unwrapGifFetch", () => {
  it("returns the page and throws the typed errors for the two rendered statuses", () => {
    expect(unwrapGifFetch(PAGE)).toEqual({
      results: PAGE.results,
      next: "cursor-2",
      attribution: "Powered by GIPHY",
    });
    expect(() =>
      unwrapGifFetch({ kind: "disabled", code: "gifs_not_configured" }),
    ).toThrow(GifsUnavailableError);
    expect(() => unwrapGifFetch({ kind: "throttled" })).toThrow(
      GifsThrottledError,
    );
  });
});

describe("searchGifs / featuredGifs", () => {
  it("forward the query, cursor and the webview locale to Rust", async () => {
    const search = vi.fn(() => PAGE);
    const featured = vi.fn(() => PAGE);
    tauri.onInvoke("chat_gifs_search", search);
    tauri.onInvoke("chat_gifs_featured", featured);

    await expect(searchGifs("cat", { pos: "c1" })).resolves.toMatchObject({
      next: "cursor-2",
    });
    expect(search).toHaveBeenCalledWith({
      q: "cat",
      pos: "c1",
      limit: null,
      locale: navigator.language,
    });

    await featuredGifs({ limit: 1 });
    expect(featured).toHaveBeenCalledWith({
      pos: null,
      limit: 1,
      locale: navigator.language,
    });
  });

  it("a 503 from Rust becomes GifsUnavailableError with the backend's code", async () => {
    tauri.onInvoke("chat_gifs_featured", () => ({
      kind: "disabled",
      code: "gifs_not_configured",
    }));
    const error = await featuredGifs().catch((e: unknown) => e);
    expect(isGifsUnavailable(error)).toBe(true);
    expect((error as InstanceType<typeof GifsUnavailableError>).code).toBe(
      "gifs_not_configured",
    );
    expect(gifErrorMessage(error)).toBe(GIFS_DISABLED_MESSAGE);
  });

  it("a 429 becomes a retryable throttle message, not a disabled state", async () => {
    tauri.onInvoke("chat_gifs_search", () => ({ kind: "throttled" }));
    const error = await searchGifs("cat").catch((e: unknown) => e);
    expect(isGifsUnavailable(error)).toBe(false);
    expect(gifErrorMessage(error)).toBe(GIFS_THROTTLED_MESSAGE);
  });
});

describe("probeGifsAvailability", () => {
  it("asks for one featured GIF and answers false only on the explicit 503", async () => {
    const featured = vi.fn(() => PAGE);
    tauri.onInvoke("chat_gifs_featured", featured);
    await expect(probeGifsAvailability()).resolves.toBe(true);
    expect(featured).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1 }),
    );

    tauri.onInvoke("chat_gifs_featured", () => ({
      kind: "disabled",
      code: null,
    }));
    await expect(probeGifsAvailability()).resolves.toBe(false);
  });

  it("leaves a transient failure to the caller (rejects) rather than reporting disabled", async () => {
    tauri.onInvoke("chat_gifs_featured", () => {
      throw { kind: "Other", message: "network down" };
    });
    await expect(probeGifsAvailability()).rejects.toBeTruthy();
  });
});

describe("gifErrorMessage", () => {
  it("reads a Rust AppError object and falls back to a generic line", () => {
    expect(gifErrorMessage({ kind: "Api", message: "GIF proxy: 500" })).toBe(
      "GIF proxy: 500",
    );
    expect(gifErrorMessage(new Error("boom"))).toBe("boom");
    expect(gifErrorMessage({})).toBe("Could not load GIFs");
    expect(gifErrorMessage(undefined)).toBe("Could not load GIFs");
  });
});
