"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { Window } from "@tauri-apps/api/window";
import { Upload } from "lucide-react";
import "./tray-panel.css";
import { useTrayPanelData, type SyncActivityRow } from "@/app/lib/tray/useTrayPanelData";
import { getFileTypeFromExtension } from "@/app/lib/utils/getTileTypeFromExtension";
import { getFileIcon, DIRECTORY_SUFFIX } from "@/app/lib/utils/fileTypeUtils";
import { formatBytes } from "@/app/lib/utils/formatBytes";
import Button from "@/app/components/ui/button";
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
 * The window is transparent (so the card's rounded corners show through), but
 * the card itself is an OPAQUE solid fill — `bg-white` / dark `bg-[#1e1e1e]`.
 * A translucent fill + `backdrop-filter: blur()` was tried to match the Figma
 * "frosted" look, but WebKit does not blur the desktop behind a transparent
 * macOS window (it just alpha-blends), so the content behind showed straight
 * through. A true frost would need native vibrancy (window effects), not CSS.
 * Light/dark follow the OS via Tailwind's media strategy (`darkMode: "class"`
 * is off), exactly like the rest of the app. The search field mirrors the
 * sidebar's search styling.
 */
export default function TrayPanelPage() {
  const { menu, activity, blockNumber, isConnected, unreadCount } = useTrayPanelData();
  const groups = groupByDay(activity);

  return (
    <div className="tray-panel-card flex h-screen w-screen flex-col overflow-hidden rounded-[16px] bg-white font-geist text-black dark:bg-[#1e1e1e] dark:text-white">
      <Header credits={menu?.credits ?? null} unreadCount={unreadCount} />
      <SearchBar />

      <div className="flex flex-1 flex-col overflow-y-auto px-5 pb-2">
        <h2 className="py-2 font-geist text-[16px] font-medium leading-8 text-grey-10 dark:text-white">Your Uploads</h2>

        {activity.length === 0 ? (
          // Empty state: a single simple rounded card (no graphsheet / guide
          // lines / corner textures) with copy + the Upload CTA that opens the
          // Drive page.
          <div className="flex flex-1 items-center justify-center py-2">
            <div className="flex w-full flex-col gap-4 rounded-2xl border border-black/[0.08] bg-black/[0.02] p-5 shadow-sm dark:border-white/10 dark:bg-white/[0.03]">
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
          groups.map((group) => (
            <section key={group.label} className="mb-1">
              <h3 className="mb-1 mt-3 font-mono text-[14px] font-medium uppercase leading-5 tracking-[-0.28px] text-grey-70">{group.label}</h3>
              <ul>
                {group.rows.map((row) => (
                  <ActivityRowItem key={row.id} row={row} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      <Footer address={menu?.substrateAddress ?? null} blockNumber={blockNumber} isConnected={isConnected} />
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
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-50">
        <HippiusLogo className="size-7 text-white" />
      </div>

      <div className="flex items-center gap-3 rounded-xl bg-black/[0.06] py-1.5 pl-4 pr-2 dark:bg-white/[0.06]">
        <div className="flex flex-col text-center">
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
              className="absolute -right-0.5 -top-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-primary-50 px-[3px] text-[7px] font-medium leading-none text-white"
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

/** A single upload row. Layout mirrors the Figma: the file-type icon aligns
 *  with the filename on the top line, and the size sits below — sharing that
 *  bottom line with the right-aligned status, so size and status line up. */
function ActivityRowItem({ row }: { row: SyncActivityRow }) {
  const ext = row.raw_name.includes(".") ? row.raw_name.split(".").pop() ?? null : null;
  const fileType = getFileTypeFromExtension(ext);
  const { icon: Icon, color } = getFileIcon(fileType ?? undefined, false);

  return (
    <li className="flex items-start gap-3 py-2.5">
      <span className={`mt-px flex size-4 shrink-0 items-center justify-center ${color}`}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-geist text-[14px] font-medium leading-normal tracking-[-0.28px] text-[#1d1d1d] dark:text-white">
          {displayFileName(row.raw_name)}
        </p>
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="truncate font-geist text-[12px] font-medium leading-normal tracking-[-0.24px] text-grey-10 dark:text-white">
            {formatBytes(row.size)}
          </span>
          <StatusLabel status={row.deleted ? "deleted" : row.status} />
        </div>
      </div>
    </li>
  );
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
function StatusLabel({ status, timeLeft, progress }: { status: string; timeLeft?: string | null; progress?: number | null }) {
  const base = "shrink-0 font-mono text-[10px] font-medium uppercase leading-none tracking-[-0.2px]";

  // Uploading with an ETA: brand-blue ring + "X mins left".
  if (status === "uploading" && timeLeft) {
    return (
      <span className={`flex items-center gap-1.5 text-[#3167DD] ${base}`}>
        <ProgressRing value={progress ?? 0} />
        {timeLeft}
      </span>
    );
  }

  const map: Record<string, { label: string; className: string }> = {
    uploaded: { label: "UPLOADED", className: "text-[#04C870]" },
    pending: { label: "PENDING", className: "text-[#FEB101]" },
    failed: { label: "FAILED", className: "text-[#FF6D61]" },
    uploading: { label: "UPLOADING", className: "text-[#3167DD]" },
    deleted: { label: "DELETED", className: "text-black/40 dark:text-white/40" },
  };
  const entry = map[status] ?? { label: status.toUpperCase(), className: "text-black/40 dark:text-white/40" };
  return <span className={`${base} ${entry.className}`}>{entry.label}</span>;
}

/** Bottom bar: a single rounded box (Figma tokens — 12px padding, 8px gap,
 *  16px radius, 6%-opacity fill) holding the account chip (identicon + short
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
    <footer className="px-3 pb-3">
      <div className="flex w-full items-center justify-between gap-2 rounded-[16px] bg-black/[0.06] p-3 dark:bg-white/[0.06]">
        <button
          type="button"
          onClick={handleCopyAddress}
          title="Copy address"
          aria-label="Copy address"
          className="flex min-w-0 items-center gap-2.5 rounded-xl transition-colors hover:opacity-80"
        >
          <span className="size-[30px] shrink-0 overflow-hidden rounded-full">
            <Avatar colors={["#D3DFF8", "#183E91", "#3167DE", "#A6F4C5"]} name={address ?? "hippius"} size={30} variant="pixel" />
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
                    #&nbsp;{blockNumber.toLocaleString()}
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
          className="flex h-[30px] shrink-0 items-center justify-center gap-1 rounded-lg px-3 text-[14px] font-semibold"
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

interface DayGroup {
  label: string;
  rows: SyncActivityRow[];
}

/** Group activity rows into Today / Yesterday / Earlier buckets, newest first. */
function groupByDay(rows: SyncActivityRow[]): DayGroup[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;

  const today: SyncActivityRow[] = [];
  const yesterday: SyncActivityRow[] = [];
  const earlier: SyncActivityRow[] = [];

  for (const row of rows) {
    const ms = normalizeTimestamp(row.timestamp);
    if (ms >= startOfToday) today.push(row);
    else if (ms >= startOfYesterday) yesterday.push(row);
    else earlier.push(row);
  }

  return [
    { label: "Today", rows: today },
    { label: "Yesterday", rows: yesterday },
    { label: "Earlier", rows: earlier },
  ].filter((g) => g.rows.length > 0);
}

/** Activity timestamps may arrive in seconds or milliseconds; normalize to ms. */
function normalizeTimestamp(ts: number | null): number {
  if (ts === null) return 0;
  return ts < 1e12 ? ts * 1000 : ts;
}

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
