// @vitest-environment node
// Node's Blob/File implement `arrayBuffer()`; jsdom 25's do not, and the
// real encrypt-and-upload path under test reads the bytes that way. The
// thumbnailer (the only DOM-dependent step) is injected.
import { describe, expect, it, vi } from "vitest";
import type { MatrixClient, Room } from "matrix-js-sdk";

import type { GifResult } from "@/lib/chat/gifs-api";
import {
  GIF_CONTENT_FLAG,
  GIF_MAX_BYTES,
  type GifDownloader,
  chooseRendition,
  gifFileName,
  sendGif,
  tooLargeMessage,
} from "@/lib/chat/gifs";

const PROVIDER_RE = /giphy|tenor|googleapis|gstatic|https?:\/\//i;

const GIF: GifResult = {
  id: "g1",
  title: "Excited Cat",
  preview: {
    url: "https://media1.giphy.com/media/g1/100w.gif",
    width: 220,
    height: 124,
  },
  full: {
    url: "https://media1.giphy.com/media/g1/giphy.gif",
    width: 498,
    height: 280,
    size: 3_000,
  },
  mp4: { url: "https://media1.giphy.com/media/g1/giphy.mp4", size: 1_000 },
};

const GIF_BYTES = new Uint8Array([
  0x47,
  0x49,
  0x46,
  0x38,
  0x39,
  0x61,
  ...Array.from({ length: 2994 }, (_, i) => i % 251),
]);
const MP4_BYTES = new Uint8Array([
  0,
  0,
  0,
  0x18,
  0x66,
  0x74,
  0x79,
  0x70,
  ...Array.from({ length: 992 }, (_, i) => (i * 7) % 256),
]);
const PREVIEW_BYTES = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3,
]);

/** Stands in for Rust's `chat_gif_download`: bytes by URL, 404 otherwise. */
function downloaderFor(map: Record<string, Uint8Array>) {
  return vi.fn<GifDownloader>(async (url) => {
    const body = map[url];
    if (!body)
      throw { kind: "Other", message: "Could not fetch the GIF (404)" };
    return body.slice().buffer as ArrayBuffer;
  });
}

function fakeClient() {
  const uploads: Uint8Array[] = [];
  const client = {
    uploadContent: vi.fn(async (blob: Blob) => {
      uploads.push(new Uint8Array(await blob.arrayBuffer()));
      return { content_uri: `mxc://hs/media${uploads.length}` };
    }),
    sendMessage: vi.fn(async () => ({ event_id: "$e" })),
  };
  return { client: client as unknown as MatrixClient, uploads, mocks: client };
}

const room = (encrypted: boolean) =>
  ({
    roomId: "!room:hs",
    hasEncryptionStateEvent: () => encrypted,
  }) as unknown as Room;

const noThumb = async () => null;
const fakeThumb = async () =>
  new File([new Uint8Array([0xff, 0xd8, 0xff])], "thumbnail.jpg", {
    type: "image/jpeg",
  });

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

describe("chooseRendition", () => {
  it("prefers the GIF when it fits the cap", () => {
    expect(chooseRendition(GIF)).toEqual({
      kind: "gif",
      url: GIF.full.url,
      size: 3_000,
    });
  });

  it("falls back to the mp4 when only the mp4 fits", () => {
    const big = { ...GIF, full: { ...GIF.full, size: GIF_MAX_BYTES + 1 } };
    expect(chooseRendition(big)).toEqual({
      kind: "mp4",
      url: GIF.mp4!.url,
      size: 1_000,
    });
  });

  it("refuses when nothing fits, with the limit in the message", () => {
    const huge = {
      ...GIF,
      full: { ...GIF.full, size: GIF_MAX_BYTES + 1 },
      mp4: { url: GIF.mp4!.url, size: GIF_MAX_BYTES + 1 },
    };
    expect(() => chooseRendition(huge)).toThrow(tooLargeMessage());
    expect(tooLargeMessage()).toBe(
      "This GIF is too large to send (limit 8.0 MB)",
    );
    expect(() => chooseRendition({ ...huge, mp4: null })).toThrow(/too large/);
  });

  it("names the file from the title", () => {
    expect(gifFileName("Excited Cat!!", "gif")).toBe("excited-cat.gif");
    expect(gifFileName("   ", "mp4")).toBe("gif.mp4");
  });
});

describe("sendGif: an attachment, never a link", () => {
  it("sends an encrypted m.image whose body is the filename (never the title) and no provider URL anywhere in the event", async () => {
    const { client, uploads, mocks } = fakeClient();
    const downloader = downloaderFor({ [GIF.full.url]: GIF_BYTES });
    await sendGif(client, room(true), GIF, {
      downloader,
      thumbnailer: fakeThumb,
    });

    // The bytes came through Rust, with the cap it must enforce.
    expect(downloader).toHaveBeenCalledWith(GIF.full.url, GIF_MAX_BYTES);

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    const [roomId, threadId, content] = mocks.sendMessage.mock
      .calls[0] as unknown as [string, string | null, Record<string, unknown>];
    expect(roomId).toBe("!room:hs");
    expect(threadId).toBeNull();

    // The invariant: the event carries encrypted file descriptors and nothing
    // that points at the provider (or any http URL at all).
    const serialised = JSON.stringify(content);
    expect(serialised).not.toMatch(PROVIDER_RE);
    expect(content.url).toBeUndefined();
    expect(content.msgtype).toBe("m.image");
    // `body` is a filename, equal to `filename`: per the spec that means "no
    // caption", so the timeline shows the GIF alone.
    expect(content.filename).toBe("excited-cat.gif");
    expect(content.body).toBe(content.filename);
    expect(serialised).not.toContain("Excited Cat");
    const file = content.file as {
      url: string;
      v: string;
      key: { alg: string };
      iv: string;
      hashes: { sha256: string };
      mimetype: string;
    };
    expect(file.url).toMatch(/^mxc:\/\//);
    expect(file.v).toBe("v2");
    expect(file.key.alg).toBe("A256CTR");
    expect(file.mimetype).toBe("image/gif");
    const info = content.info as Record<string, unknown>;
    expect(info).toMatchObject({
      mimetype: "image/gif",
      size: GIF_BYTES.byteLength,
      w: 498,
      h: 280,
    });
    expect((info.thumbnail_file as { url: string }).url).toMatch(/^mxc:\/\//);
    expect(info.thumbnail_info).toMatchObject({
      mimetype: "image/jpeg",
      size: 3,
    });
    expect(info.thumbnail_url).toBeUndefined();

    // What reached the media repo is ciphertext, not the GIF.
    expect(uploads).toHaveLength(2); // thumbnail, then the GIF
    const gifUpload = uploads[1];
    expect(gifUpload.byteLength).toBe(GIF_BYTES.byteLength);
    expect(sameBytes(gifUpload, GIF_BYTES)).toBe(false);
    expect(mocks.uploadContent).toHaveBeenLastCalledWith(
      expect.any(Blob),
      expect.objectContaining({
        type: "application/octet-stream",
        includeFilename: false,
      }),
    );
  });

  it("in an unencrypted room the file is uploaded plain but the event still never points at the provider", async () => {
    const { client, uploads, mocks } = fakeClient();
    await sendGif(client, room(false), GIF, {
      downloader: downloaderFor({ [GIF.full.url]: GIF_BYTES }),
      thumbnailer: noThumb,
    });
    const content = (
      mocks.sendMessage.mock.calls[0] as unknown as [
        string,
        null,
        Record<string, unknown>,
      ]
    )[2];
    expect(JSON.stringify(content)).not.toMatch(/giphy|tenor|googleapis/i);
    expect(content.url).toMatch(/^mxc:\/\//);
    expect(content.file).toBeUndefined();
    expect(sameBytes(uploads[0], GIF_BYTES)).toBe(true);
  });

  it("switches to m.video (flagged as a GIF) with a still thumbnail when only the mp4 fits", async () => {
    const big: GifResult = {
      ...GIF,
      full: { ...GIF.full, size: GIF_MAX_BYTES + 5 },
    };
    const { client, mocks } = fakeClient();
    await sendGif(client, room(true), big, {
      threadRootId: "$thread",
      downloader: downloaderFor({
        [big.mp4!.url]: MP4_BYTES,
        [big.preview.url]: PREVIEW_BYTES,
      }),
      thumbnailer: fakeThumb,
    });
    const [, threadId, content] = mocks.sendMessage.mock
      .calls[0] as unknown as [string, string | null, Record<string, unknown>];
    expect(threadId).toBe("$thread");
    expect(content.msgtype).toBe("m.video");
    expect(content[GIF_CONTENT_FLAG]).toBe(true);
    expect(content.filename).toBe("excited-cat.mp4");
    expect(content.body).toBe("excited-cat.mp4");
    expect(JSON.stringify(content)).not.toContain("Excited Cat");
    expect((content.info as Record<string, unknown>).mimetype).toBe(
      "video/mp4",
    );
    expect(
      (content.info as Record<string, unknown>).thumbnail_file,
    ).toBeDefined();
    expect(JSON.stringify(content)).not.toMatch(PROVIDER_RE);
  });

  it("enforces the size cap on the bytes actually downloaded, before any upload", async () => {
    // A provider that under-reports the size and a downloader that does not
    // cap (Rust does; this is the webview's own belt).
    const lying: GifResult = {
      ...GIF,
      full: { ...GIF.full, size: 10 },
      mp4: null,
    };
    const { client, mocks } = fakeClient();
    const oversized = new Uint8Array(64);
    await expect(
      sendGif(client, room(true), lying, {
        cap: 32,
        downloader: downloaderFor({ [GIF.full.url]: oversized }),
        thumbnailer: noThumb,
      }),
    ).rejects.toThrow(tooLargeMessage(32));
    expect(mocks.uploadContent).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses before downloading when the provider's sizes already exceed the cap", async () => {
    const huge: GifResult = {
      ...GIF,
      full: { ...GIF.full, size: GIF_MAX_BYTES * 2 },
      mp4: { url: GIF.mp4!.url, size: GIF_MAX_BYTES * 2 },
    };
    const downloader = downloaderFor({});
    const { client } = fakeClient();
    await expect(
      sendGif(client, room(true), huge, { downloader, thumbnailer: noThumb }),
    ).rejects.toThrow(/too large/);
    expect(downloader).not.toHaveBeenCalled();
  });

  it("surfaces a CDN failure from Rust as a readable error instead of sending anything", async () => {
    const { client, mocks } = fakeClient();
    // The invoke rejection is an `AppError` object, not an `Error`.
    await expect(
      sendGif(client, room(true), GIF, {
        downloader: downloaderFor({}),
        thumbnailer: noThumb,
      }),
    ).rejects.toThrow(/Could not fetch the GIF \(404\)/);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
});
