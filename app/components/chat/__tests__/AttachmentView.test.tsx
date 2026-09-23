import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { MatrixClient } from "matrix-js-sdk";
import { MsgType } from "matrix-js-sdk";

import { autoplayGifsAtom } from "@/components/chat/chat-ui-atoms";
import type { EncryptedFile } from "@/lib/chat/attachments";
import type { Attachment } from "@/lib/chat/timeline";

// One decrypted object URL per variant; the hook itself needs Web Crypto and
// the homeserver, both out of jsdom's reach.
vi.mock("@/components/chat/hooks/useAttachmentUrl", () => ({
  useAttachmentUrl: (_c: unknown, _a: unknown, variant: "full" | "thumbnail", _s: unknown, enabled = true) =>
    enabled ? { status: "ready", url: `blob:${variant}` } : { status: "idle" },
}));
vi.mock("@/components/chat/Lightbox", () => ({
  default: ({ open }: { open: boolean }) => (open ? <div role="dialog">lightbox</div> : null),
}));

// The two ends of the save path: the native dialog (webview) and the Rust
// write. `saveAttachmentToDisk` in between is what is under test here.
const saveDialog = vi.fn<(options?: unknown) => Promise<string | null>>();
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: (o?: unknown) => saveDialog(o) }));
vi.mock("@tauri-apps/api/path", () => ({
  downloadDir: async () => "/home/me/Downloads",
  join: async (...parts: string[]) => parts.join("/"),
}));
const chatSaveAttachment = vi.fn<(destination: string, bytes: ArrayBuffer | Uint8Array) => Promise<void>>();
vi.mock("@/app/lib/tauri/chat", () => ({ chatSaveAttachment: (d: string, b: ArrayBuffer) => chatSaveAttachment(d, b) }));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock("sonner", () => ({ toast }));

const { default: AttachmentView } = await import("@/components/chat/AttachmentView");

const client = {} as MatrixClient;
const enc = (url: string): EncryptedFile => ({
  url,
  v: "v2",
  key: { alg: "A256CTR", ext: true, k: "k", key_ops: ["encrypt", "decrypt"], kty: "oct" },
  iv: "iv",
  hashes: { sha256: "h" },
});

const gifImage: Attachment = {
  msgtype: MsgType.Image,
  name: "dance.gif",
  mimetype: "image/gif",
  size: 500_000,
  url: null,
  file: enc("mxc://hippius.com/full"),
  width: 400,
  height: 300,
  thumbnailUrl: null,
  thumbnailFile: enc("mxc://hippius.com/still"),
  gif: true,
};

const gifVideo: Attachment = { ...gifImage, msgtype: MsgType.Video, name: "dance.mp4", mimetype: "video/mp4" };

const pdf: Attachment = {
  msgtype: MsgType.File,
  name: "report.pdf",
  mimetype: "application/pdf",
  size: 12_345,
  url: null,
  file: enc("mxc://hippius.com/report"),
  width: null,
  height: null,
  thumbnailUrl: null,
  thumbnailFile: null,
  gif: false,
};

function renderWith(attachment: Attachment, autoplayGifs = true) {
  const store = createStore();
  store.set(autoplayGifsAtom, autoplayGifs);
  return render(
    <Provider store={store}>
      <AttachmentView client={client} attachment={attachment} senderName="Ada" />
    </Provider>,
  );
}

beforeEach(() => {
  saveDialog.mockReset();
  chatSaveAttachment.mockReset().mockResolvedValue(undefined);
  toast.success.mockReset();
  toast.error.mockReset();
});

describe("AttachmentView (GIF)", () => {
  it("autoplays an image/gif from the decrypted full file when the preference is on, with a GIF badge", () => {
    renderWith(gifImage, true);
    const button = screen.getByRole("button", { name: "Open GIF dance.gif" });
    expect(button).toHaveAttribute("data-playing", "true");
    expect(screen.getByRole("img", { name: "dance.gif" })).toHaveAttribute("src", "blob:full");
    expect(screen.getByText("GIF")).toBeInTheDocument();
    // Never a remote URL: everything is served from the decrypted blob.
    expect(button.innerHTML).not.toMatch(/tenor|https?:\/\//);
  });

  it("shows the still thumbnail when autoplay is off, plays on hover, and pins on click", () => {
    renderWith(gifImage, false);
    const button = screen.getByRole("button", { name: "Play GIF dance.gif" });
    expect(button).toHaveAttribute("data-playing", "false");
    expect(screen.getByRole("img", { name: "dance.gif" })).toHaveAttribute("src", "blob:thumbnail");

    fireEvent.mouseEnter(button);
    expect(button).toHaveAttribute("data-playing", "true");
    expect(screen.getByRole("img", { name: "dance.gif" })).toHaveAttribute("src", "blob:full");
    fireEvent.mouseLeave(button);
    expect(button).toHaveAttribute("data-playing", "false");

    fireEvent.click(button);
    expect(button).toHaveAttribute("data-playing", "true");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Second click, now playing: opens the lightbox.
    fireEvent.click(button);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("plays a GIF-flagged video muted, looping, inline, without controls", () => {
    const { container } = renderWith(gifVideo, true);
    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute("src", "blob:full");
    expect(video).toHaveAttribute("autoplay");
    expect(video).toHaveAttribute("loop");
    expect(video).toHaveAttribute("playsinline");
    expect(video).not.toHaveAttribute("controls");
    expect(video?.muted).toBe(true);
  });

  it("does not treat a plain video as a GIF", () => {
    const { container } = renderWith({ ...gifVideo, gif: false, thumbnailFile: null }, true);
    expect(container.querySelector("video")).toBeNull();
    expect(screen.queryByText("GIF")).not.toBeInTheDocument();
  });
});

describe("AttachmentView (file → disk)", () => {
  // jsdom has no fetch for blob: URLs; the decrypted bytes come back from the
  // object URL the viewer already holds.
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("blob:full");
        return { ok: true, arrayBuffer: async () => bytes.buffer } as Response;
      }),
    );
  });

  it("downloads via the native save dialog and the Rust write, defaulting to ~/Downloads/<name>", async () => {
    saveDialog.mockResolvedValue("/home/me/Documents/report.pdf");
    renderWith(pdf);
    // Rendered as a button, never `<a download>`: that is a no-op in the webview.
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Download report.pdf" }));

    await waitFor(() => expect(chatSaveAttachment).toHaveBeenCalledTimes(1));
    expect(saveDialog).toHaveBeenCalledWith({ defaultPath: "/home/me/Downloads/report.pdf" });
    const [destination, body] = chatSaveAttachment.mock.calls[0];
    expect(destination).toBe("/home/me/Documents/report.pdf");
    expect(new Uint8Array(body as ArrayBuffer)).toEqual(bytes);
    expect(toast.success).toHaveBeenCalledWith("Saved report.pdf");
  });

  it("a dismissed dialog writes nothing and is not an error", async () => {
    saveDialog.mockResolvedValue(null);
    renderWith(pdf);
    fireEvent.click(screen.getByRole("button", { name: "Download report.pdf" }));
    await waitFor(() => expect(saveDialog).toHaveBeenCalledTimes(1));
    expect(chatSaveAttachment).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("surfaces Rust's refusal (e.g. the file already exists) as the toast text", async () => {
    saveDialog.mockResolvedValue("/home/me/Documents/report.pdf");
    chatSaveAttachment.mockRejectedValue({ kind: "Validation", message: "a file already exists at that path" });
    renderWith(pdf);
    fireEvent.click(screen.getByRole("button", { name: "Download report.pdf" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("a file already exists at that path"));
  });
});
