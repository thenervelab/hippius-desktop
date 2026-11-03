import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionGlobalConfig } from "framer-motion";

import ShareInsightsSheet from "../ShareInsightsSheet";
import {
  COPY_LINK,
  HIDDEN_DOTS,
  HIDE_LINK,
  LINK_COPIED,
  LINK_LOCKED_NOTE,
  LINK_NEEDS_PASSWORD,
  LINK_UNAVAILABLE_NOTE,
  OPEN_CAPTURE,
  SHOW_LINK,
  UNLOCK_TO_COPY,
  captureMediaKind,
  maskedLink,
  panelLink,
  planPanelMedia,
} from "../panelLinkMedia";
import { insightsSheetAtom, serverCapabilitiesAtom, type InsightsSheetTarget } from "@/app/lib/global-atoms/sharesAtoms";
import { syncRequiresReauthAtom } from "@/app/lib/global-atoms/unpinAtoms";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { ServerCapabilities, ShareSummary } from "@/app/lib/tauri/shares";
import type { ShareInsights } from "@/app/lib/tauri/shareInsights";

// The Insights panel's link field with its Copy link button, and the capture's
// preview: each shown only as far as this computer can open it.

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  convertFileSrc: (path: string) => `asset://localhost${path}`,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));
vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: "5Acct", authType: "oauth" }),
}));
const unlock = vi.fn(() => Promise.resolve());
vi.mock("@/app/lib/hooks/useUnlockFlow", () => ({
  useUnlockFlow: () => ({ unlock, busy: false, isOAuth: true }),
}));
vi.mock("@/app/lib/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/hooks")>();
  return {
    ...actual,
    useBreakpoint: () => ({
      breakpoint: "xl",
      isMobile: false,
      isTablet: false,
      isLaptop: false,
      isDesktop: true,
      isLargeDesktop: false,
    }),
  };
});
MotionGlobalConfig.skipAnimations = true;

const writeText = vi.fn(() => Promise.resolve());
Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

const CAPS = { shares: true, share_insights: true, share_comments: false } as ServerCapabilities;
const SHOT = "Screenshot 2026-10-29 at 10.00.00.png";
const REC = "Recording 2026-10-29 at 16.04.09.mp4";
const TOKEN = "tokABC123";
const KEY = "secretKey0987";
const URL_FULL = `https://console.hippius.com/s/${TOKEN}#k=${KEY}`;
const PAID: ShareInsights = {
  plan: "paid",
  totalViews: 0,
  uniqueViewers: 0,
  completion: { state: "shown", value: 0 },
  retention: { state: "shown", value: [] },
  viewers: { state: "shown", value: [] },
};
const ALL_ON = { insights: true, comments: true, reactions: true };

function row(extra: Partial<ShareSummary> = {}): ShareSummary {
  return {
    shareToken: TOKEN,
    filename: SHOT,
    plaintextSize: 10,
    ciphertextSize: 12,
    mimeType: "image/png",
    createdAt: "2026-10-29T10:05:00Z",
    expiresAt: null,
    shareUrl: URL_FULL,
    isPrivate: false,
    folderLabel: null,
    relativePath: null,
    ...extra,
  };
}

/** Answers the IPC by command; the listing from `listing()`. */
function answer(listing: () => ShareSummary[], extra: Record<string, (args: unknown) => unknown> = {}) {
  invokeMock.mockImplementation((cmd: string, args?: unknown) => {
    if (cmd === "hcfs_list_shares") return Promise.resolve(listing());
    if (cmd in extra) return Promise.resolve(extra[cmd](args));
    if (cmd === "share_get_insights") return Promise.resolve(PAID);
    if (cmd === "share_get_link_settings") return Promise.resolve({ offered: ALL_ON, on: ALL_ON, switchesInPlan: true });
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
}

function renderSheet(target: Partial<InsightsSheetTarget> = {}, locked = false) {
  const store = createStore();
  store.set(serverCapabilitiesAtom, CAPS);
  store.set(syncRequiresReauthAtom, locked);
  store.set(insightsSheetAtom, { shareToken: TOKEN, fileName: SHOT, ...target });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Provider store={store}>
        <ShareInsightsSheet />
      </Provider>
    </QueryClientProvider>,
  );
  return store;
}

/** The panel's fixed header. */
const header = () => screen.getByTestId("insights-panel").querySelector("header")!;

const called = (cmd: string) => invokeMock.mock.calls.filter(([c]) => c === cmd);

describe("panelLink", () => {
  it("shows the full link only when this computer has its key", () => {
    expect(panelLink(null, false)).toEqual({ kind: "loading" });
    expect(panelLink({ shareUrl: URL_FULL, isPrivate: false }, true)).toEqual({
      kind: "ready",
      url: URL_FULL,
      needsPassword: false,
    });
    expect(panelLink({ shareUrl: URL_FULL, isPrivate: true }, false)).toMatchObject({ needsPassword: true });
    expect(panelLink({ shareUrl: null, isPrivate: false }, true)).toEqual({ kind: "locked" });
    expect(panelLink({ shareUrl: null, isPrivate: false }, false)).toEqual({ kind: "unavailable" });
  });

  it("masks everything that opens the link", () => {
    expect(maskedLink(URL_FULL)).toBe(`console.hippius.com/${HIDDEN_DOTS}`);
    expect(maskedLink(URL_FULL)).not.toContain(TOKEN);
    expect(maskedLink(URL_FULL)).not.toContain(KEY);
    expect(maskedLink(null)).toBe(HIDDEN_DOTS);
    expect(maskedLink("not a url #k=abc")).toBe(HIDDEN_DOTS);
  });
});

describe("planPanelMedia", () => {
  const base = { mediaKind: "image" as const, onDisk: false, location: null, unlocked: true };
  it("uses the copy on disk first, even while locked", () => {
    expect(planPanelMedia({ ...base, file: { source: "/a.png" }, onDisk: true, unlocked: false })).toEqual({ kind: "disk" });
  });
  it("offers nothing else while locked", () => {
    expect(planPanelMedia({ ...base, location: { label: "C", relativePath: "a.png" }, unlocked: false })).toEqual({
      kind: "none",
    });
    expect(planPanelMedia({ ...base, file: { fileId: "f1" }, unlocked: false })).toEqual({ kind: "none" });
  });
  it("thumbnails a screenshot that is only on the server, and never downloads a recording for it", () => {
    expect(planPanelMedia({ ...base, file: { fileId: "f1" } })).toEqual({ kind: "cloudThumb" });
    expect(planPanelMedia({ ...base, mediaKind: "video", file: { fileId: "f1" } })).toEqual({ kind: "none" });
  });
  it("asks where a capture is on disk by its drive and path", () => {
    expect(planPanelMedia({ ...base, location: { label: "C", relativePath: "a.png" } })).toEqual({
      kind: "resolve",
      location: { label: "C", relativePath: "a.png" },
    });
    expect(planPanelMedia({ ...base, file: { label: "C", actualFileName: "b.png" } })).toEqual({
      kind: "resolve",
      location: { label: "C", relativePath: "b.png" },
    });
  });
  it("shows no picture for other files", () => {
    expect(captureMediaKind("notes.pdf")).toBeNull();
    expect(captureMediaKind("photo.heic")).toBeNull();
    expect(captureMediaKind(REC)).toBe("video");
    expect(captureMediaKind(SHOT)).toBe("image");
    expect(planPanelMedia({ ...base, mediaKind: null, location: { label: "C", relativePath: "x" } })).toEqual({
      kind: "none",
    });
  });
});

describe("Insights panel link", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    writeText.mockClear();
    toastSuccess.mockClear();
    toastError.mockClear();
    unlock.mockClear();
  });

  it("shows the link hidden, reveals it on request, and copies the full link", async () => {
    answer(() => [row()]);
    renderSheet();

    const text = await screen.findByTestId("insights-link-text");
    expect(text).toHaveTextContent(`console.hippius.com/${HIDDEN_DOTS}`);
    expect(screen.getByTestId("insights-panel").textContent).not.toContain(KEY);

    fireEvent.click(screen.getByRole("button", { name: SHOW_LINK }));
    // Shown in full without its scheme; Copy still copies all of it.
    expect(text).toHaveTextContent(URL_FULL.replace("https://", ""));
    expect(text.textContent).not.toContain("https://");
    fireEvent.click(screen.getByRole("button", { name: HIDE_LINK }));
    expect(text).not.toHaveTextContent(KEY);

    // Copy sits in the link's own row; the header has none.
    const field = screen.getByTestId("insights-link");
    fireEvent.click(within(field).getByRole("button", { name: COPY_LINK }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL_FULL));
    expect(toastSuccess).toHaveBeenCalledWith(LINK_COPIED);
    expect(screen.getAllByRole("button", { name: COPY_LINK })).toHaveLength(1);
    // A labelled button, not an icon.
    expect(within(field).getByRole("button", { name: COPY_LINK })).toHaveTextContent(COPY_LINK);
    expect(within(header()).getAllByRole("button", { name: COPY_LINK })).toEqual([
      within(field).getByRole("button", { name: COPY_LINK }),
    ]);
  });

  it("says a password link needs its password", async () => {
    answer(() => [row({ shareUrl: URL_FULL.replace("#k=", "#p="), isPrivate: true })]);
    renderSheet();
    expect(await screen.findByText(LINK_NEEDS_PASSWORD)).toBeInTheDocument();
  });

  it("while locked, hides the link, offers Unlock, and makes it copyable once unlocked", async () => {
    let unlocked = false;
    answer(() => [row({ shareUrl: unlocked ? URL_FULL : null })]);
    const store = renderSheet({}, true);

    const field = await screen.findByTestId("insights-link");
    expect(within(field).getByText(HIDDEN_DOTS)).toBeInTheDocument();
    expect(within(field).getByText(LINK_LOCKED_NOTE)).toBeInTheDocument();
    fireEvent.click(within(field).getByRole("button", { name: UNLOCK_TO_COPY }));
    expect(unlock).toHaveBeenCalledTimes(1);
    // Unlock is the one way to the link: there is no second Copy to press.
    expect(screen.queryByRole("button", { name: /Copy link/ })).toBeNull();
    expect(writeText).not.toHaveBeenCalled();

    // The unlock went through: Rust can open the link's key now, the listing
    // is read again, and the same panel can copy it.
    const before = called("hcfs_list_shares").length;
    unlocked = true;
    act(() => store.set(syncRequiresReauthAtom, false));
    await waitFor(() => expect(called("hcfs_list_shares").length).toBeGreaterThan(before));
    fireEvent.click(await screen.findByRole("button", { name: COPY_LINK }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL_FULL));
  });

  it("says why a link whose key is not on this computer can't be copied", async () => {
    answer(() => [row({ shareUrl: null })]);
    renderSheet();
    expect(await screen.findByText(LINK_UNAVAILABLE_NOTE)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: UNLOCK_TO_COPY })).toBeNull();
    expect(screen.queryByRole("button", { name: COPY_LINK })).toBeNull();
  });

  it("holds the link's place while the listing loads", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "hcfs_list_shares" ? new Promise(() => {}) : cmd === "share_get_insights" ? Promise.resolve(PAID) : Promise.reject(new Error(cmd)),
    );
    renderSheet();
    expect(await screen.findByTestId("insights-link-loading")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: COPY_LINK })).toBeNull();
  });
});

describe("Insights panel preview", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    toastError.mockClear();
  });

  const placed = { folderLabel: "Hippius Captures", relativePath: SHOT };

  it("shows a screenshot made here, finds it on disk, and opens it full size", async () => {
    answer(() => [row(placed)], {
      resolve_drive_file_source: () => "/Users/me/Hippius Captures/shot.png",
      open_in_default_app: () => undefined,
    });
    renderSheet();

    const preview = await screen.findByTestId("insights-preview");
    expect(within(preview).getByRole("img", { name: `Preview of ${SHOT}` })).toHaveAttribute(
      "src",
      "asset://localhost/Users/me/Hippius Captures/shot.png",
    );
    expect(invokeMock).toHaveBeenCalledWith("resolve_drive_file_source", {
      label: "Hippius Captures",
      relativePath: SHOT,
    });
    fireEvent.click(within(preview).getByRole("button", { name: OPEN_CAPTURE }));
    expect(invokeMock).toHaveBeenCalledWith("open_in_default_app", { path: "/Users/me/Hippius Captures/shot.png" });

    // The preview is the one picture: no thumbnail of it in the title row.
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.queryByTestId("insights-media-tile")).toBeNull();
  });

  it("plays a recording muted with its controls, from where Rust says", async () => {
    answer(() => [row({ ...placed, filename: REC, relativePath: REC })], {
      resolve_drive_file_source: () => "/Users/me/Hippius Captures/rec.mp4",
      video_playback_source: () => ({ kind: "webview" }),
    });
    renderSheet({ fileName: REC });

    const preview = await screen.findByTestId("insights-preview");
    const video = preview.querySelector("video")!;
    expect(video).toHaveAttribute("controls");
    expect(video.muted).toBe(true);
    expect(video).toHaveAttribute("src", "asset://localhost/Users/me/Hippius Captures/rec.mp4");

    // Its length, read off the preview, joins the header's line.
    Object.defineProperty(video, "duration", { value: 252, configurable: true });
    fireEvent.loadedMetadata(video);
    expect(await screen.findByText("Shared Oct 29 · 4:12 · link on")).toBeInTheDocument();
    expect(header().querySelectorAll("video")).toHaveLength(1);
  });

  it("leaves no room for a picture of a file that has none", async () => {
    answer(() => [row({ filename: "notes.pdf" })]);
    renderSheet({ fileName: "notes.pdf" });
    await screen.findByTestId("insights-link-text");
    expect(screen.queryByTestId("insights-preview")).toBeNull();
    expect(screen.queryByTestId("insights-preview-loading")).toBeNull();
    expect(screen.queryByTestId("insights-media-tile")).toBeNull();
    expect(header().querySelector("img, video")).toBeNull();
  });

  it("asks for nothing while locked when the capture is not on disk", async () => {
    answer(() => [row({ ...placed, shareUrl: null })], {
      resolve_drive_file_source: () => "/Users/me/Hippius Captures/shot.png",
    });
    renderSheet({}, true);
    await screen.findByTestId("insights-link");
    expect(called("resolve_drive_file_source")).toHaveLength(0);
    expect(screen.queryByTestId("insights-preview")).toBeNull();
  });

  it("still shows a capture on disk while locked", async () => {
    answer(() => [row({ shareUrl: null })]);
    const file = { name: SHOT, source: "/Users/me/shot.png" } as FormattedUserFile;
    renderSheet({ file }, true);
    const preview = await screen.findByTestId("insights-preview");
    expect(within(preview).getByRole("img", { name: `Preview of ${SHOT}` })).toHaveAttribute(
      "src",
      "asset://localhost/Users/me/shot.png",
    );
  });

  it("shows nothing, quietly, when the capture can't be found", async () => {
    answer(() => [row(placed)], { resolve_drive_file_source: () => null });
    renderSheet();
    await screen.findByTestId("insights-link-text");
    await waitFor(() => expect(called("resolve_drive_file_source")).toHaveLength(1));
    expect(screen.queryByTestId("insights-preview")).toBeNull();
    expect(screen.queryByTestId("insights-preview-loading")).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("drops a preview that fails to draw", async () => {
    answer(() => [row(placed)], { resolve_drive_file_source: () => "/Users/me/broken.png" });
    renderSheet();
    const img = await screen.findByRole("img", { name: `Preview of ${SHOT}` });
    fireEvent.error(img);
    expect(screen.queryByTestId("insights-preview")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
