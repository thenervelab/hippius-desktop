import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoaderCallbacks, LoaderConfiguration, LoaderContext } from "hls.js";

/**
 * hls.js asks for `hippius-video://<session>/<name>`; the loader turns that
 * into `video_preview_segment` and hands hls.js text for the playlist and
 * bytes for a segment. A load the player abandoned (a seek) is never
 * reported, and Rust's NotFound is a 404 (no retries) where anything else
 * is a 500 hls.js retries.
 */
const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);

import { HLS_PREVIEW_CONFIG, IpcLoader, parseStreamUrl } from "../hlsIpcLoader";

const config = {} as LoaderConfiguration;

function callbacks() {
  return {
    onSuccess: vi.fn(),
    onError: vi.fn(),
    onTimeout: vi.fn(),
  } as unknown as LoaderCallbacks<LoaderContext> & {
    onSuccess: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
  };
}

function context(url: string, responseType: "text" | "arraybuffer"): LoaderContext {
  return { url, responseType } as LoaderContext;
}

beforeEach(() => tauri.reset());

describe("parseStreamUrl", () => {
  it("reads the session and file out of a stream URL", () => {
    expect(parseStreamUrl("hippius-video://abc-1/index.m3u8")).toEqual({ sessionId: "abc-1", name: "index.m3u8" });
    expect(parseStreamUrl("hippius-video://abc-1/12.ts?x=1")).toEqual({ sessionId: "abc-1", name: "12.ts" });
  });

  it("refuses anything that is not one", () => {
    for (const url of ["https://x/index.m3u8", "hippius-video://", "hippius-video:///0.ts", "hippius-video://a/", "hippius-video://a/b/0.ts"]) {
      expect(parseStreamUrl(url)).toBeNull();
    }
  });
});

describe("IpcLoader", () => {
  it("gives hls.js the playlist as text and a segment as bytes", async () => {
    const playlist = new TextEncoder().encode("#EXTM3U\n").buffer;
    const segment = new Uint8Array([0x47, 1, 2]).buffer;
    tauri.onInvoke("video_preview_segment", (args) =>
      (args as { name: string }).name === "index.m3u8" ? playlist : segment,
    );

    const cb = callbacks();
    const loader = new IpcLoader();
    loader.load(context("hippius-video://s/index.m3u8", "text"), config, cb);
    await vi.waitFor(() => expect(cb.onSuccess).toHaveBeenCalled());
    expect(tauri.core.invoke).toHaveBeenCalledWith("video_preview_segment", { sessionId: "s", name: "index.m3u8" });
    expect(cb.onSuccess.mock.calls[0][0]).toMatchObject({ data: "#EXTM3U\n", code: 200 });

    const cb2 = callbacks();
    const loader2 = new IpcLoader();
    loader2.load(context("hippius-video://s/3.ts", "arraybuffer"), config, cb2);
    await vi.waitFor(() => expect(cb2.onSuccess).toHaveBeenCalled());
    expect(cb2.onSuccess.mock.calls[0][0].data).toBe(segment);
    expect(loader2.stats.loaded).toBe(3);
  });

  it("maps Rust's NotFound to a 404 and other failures to a 500", async () => {
    tauri.onInvoke("video_preview_segment", (args) => {
      throw (args as { name: string }).name === "99.ts"
        ? { kind: "NotFound", message: "video segment" }
        : { kind: "Other", message: "engine failed" };
    });
    const missing = callbacks();
    new IpcLoader().load(context("hippius-video://s/99.ts", "arraybuffer"), config, missing);
    await vi.waitFor(() => expect(missing.onError).toHaveBeenCalled());
    expect(missing.onError.mock.calls[0][0]).toEqual({ code: 404, text: "video segment" });

    const failed = callbacks();
    new IpcLoader().load(context("hippius-video://s/1.ts", "arraybuffer"), config, failed);
    await vi.waitFor(() => expect(failed.onError).toHaveBeenCalled());
    expect(failed.onError.mock.calls[0][0]).toEqual({ code: 500, text: "engine failed" });
  });

  it("never reports a load the player abandoned", async () => {
    let answer: (v: ArrayBuffer) => void = () => {};
    tauri.onInvoke("video_preview_segment", () => new Promise<ArrayBuffer>((r) => (answer = r)));
    const cb = callbacks();
    const loader = new IpcLoader();
    loader.load(context("hippius-video://s/5.ts", "arraybuffer"), config, cb);
    loader.abort();
    expect(loader.stats.aborted).toBe(true);
    answer(new ArrayBuffer(4));
    await new Promise((r) => setTimeout(r, 0));
    expect(cb.onSuccess).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it("refuses a URL that is not a preview stream without calling Rust", () => {
    const cb = callbacks();
    new IpcLoader().load(context("https://example.com/0.ts", "arraybuffer"), config, cb);
    expect(cb.onError).toHaveBeenCalled();
    expect(tauri.core.invoke).not.toHaveBeenCalled();
  });

  it("is the loader hls.js is configured with", () => {
    expect(HLS_PREVIEW_CONFIG.loader).toBe(IpcLoader);
  });
});
