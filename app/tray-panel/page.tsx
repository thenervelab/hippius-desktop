"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { Window } from "@tauri-apps/api/window";
import { Upload, Check, AlertCircle } from "lucide-react";
import "./tray-panel.css";
import { useTrayPanelData } from "@/app/lib/tray/useTrayPanelData";
import {
  getTraySyncSummary,
  type TraySyncTone,
} from "@/app/lib/tray/traySyncSummary";
import type { SyncSnapshot } from "@/app/lib/types/syncSnapshot";
import type { UploadFeedItem } from "@/app/lib/upload-feed/mergeUploadFeed";
import { groupUploadFeed } from "@/app/lib/upload-feed/groupUploadFeed";
import { getFileTypeFromExtension } from "@/app/lib/utils/getTileTypeFromExtension";
import { getFileIcon, DIRECTORY_SUFFIX } from "@/app/lib/utils/fileTypeUtils";
import { formatBytes } from "@/app/lib/utils/formatBytes";
import { formatUploadedDate } from "@/app/lib/utils/formatUploadedDate";
import Button from "@/app/components/ui/button";
import MiddleTruncatedName from "@/app/components/ui/MiddleTruncatedName";
import HippiusLogo from "@/app/components/ui/icons/HippiusLogo";
import Search from "@/app/components/ui/icons/Search";
import Command from "@/app/components/ui/icons/Command";
import ArrowRight from "@/app/components/ui/icons/ArrowRight";
import Notification from "@/app/components/ui/icons/Notification";
import BoxSimple from "@/app/components/ui/icons/BoxSimple";

// Same identicon the sidebar/ProfileCard uses; client-only (no SSR).
const Avatar = dynamic(() => import("boring-avatars"), { ssr: false });

/**
 * The system-tray popover UI.
 *
 * Rendered inside the borderless `tray-panel` Tauri window (see
 * `src-tauri/src/tray/panel.rs`). It is intentionally self-contained — it does
 * NOT mount the app's providers (see `AppShell`) and talks to the backend only
 * through `invoke`. All data shown here is computed in Rust.
 *
 * The Figma "frosted" look (translucent card over a blurred background) is
 * produced by NATIVE macOS vibrancy — a `Popover` window effect applied in
 * `build_panel` (`src-tauri/src/tray/panel.rs`). CSS `backdrop-filter: blur()`
 * was tried first but WebKit does not blur the desktop behind a transparent
 * macOS window (it just alpha-blends it), so the desktop showed straight
 * through. With the native material doing the real blur, the card itself is a
 * TRANSLUCENT tint (`rgba(255,255,255,0.7)` light / `rgba(30,30,30,0.7)` dark —
 * the Figma value) so the frost shows through it. The card fills the window
 * edge-to-edge (the window IS the 460×672 Figma card) and its rounded corners
 * line up with the material's 16px radius; the native window shadow provides
 * elevation. Light/dark follow the OS via Tailwind's media strategy
 * (`darkMode: "class"` is off), exactly like the rest of the app. The search
 * field mirrors the sidebar's search styling.
 */
export default function TrayPanelPage() {
  const { menu, feed, snapshot, blockNumber, isConnected, unreadCount } = useTrayPanelData();
  // Date-bucketed for the headed list (Today / Yesterday / This Week / …).
  // Live uploading/failed rows carry createdAt=now, so they lead "Today".
  const groups = groupUploadFeed(feed);

  // ⌘/Ctrl+F mirrors clicking the "Search Files" field (`openMainSearch`): the
  // popover has no search of its own, so the shortcut reveals the main window
  // and opens its command palette. Key check matches the main window's
  // `SidebarSearch` so the behaviour is identical from either window.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "f") return;
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      void openMainSearch();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Only macOS gets the translucent "frosted" card, because only there does the
  // window sit over native vibrancy (the `Popover` material in `build_panel`).
  // On Linux/Windows there is no material, so a 0.7-alpha card over the
  // transparent window shows the desktop straight through (the "very
  // transparent" popover reported on Linux). Off macOS we therefore paint an
  // OPAQUE card with a hairline border (no vibrancy/shadow to separate it from
  // whatever is behind). Default to opaque so non-macOS never flashes
  // see-through; macOS flips to translucent once detected — the window is
  // prewarmed at boot, so this resolves long before it is ever shown.
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    invoke<{ os: string }>("get_platform_info")
      .then((info) => setIsMac(info?.os === "macos"))
      .catch(() => {});
  }, []);
  const cardSurface = isMac
    ? "bg-[rgba(255,255,255,0.7)] dark:bg-[rgba(30,30,30,0.7)]"
    : "bg-white dark:bg-[#1e1e1e] border border-[rgba(0,0,0,0.08)] dark:border-[rgba(255,255,255,0.1)]";

  return (
    // The card fills the window edge-to-edge: the window IS the 460×672 Figma
    // card. On macOS the native vibrancy material (applied in `build_panel`)
    // frosts the background and the native window shadow provides elevation; on
    // Linux/Windows the card is opaque with a hairline border instead (see
    // `cardSurface`). The card's 16px corners line up with the window radius.
    <div className="tray-panel-shell flex h-screen w-screen">
      <div className={`tray-panel-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-[16px] ${cardSurface} font-geist text-black dark:text-white`}>
        <Header credits={menu?.credits ?? null} unreadCount={unreadCount} />
        <SearchBar />

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-2">
        <h2 className="py-2 font-geist text-[16px] font-medium leading-8 text-grey-10 dark:text-white">Your Uploads</h2>

        {/* Live sync-progress summary (percent + status + synced/remaining),
            mirroring the sidebar sync widget. Renders only while a session is
            active or just finished; getTraySyncSummary returns null when idle. */}
        <SyncSummary snapshot={snapshot} />

        {feed.length === 0 ? (
          // Empty state: a single simple rounded card (no graphsheet / guide
          // lines / corner textures) with copy + the Upload CTA that opens the
          // Drive page.
          <div className="flex flex-1 items-center justify-center py-2">
            {/* Explicit rgba fills/borders, not the arbitrary opacity-modifier
                form (border-black/[0.08] etc.), which didn't render in light
                mode here — same fix applied to the footer and credits pill. */}
            <div className="flex w-full flex-col gap-4 rounded-2xl border border-[rgba(0,0,0,0.08)] bg-[rgba(0,0,0,0.02)] p-5 shadow-sm dark:border-white/10 dark:bg-[rgba(255,255,255,0.03)]">
              <div className="flex flex-col gap-1.5">
                <h3 className="font-geist text-[18px] font-medium leading-6 tracking-[-0.54px] text-grey-10 dark:text-white">
                  No files yet
                </h3>
                <p className="font-geist text-[14px] leading-5 text-black/50 dark:text-white/50">
                  Start by uploading a file to see it here.
                </p>
              </div>
              <Button
                variant="primary"
                size="auto"
                onClick={() => void openMainFiles()}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl text-[15px] font-medium"
              >
                <Upload className="size-4" />
                Upload a File
              </Button>
            </div>
          </div>
        ) : (
          // Date-grouped sections. `mergeUploadFeed` order (uploading → failed
          // → completed) is preserved within each bucket, so active rows lead
          // the "Today" group.
          groups.map((group) => (
            <section key={group.label} className="mb-1">
              <h3 className="mb-1 mt-3 font-mono text-[14px] font-medium uppercase leading-5 tracking-[-0.28px] text-grey-70">
                {group.label}
              </h3>
              <ul>
                {group.items.map((item) => (
                  <UploadRowItem key={uploadRowKey(item)} item={item} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

        <Footer address={menu?.substrateAddress ?? null} blockNumber={blockNumber} isConnected={isConnected} />
      </div>
    </div>
  );
}

/** Top bar: brand mark (left) and a single pill holding credits + a divider +
 *  the notification bell (right) — matching the Figma header. The bell mirrors
 *  the top-bar bell: it shows the live unread count and, on click, focuses the
 *  main window and opens its existing notifications dropdown. */
function Header({ credits, unreadCount }: { credits: number | null; unreadCount: number }) {
  return (
    <header className="flex items-center justify-between px-5 pt-5">
      {/* The Hippius mark shown directly (its own blue + white outline), with
          no blue badge box behind it — a cleaner, simpler header that lets the
          logo read as the brand rather than a solid blue tile. */}
      <HippiusLogo className="h-11 w-11" />

      {/* Explicit rgba fill, not the `bg-black/[0.06]` opacity-modifier, which
          rendered no box in light mode (same issue fixed on the footer). */}
      <div className="flex items-center gap-3 rounded-xl bg-[rgba(0,0,0,0.06)] py-1.5 pl-4 pr-2 dark:bg-[rgba(255,255,255,0.06)]">
        <div className="flex flex-col text-left">
          <span className="font-mono text-[10px] font-medium leading-[18px] tracking-[-0.2px] text-[#1F51BE] dark:text-primary-brand-dark">
            CREDITS
          </span>
          <span className="truncate font-mono text-[12px] font-medium uppercase leading-5 tracking-[-0.24px] text-black dark:text-white">
            {credits === null ? "—" : credits.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </span>
        </div>
        <div className="h-6 w-px shrink-0 rounded-2xl bg-[#606060] opacity-40" />
        <button
          type="button"
          onClick={() => void openMainNotifications()}
          aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
          className="relative flex h-9 w-9 items-center justify-center rounded-lg text-black transition-colors hover:bg-black/5 dark:text-white dark:hover:bg-white/10"
        >
          <Notification className="size-[14px] shrink-0 opacity-40" />
          {unreadCount > 0 && (
            <span
              data-testid="tray-unread-count"
              // A single-digit count gets a larger circle + font so a lone "1"
              // reads clearly; once the count needs two/three glyphs (≥10) we
              // fall back to the compact pill so the wider text still fits.
              className={`absolute -right-0.5 -top-0.5 flex items-center justify-center rounded-full bg-primary-50 font-medium leading-none text-white ${
                unreadCount < 10
                  ? "h-4 min-w-4 text-[10px]"
                  : "h-3 min-w-3 px-[3px] text-[7px]"
              }`}
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>
      </div>
    </header>
  );
}

/** Search field — styled identically to the sidebar's `SidebarSearch` shell
 *  (`bg-[#0000000F]` pill, 14px medium text, `⌘ F` hint). Clicking opens the
 *  main window's files page (cross-window search lives there). */
function SearchBar() {
  return (
    <div className="px-5 pt-4">
      <button
        type="button"
        onClick={() => void openMainSearch()}
        className="flex w-full items-center justify-between gap-2 self-stretch rounded-[12px] bg-[#0000000F] p-2.5 text-left transition-colors hover:bg-[#00000014] dark:bg-white/[0.06] dark:hover:bg-white/10"
      >
        <span className="flex min-w-0 items-center gap-2 text-black/30 dark:text-white/30">
          <Search className="size-[18px] shrink-0" />
          <span className="truncate font-geist text-[16px] font-medium leading-5">Search Files</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 font-geist text-[14px] font-medium text-black/30 dark:text-white/30">
          <Command className="size-[14px]" strokeWidth={1.5} />
          <span>F</span>
        </span>
      </button>
    </div>
  );
}

/** Per-tone accent color for the sync summary (matches `StatusLabel`'s tokens
 *  and the sidebar widget). */
const TRAY_SYNC_TONE_TEXT: Record<TraySyncTone, string> = {
  active: "text-[#3167DD]",
  preparing: "text-[#3167DD]",
  completed: "text-[#04C870]",
  failed: "text-[#FF6D61]",
};

/**
 * Sync-progress summary shown above the upload list — the popover counterpart
 * of the sidebar's sync widget. Top line: a status icon + overall percent on
 * the left, the status word on the right. Bottom line: synced vs. remaining
 * counts. Renders nothing when there's no active/recent session (the resolver
 * returns null), so the list sits directly under the heading when idle.
 */
function SyncSummary({ snapshot }: { snapshot: SyncSnapshot }) {
  const summary = getTraySyncSummary(snapshot);
  if (!summary) return null;

  const accent = TRAY_SYNC_TONE_TEXT[summary.tone];

  return (
    <div className="mb-2 mt-1 flex flex-col gap-2 rounded-[12px] border border-[rgba(0,0,0,0.08)] bg-[rgba(0,0,0,0.02)] p-3 dark:border-white/10 dark:bg-[rgba(255,255,255,0.03)]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {summary.tone === "completed" ? (
            <Check className="size-4 shrink-0 text-[#04C870]" strokeWidth={3} />
          ) : summary.tone === "failed" ? (
            <AlertCircle className="size-4 shrink-0 text-[#FF6D61]" />
          ) : (
            <span className={`flex ${accent}`}>
              <ProgressRing value={summary.percent} />
            </span>
          )}
          <span className={`font-geist text-[14px] font-semibold leading-none ${accent}`}>
            {summary.percent}%
          </span>
        </div>
        <span
          className={`font-mono text-[10px] font-medium uppercase leading-none tracking-[-0.2px] ${
            summary.tone === "completed" ? "text-grey-70 dark:text-white/50" : accent
          }`}
        >
          {summary.statusLabel}
        </span>
      </div>
      <span className="font-geist text-[12px] font-medium tracking-[-0.24px] text-grey-70 dark:text-white/50">
        {summary.detail}
      </span>
    </div>
  );
}

/** A single upload row. Layout mirrors the Figma: the file-type icon aligns
 *  with the filename on the top line, and the size sits below — sharing that
 *  bottom line with the right-aligned status, so size and status line up.
 *
 *  Completed rows show the uploaded time (like the search palette the product
 *  liked); in-flight and failed rows show a live status pill (with a progress
 *  ring while uploading). */
function UploadRowItem({ item }: { item: UploadFeedItem }) {
  const rawName = item.actualFileName || item.name;
  const ext = rawName.includes(".") ? rawName.split(".").pop() ?? null : null;
  const fileType = getFileTypeFromExtension(ext);
  const { icon: Icon, color } = getFileIcon(fileType ?? undefined, false);

  const sizeText =
    typeof item.size === "number" && item.size > 0
      ? formatBytes(item.size)
      : "—";
  const uploadedText =
    item.feedStatus === "completed" ? formatUploadedDate(item.createdAt) : null;

  return (
    <li className="flex items-start gap-3 py-2.5">
      {/* Icon column is as tall as the filename's line box and centers the
          icon within it, so the icon lines up with the filename row (not the
          very top of the list item). */}
      <span className={`flex h-5 w-4 shrink-0 items-center justify-center ${color}`}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        {/* Center-truncate long names (keep start + extension) instead of the
            end-only CSS `truncate`, so e.g. a long "…scene.mp4" still shows its
            extension. MiddleTruncatedName measures the row width and updates on
            resize; it works in this provider-free webview (self-contained). */}
        <MiddleTruncatedName
          name={displayFileName(item.name)}
          className="block font-geist text-[14px] font-medium leading-5 tracking-[-0.28px] text-[#1d1d1d] dark:text-white"
        />
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="truncate font-geist text-[12px] font-medium leading-normal tracking-[-0.24px] text-grey-10 dark:text-white">
            {sizeText}
          </span>
          {uploadedText ? (
            <span className="shrink-0 font-geist text-[12px] font-medium tracking-[-0.24px] text-grey-10 dark:text-white/50">
              {uploadedText}
            </span>
          ) : (
            <StatusLabel status={item.feedStatus} progress={item.progressPercent} />
          )}
        </div>
      </div>
    </li>
  );
}

/** Stable React key: drive label + relative path keeps a row identity across
 *  the uploading → completed transition (avoids a remount that would restart
 *  the row's transitions). */
function uploadRowKey(item: UploadFeedItem): string {
  return `${item.label ?? ""}::${item.actualFileName || item.name}`;
}

/** Small circular progress ring shown beside the "time left" status while a
 *  file is uploading — mirrors the drive page's ring. `value` is 0–100. */
function ProgressRing({ value }: { value: number }) {
  const radius = 5;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, value));
  const offset = circumference * (1 - clamped / 100);
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" className="-rotate-90 shrink-0" aria-hidden="true">
      <circle cx="6" cy="6" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <circle cx="6" cy="6" r={radius} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset} />
    </svg>
  );
}

/** Color-coded status label (Geist Mono, 10px, uppercase — Figma tokens). The
 *  current backend feed only emits "uploaded"/"deleted"; the other states
 *  (pending/failed/uploading + a time-left ring) are styled for when richer
 *  per-file progress is wired in. */
function StatusLabel({ status, progress }: { status: string; progress?: number | null }) {
  const base = "shrink-0 font-mono text-[10px] font-medium uppercase leading-none tracking-[-0.2px]";

  // Uploading: brand-blue progress ring + live percent (falls back to the
  // "UPLOADING" word before the first percent arrives).
  if (status === "uploading") {
    return (
      <span className={`flex items-center gap-1.5 text-[#3167DD] ${base}`}>
        <ProgressRing value={progress ?? 0} />
        {typeof progress === "number" ? `${Math.round(progress)}%` : "UPLOADING"}
      </span>
    );
  }

  const map: Record<string, { label: string; className: string }> = {
    completed: { label: "UPLOADED", className: "text-[#04C870]" },
    uploaded: { label: "UPLOADED", className: "text-[#04C870]" },
    pending: { label: "PENDING", className: "text-[#FEB101]" },
    failed: { label: "FAILED", className: "text-[#FF6D61]" },
    deleted: { label: "DELETED", className: "text-black/40 dark:text-white/40" },
  };
  const entry = map[status] ?? { label: status.toUpperCase(), className: "text-black/40 dark:text-white/40" };
  return <span className={`${base} ${entry.className}`}>{entry.label}</span>;
}

/** Bottom bar: a single rounded box (Figma tokens — 8px gap, 16px radius,
 *  6%-opacity fill) inset 16px from the card edges, holding the account chip
 *  (identicon + short
 *  address + live chain block) on the left and the official `Button` CTA on the
 *  right. The identicon, address and block typography all match ProfileCard. */
function Footer({ address, blockNumber, isConnected }: { address: string | null; blockNumber: number | null; isConnected: boolean }) {
  // Click-to-copy the full address, like the sidebar's ProfileCard. The panel
  // has no Toaster (it's provider-free), so feedback is a brief inline "Copied!"
  // swapped in for the block-number line.
  const [copied, setCopied] = useState(false);
  const handleCopyAddress = () => {
    if (!address) return;
    navigator.clipboard
      .writeText(address)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch((error) => console.error("[TrayPanel] Failed to copy address:", error));
  };

  return (
    <footer className="px-4 pb-4">
      {/* Figma footer box: width 428 (w-full inside the 16px-inset footer),
          padding 12 (p-3), gap 8 (gap-2), radius 16, align-items flex-start,
          and a 56px height that the row hugs (32px content + 24px padding).
          The fill uses an EXPLICIT rgba rather than the `bg-black/[0.06]`
          opacity-modifier: that modifier form rendered no box in light mode
          here (the search pill above already worked around the same issue with
          an explicit `bg-[#0000000F]`), which is why the footer looked unstyled
          in light mode while dark was fine. */}
      <div className="flex w-full items-start justify-between gap-2 rounded-[16px] bg-[rgba(0,0,0,0.06)] p-3 dark:bg-[rgba(255,255,255,0.06)]">
        <button
          type="button"
          onClick={handleCopyAddress}
          title="Copy address"
          aria-label="Copy address"
          className="flex min-w-0 items-center gap-2.5 rounded-xl transition-colors hover:opacity-80"
        >
          <span className="size-8 shrink-0 overflow-hidden rounded-full">
            <Avatar colors={["#D3DFF8", "#183E91", "#3167DE", "#A6F4C5"]} name={address ?? "hippius"} size={32} variant="pixel" />
          </span>
          <div className="flex min-w-0 flex-col items-start gap-0.5">
            <span className="truncate font-inter text-[14px] font-medium leading-none tracking-[-0.4px] text-black dark:text-white">
              {shortenAddress(address)}
            </span>
            {copied ? (
              <span className="font-geist text-[10px] font-medium leading-[14px] tracking-[-0.2px] text-[#04C870]">Copied!</span>
            ) : (
              <span className="flex items-center gap-1">
                <BoxSimple className="size-[13px] shrink-0 text-black/60 dark:text-white/60" />
                {isConnected && blockNumber !== null && (
                  <span className="font-geist text-[10px] font-medium leading-[14px] tracking-[-0.2px] text-primary-50 dark:text-primary-brand-dark">
                    #&nbsp;{blockNumber}
                  </span>
                )}
              </span>
            )}
          </div>
        </button>
        <Button
          variant="primary"
          size="auto"
          onClick={() => void openMainWindow()}
          className="flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg px-3 text-[14px] font-semibold"
        >
          Open Hippius
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </footer>
  );
}

// ── Cross-window navigation ────────────────────────────────────────────────

/**
 * Reveal the main app window (optionally navigating it), then hide the popover.
 *
 * The popover runs in its own webview, so `getCurrentWindow()` here is the
 * panel — the main window must be addressed explicitly by its `"main"` label.
 * Navigation is requested via a backend event the main window already listens
 * for, keeping cross-window routing out of this throwaway window.
 */
async function openMainWindow() {
  try {
    await revealMain();
    await invoke("hide_tray_panel");
  } catch (error) {
    console.error("[TrayPanel] Failed to open main window:", error);
  }
}

/**
 * Focus the main window and open its existing top-bar notifications dropdown
 * (the same Radix portal/component, which owns the notification providers).
 * The panel only triggers it via an event — see `NotificationMenu`'s listener.
 */
async function openMainNotifications() {
  try {
    await revealMain();
    await emit("hippius:tray-open-notifications", {});
    await invoke("hide_tray_panel");
  } catch (error) {
    console.error("[TrayPanel] Failed to open notifications:", error);
  }
}

/**
 * Focus the main window and focus its sidebar search input (the same field the
 * main window's Ctrl/Cmd+F shortcut targets). Done via an event rather than a
 * route navigation — the popover is a separate webview, and `router.push`-ing a
 * protected route from here is both unnecessary and error-prone.
 */
async function openMainSearch() {
  try {
    await revealMain();
    await emit("hippius:tray-focus-search", {});
    await invoke("hide_tray_panel");
  } catch (error) {
    console.error("[TrayPanel] Failed to open search:", error);
  }
}

/** Focus the main window and navigate it to the Drive (files) page — used by
 *  the empty-state "Upload a File" CTA. Routing happens in the main window (via
 *  `TrayNavigationListener`), never in this popover webview. */
async function openMainFiles() {
  try {
    await revealMain();
    await emit("hippius:tray-open-files", {});
    await invoke("hide_tray_panel");
  } catch (error) {
    console.error("[TrayPanel] Failed to open Drive:", error);
  }
}

/** Reveal + focus the `main` window (addressed by label — the popover runs in
 *  its own webview, so `getCurrentWindow()` here is the panel, not main). */
async function revealMain() {
  const main = await Window.getByLabel("main");
  if (!main) return;
  if (await main.isMinimized()) await main.unminimize();
  await main.show();
  await main.setFocus();
}

// ── Presentation helpers ────────────────────────────────────────────────────

/** Display name for an upload row: strip the internal `.ec_metadata` folder
 *  suffix, but do NOT length-truncate — CSS `truncate` ellipsizes based on the
 *  row's actual available width, so names use the full row before clipping. */
function displayFileName(rawName: string): string {
  return rawName.endsWith(DIRECTORY_SUFFIX) ? rawName.slice(0, -DIRECTORY_SUFFIX.length) : rawName;
}

/** `5cRyFw…Quus`-style short form of a substrate address. */
function shortenAddress(address: string | null): string {
  if (!address) return "Not signed in";
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
