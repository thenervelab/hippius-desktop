"use client";

import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import dynamic from "next/dynamic";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { Upload, Check, AlertCircle } from "lucide-react";
import "./tray-panel.css";
import TrayTiles from "./TrayTiles";
import TrayHeaderMenu from "./TrayHeaderMenu";
import TrayUploadRow, { ProgressRing } from "./TrayUploadRow";
import { openMainUpload, openMainWindow, revealMain } from "./trayMainWindow";
import { useTrayCaptureView } from "./useTrayCaptureView";
import { useTrayPanelData } from "@/app/lib/tray/useTrayPanelData";
import { getTraySyncLine } from "@/app/lib/tray/traySyncSummary";
import { trayRowOpensViewer } from "@/app/lib/tray/trayRowActions";
import {
  DEFAULT_TRAY_TAB,
  readTrayTab,
  saveTrayTab,
  type TrayTab,
} from "@/app/lib/tray/trayTab";
import type { SyncSnapshot } from "@/app/lib/types/syncSnapshot";
import {
  dedupKey,
  type UploadFeedItem,
} from "@/app/lib/upload-feed/mergeUploadFeed";
import { groupUploadFeed } from "@/app/lib/upload-feed/groupUploadFeed";
import Button from "@/app/components/ui/button";
import HippiusLogo from "@/app/components/ui/icons/HippiusLogo";
import Search from "@/app/components/ui/icons/Search";
import Command from "@/app/components/ui/icons/Command";
import ArrowRight from "@/app/components/ui/icons/ArrowRight";
import Notification from "@/app/components/ui/icons/Notification";
import { MessagesSquare } from "lucide-react";
import BoxSimple from "@/app/components/ui/icons/BoxSimple";
import MiddleTruncate from "@/app/components/ui/MiddleTruncate";
import { formatBalanceUsd } from "@/app/lib/utils/formatBalanceUsd";

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
  const {
    menu,
    feed,
    captures,
    snapshot,
    blockNumber,
    isConnected,
    unreadCount,
    chatUnread,
    loading,
  } = useTrayPanelData();
  const { view: captureView, shortcut } = useTrayCaptureView();
  // Where capture is off or unsupported there is no Captures tab: the list
  // is every upload, as before the tabs.
  const hasCapturesTab = captureView.state !== "hidden";
  const [chosenTab, setChosenTab] = useState<TrayTab>(DEFAULT_TRAY_TAB);
  // Read after mount: the static export prerenders without storage, and the
  // first client render must match it.
  useEffect(() => setChosenTab(readTrayTab()), []);
  const tab: TrayTab = hasCapturesTab ? chosenTab : "all";
  const chooseTab = (next: TrayTab) => {
    setChosenTab(next);
    saveTrayTab(next);
  };

  const list = tab === "captures" ? captures : feed;
  // A row in the feed that Rust also listed as a capture reads as a
  // Screenshot or a Recording there too.
  const captureKeys = useMemo(
    () => new Set(captures.map((item) => dedupKey(item))),
    [captures],
  );
  // Date-bucketed for the headed list (Today / Yesterday / This Week / …).
  // Live uploading/failed rows carry createdAt=now, so they lead "Today".
  const groups = groupUploadFeed(list);
  // What the viewer walks when a row is opened: the files of this tab it
  // can show, in the tab's order.
  const viewable = useMemo(() => list.filter(trayRowOpensViewer), [list]);

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
      <div
        className={`tray-panel-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-[16px] ${cardSurface} font-geist text-black dark:text-white`}
      >
        <Header
          balance={menu?.balance ?? null}
          unreadCount={unreadCount}
          chatUnread={chatUnread}
          showCapturesFolder={hasCapturesTab}
        />
        {/* Screenshot / Record / Upload, above the search field. Only Upload
            where capture is off or unsupported (see TrayTiles). */}
        <TrayTiles view={captureView} shortcut={shortcut} />
        <SearchBar />

        <div className="flex items-center justify-between gap-3 px-5 pb-1 pt-4">
          {hasCapturesTab ? (
            <TabSwitch tab={tab} onChange={chooseTab} />
          ) : (
            <h2 className="font-geist text-[14px] font-medium leading-7 text-grey-10 dark:text-white">
              Your Uploads
            </h2>
          )}
          {/* One line in place of the old sync card; the same summary
              (`getTraySyncSummary`) said shortly. */}
          <SyncLine snapshot={snapshot} />
        </div>

        <div
          role={hasCapturesTab ? "tabpanel" : undefined}
          id={hasCapturesTab ? TAB_PANEL_ID : undefined}
          aria-labelledby={hasCapturesTab ? tabId(tab) : undefined}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-2"
        >
          {list.length === 0 && loading ? (
            // First load (no data yet): skeleton placeholders instead of the
            // empty state, so a fresh open doesn't flash "No files yet" before the
            // first fetch resolves. The empty state is shown only once loading
            // settles with a genuinely empty list (below).
            <UploadRowsSkeleton />
          ) : list.length === 0 ? (
            tab === "captures" ? (
              <EmptyCard
                title="No captures yet"
                body="Take a screenshot or record your screen. It shows up here with its link ready to copy."
              />
            ) : (
              <EmptyCard
                title="No files yet"
                body="Start by uploading a file to see it here."
                action={
                  <Button
                    variant="primary"
                    size="auto"
                    onClick={() => void openMainUpload()}
                    className="flex h-11 w-full items-center justify-center gap-2 rounded-xl text-[15px] font-medium"
                  >
                    <Upload className="size-4" />
                    Upload a File
                  </Button>
                }
              />
            )
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
                    <TrayUploadRow
                      key={uploadRowKey(item)}
                      item={item}
                      accountId={menu?.substrateAddress ?? null}
                      isCapture={tab === "captures" || captureKeys.has(dedupKey(item))}
                      siblings={viewable}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>

        <Footer
          address={menu?.substrateAddress ?? null}
          accountLabel={menu?.accountLabel ?? null}
          blockNumber={blockNumber}
          isConnected={isConnected}
        />
      </div>
    </div>
  );
}

/** Top bar: brand mark (left) and a single pill holding the balance + a divider +
 *  the notification bell (right) — matching the Figma header. The bell mirrors
 *  the top-bar bell: it shows the live unread count and, on click, focuses the
 *  main window and opens its existing notifications dropdown. While chat has
 *  unread DMs/mentions (the dock-badge number), a chat button with that count
 *  sits before the bell and opens the main window's chat page; it is absent at
 *  zero so a user without chat sees the header unchanged. The ⋮ menu
 *  (`TrayHeaderMenu`) ends the pill: balance and Top up, the plan, the app's
 *  pages and Quit. */
function Header({
  balance,
  unreadCount,
  chatUnread,
  showCapturesFolder,
}: {
  /** The billing API's exact decimal string; dollars, one credit = $1. */
  balance: string | null;
  unreadCount: number;
  chatUnread: number;
  /** Capture is offered here, so the menu can open the captures folder. */
  showCapturesFolder: boolean;
}) {
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
            Balance
          </span>
          {/* Dollars via the Billing page's own formatter, so the popover and
              Billing quote the same cent, with a "." decimal like the file
              sizes below; `toLocaleString` gave "0,36" on a French locale. */}
          <span
            data-testid="tray-balance"
            className="truncate font-mono text-[12px] font-medium leading-5 tracking-[-0.24px] text-black dark:text-white"
          >
            {balance === null ? "—" : formatBalanceUsd(balance)}
          </span>
        </div>
        <div className="h-6 w-px shrink-0 rounded-2xl bg-[#606060] opacity-40" />
        {chatUnread > 0 && (
          <button
            type="button"
            onClick={() => void openMainChat()}
            aria-label={`Chat, ${chatUnread} unread`}
            className="relative flex h-9 w-9 items-center justify-center rounded-lg text-black transition-colors hover:bg-black/5 dark:text-white dark:hover:bg-white/10"
          >
            <MessagesSquare className="size-[14px] shrink-0 opacity-40" />
            <span
              data-testid="tray-chat-unread-count"
              className={`absolute -right-0.5 -top-0.5 flex items-center justify-center rounded-full bg-primary-50 font-medium leading-none text-white ${
                chatUnread < 10
                  ? "h-4 min-w-4 text-[10px]"
                  : "h-3 min-w-3 px-[3px] text-[7px]"
              }`}
            >
              {chatUnread > 99 ? "99+" : chatUnread}
            </span>
          </button>
        )}
        <button
          type="button"
          onClick={() => void openMainNotifications()}
          aria-label={
            unreadCount > 0
              ? `Notifications, ${unreadCount} unread`
              : "Notifications"
          }
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
        <TrayHeaderMenu balance={balance} showCapturesFolder={showCapturesFolder} />
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
          <span className="truncate font-geist text-[16px] font-medium leading-5">
            Search your files
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1 font-geist text-[14px] font-medium text-black/30 dark:text-white/30">
          <Command className="size-[14px]" strokeWidth={1.5} />
          <span>F</span>
        </span>
      </button>
    </div>
  );
}

const TAB_PANEL_ID = "tray-files-panel";
const TABS: { id: TrayTab; label: string }[] = [
  { id: "captures", label: "Captures" },
  { id: "all", label: "All files" },
];
const tabId = (tab: TrayTab) => `tray-tab-${tab}`;

/**
 * "Captures | All files": a segmented control in the search pill's fill.
 * A real tab list for assistive tech; the arrow keys, Home and End move
 * between the two (the selected tab is the one in the tab order).
 */
function TabSwitch({
  tab,
  onChange,
}: {
  tab: TrayTab;
  onChange: (tab: TrayTab) => void;
}) {
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((t) => t.id === tab);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    else return;
    event.preventDefault();
    onChange(TABS[next].id);
    document.getElementById(tabId(TABS[next].id))?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label="Files to show"
      onKeyDown={onKeyDown}
      className="flex shrink-0 items-center gap-0.5 rounded-[10px] bg-[#0000000F] p-0.5 dark:bg-white/[0.06]"
    >
      {TABS.map(({ id, label }) => {
        const selected = id === tab;
        return (
          <button
            key={id}
            id={tabId(id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={TAB_PANEL_ID}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(id)}
            className={`h-7 rounded-[8px] px-3 font-geist text-[13px] font-medium leading-none tracking-[-0.26px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary-50 dark:focus-visible:ring-primary-brand-dark ${
              selected
                ? "bg-white text-grey-10 shadow-[0_1px_2px_rgba(0,0,0,0.08)] dark:bg-white/15 dark:text-white"
                : "text-[rgba(0,0,0,0.5)] hover:text-[rgba(0,0,0,0.8)] dark:text-white/50 dark:hover:text-white/80"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** Per-tone colour of the sync line (the sidebar widget's tokens). */
const SYNC_LINE_TONE = {
  synced: "text-grey-70 dark:text-white/60",
  active: "text-[#3167DD] dark:text-primary-brand-dark",
  failed: "text-[#FF6D61]",
} as const;

/**
 * The sync status in one short line beside the tabs: "All synced" with a
 * green check, "Uploading 2 · 64%" with a ring, or the failures in the
 * error tone. The fuller sentence is its tooltip and is read out with it.
 */
function SyncLine({ snapshot }: { snapshot: SyncSnapshot }) {
  const line = getTraySyncLine(snapshot);
  return (
    <span
      role="status"
      data-testid="tray-sync-line"
      data-tone={line.tone}
      title={line.detail}
      className={`flex min-w-0 items-center gap-1.5 font-geist text-[12px] font-medium leading-none tracking-[-0.24px] ${SYNC_LINE_TONE[line.tone]}`}
    >
      {line.tone === "synced" ? (
        <Check className="size-3.5 shrink-0 text-[#04C870]" strokeWidth={3} aria-hidden />
      ) : line.tone === "failed" ? (
        <AlertCircle className="size-3.5 shrink-0" aria-hidden />
      ) : (
        <ProgressRing value={line.percent} />
      )}
      <span className="truncate">{line.text}</span>
      <span className="sr-only">. {line.detail}</span>
    </span>
  );
}

/** The list's empty state: a single simple rounded card with copy and,
 *  for All files, the Upload CTA that opens the main window's upload dialog. */
function EmptyCard({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 items-center justify-center py-2">
      {/* Explicit rgba fills/borders, not the arbitrary opacity-modifier
          form (border-black/[0.08] etc.), which didn't render in light
          mode here (same fix applied to the footer and credits pill). */}
      <div className="flex w-full flex-col gap-4 rounded-2xl border border-[rgba(0,0,0,0.08)] bg-[rgba(0,0,0,0.02)] p-5 shadow-sm dark:border-white/10 dark:bg-[rgba(255,255,255,0.03)]">
        <div className="flex flex-col gap-1.5">
          <h3 className="font-geist text-[18px] font-medium leading-6 tracking-[-0.54px] text-grey-10 dark:text-white">
            {title}
          </h3>
          <p className="font-geist text-[14px] leading-5 text-black/50 dark:text-white/50">
            {body}
          </p>
        </div>
        {action}
      </div>
    </div>
  );
}

/** First-load placeholder for the upload list: a faint group heading plus a
 *  handful of rows mirroring the row's layout (thumbnail + name + subtitle).
 *  Uses explicit rgba fills, not `bg-black/x` (dead here: the black palette has
 *  no DEFAULT key, so the modifier renders nothing in light mode). */
function UploadRowsSkeleton() {
  const bar = "rounded bg-[rgba(0,0,0,0.08)] dark:bg-white/10";
  return (
    <div aria-hidden className="animate-pulse">
      <div className={`mb-1 mt-3 h-4 w-16 ${bar}`} />
      <ul>
        {Array.from({ length: 5 }).map((_, i) => (
          <li key={i} className="flex items-center gap-3 py-2">
            <span className={`h-[42px] w-16 shrink-0 rounded-[8px] ${bar}`} />
            <div className="min-w-0 flex-1">
              <div className={`h-3.5 w-1/2 ${bar}`} />
              <div className={`mt-2 h-3 w-2/5 ${bar}`} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Stable React key: drive label + relative path keeps a row identity across
 *  the uploading → completed transition (avoids a remount that would restart
 *  the row's transitions). */
function uploadRowKey(item: UploadFeedItem): string {
  return `${item.label ?? ""}::${item.actualFileName || item.name}`;
}

/** Bottom bar: a single rounded box (Figma tokens — 8px gap, 16px radius,
 *  6%-opacity fill) inset 16px from the card edges, holding the account chip
 *  on the left and the official `Button` CTA on the right.
 *
 *  The chip names the account the way the sidebar's ProfileCard does: an
 *  OAuth account leads with how it signs in (`accountLabel`, resolved in
 *  Rust: email, or `@handle` for GitHub) with its SS58 underneath in small
 *  type, because a Drive user knows themselves by their email and has no use
 *  for a block height. An access-key account has no such identity, so it
 *  keeps the short address over the live chain block. */
function Footer({
  address,
  accountLabel,
  blockNumber,
  isConnected,
}: {
  address: string | null;
  accountLabel: string | null;
  blockNumber: number | null;
  isConnected: boolean;
}) {
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
      .catch((error) =>
        console.error("[TrayPanel] Failed to copy address:", error),
      );
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
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl text-left transition-colors hover:opacity-80"
        >
          <span className="size-8 shrink-0 overflow-hidden rounded-full">
            <Avatar
              colors={["#D3DFF8", "#183E91", "#3167DE", "#A6F4C5"]}
              name={address ?? "hippius"}
              size={32}
              variant="pixel"
            />
          </span>
          <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
            {accountLabel ? (
              <MiddleTruncate
                text={accountLabel}
                className="font-inter text-[14px] font-medium leading-none tracking-[-0.4px] text-black dark:text-white"
              />
            ) : (
              <span className="truncate font-inter text-[14px] font-medium leading-none tracking-[-0.4px] text-black dark:text-white">
                {shortenAddress(address)}
              </span>
            )}
            {copied ? (
              <span className="font-geist text-[10px] font-medium leading-[14px] tracking-[-0.2px] text-[#04C870]">
                Copied!
              </span>
            ) : accountLabel && address ? (
              <span className="flex w-full min-w-0 items-center gap-1">
                <BoxSimple className="size-[13px] shrink-0 text-black/60 dark:text-white/60" />
                <MiddleTruncate
                  text={address}
                  kind="address"
                  className="font-geist text-[10px] font-medium leading-[14px] tracking-[-0.2px] text-primary-50 dark:text-primary-brand-dark"
                />
              </span>
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

/** Focus the main window and navigate it to the chat page — routing happens in
 *  the main window (`TrayNavigationListener`), never in this popover webview. */
async function openMainChat() {
  try {
    await revealMain();
    await emit("hippius:tray-open-chat", {});
    await invoke("hide_tray_panel");
  } catch (error) {
    console.error("[TrayPanel] Failed to open chat:", error);
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

// ── Presentation helpers ────────────────────────────────────────────────────

/** `5cRyFw…Quus`-style short form of a substrate address. */
function shortenAddress(address: string | null): string {
  if (!address) return "Not signed in";
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
