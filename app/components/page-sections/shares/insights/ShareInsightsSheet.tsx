"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BarChart3, Eye, EyeOff, FileText, Link2, Settings, SmilePlus, Sparkles, X } from "lucide-react";
import MiddleTruncate from "@/components/ui/MiddleTruncate";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { SidePanel } from "@/components/ui/SidePanel";
import TabList from "@/components/ui/tabs/TabList";
import TabPanel from "@/components/ui/tabs/TabPanel";
import { cn } from "@/lib/utils";
import { BILLING_ROUTE } from "@/app/lib/routes";
import {
  insightsSheetAtom,
  shareCommentsEnabledAtom,
  type CaptureLinkSource,
  type InsightsSheetTarget,
} from "@/app/lib/global-atoms/sharesAtoms";
import { findCachedShare, SHARES_QUERY_KEY } from "@/app/lib/hooks/useSharedFiles";
import { createCaptureLink } from "@/app/lib/tauri/shares";
import { newestShare, useCaptureShares } from "@/components/page-sections/drive/useCaptureInsightsItem";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import {
  getInsightsPanelLinkDefault,
  getShareInsights,
  getShareReactions,
  listShareComments,
  type Gated,
  type InsightsPages,
  type LinkSettingsDefault,
  type InsightsViewer,
  type ReactionCount,
  type ShareComment,
  type ShareInsights,
  type ShareReactions,
} from "@/app/lib/tauri/shareInsights";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { useIsOnline } from "@/app/lib/hooks/useIsOnline";
import { CommentsTab, PersonName, useCommentModeration } from "./CommentThreads";
import { EmptyLine } from "./EmptyLine";
import { InsightsAvatar } from "./InsightsAvatar";
import { LinkField, ListingKeeper, useAppLocked } from "./PanelLink";
import { MediaPreview, usePanelMedia } from "./PanelMedia";
import { locationOf, panelLink, type DriveLocation } from "./panelLinkMedia";
import { LinkSettingsPopover, SETTINGS_TRIGGER_ATTR, SwitchOffNotice, useLinkSwitches } from "./LinkSettingsPopover";
import { commentsQueryKey, insightsQueryKey, linkSettingsQueryKey, reactionsQueryKey, PANEL_QUERY } from "./queryKeys";
import { RetentionChart } from "./RetentionChart";
import {
  COMPARE_PLANS,
  PAGES_PAGE,
  PRICING_URL,
  SAMPLE_DOCUMENT_VIEWERS,
  SAMPLE_PAGES,
  SAMPLE_AVERAGE_WATCH_MS,
  SAMPLE_COMPLETION,
  SAMPLE_RETENTION,
  SAMPLE_UNIQUE_VIEWERS,
  SAMPLE_VIEWERS,
  SAMPLE_LABEL,
  SAMPLE_STILL_VIEWERS,
  SAMPLE_VIEWS,
  UPGRADE_PLAN,
  VIEWERS_PAGE,
  biggestDrop,
  biggestPageDrop,
  countLabel,
  defaultInsightsTab,
  estimateDurationMs,
  formatAgo,
  formatMomentAt,
  formatPercent,
  formatWatched,
  headerLine,
  loadErrorLine,
  lockCopy,
  pagesLockCopy,
  pagesSeenLabel,
  pagesTabShown,
  switchOffLine,
  switchesOffLine,
  tabLabel,
  type InsightsTab,
} from "./insightsView";
import { BAR_FILL, BAR_TRACK, CARD, DIVIDE, FILL, HAIRLINE, ICON_BUTTON, MUTED, RING, SKELETON, STRONG, TEXT_LINK } from "./panelStyles";

/**
 * Wider than File Details' 305: like Manage access, this panel holds lists,
 * a chart and a row of numbers.
 */
export const INSIGHTS_PANEL_WIDTH_PX = 360;

export { insightsQueryKey, commentsQueryKey, reactionsQueryKey, linkSettingsQueryKey };

const VIDEO_NAME = /\.(mp4|mov|m4v|webm|mkv)$/i;

/**
 * The owner's Insights for one link, opened from Shared Links, a row on the
 * Captures page or the capture card (`insightsSheetAtom`). A right-side
 * panel in the same slot as File Details and Manage access (`SidePanel`),
 * mounted once beside the page in `ResponsiveContent`, so it opens over
 * whatever page is showing. Every number, and whether it is locked, comes
 * from Rust.
 */
export default function ShareInsightsSheet() {
  const [target, setTarget] = useAtom(insightsSheetAtom);
  const onClose = () => setTarget(null);
  // The link "Create link" just made: its panel takes focus from the button
  // that is gone now, since the panel itself stays open.
  const created = useRef<string | null>(null);
  return (
    <SidePanel
      open={target !== null}
      onClose={onClose}
      width={INSIGHTS_PANEL_WIDTH_PX}
      label={target ? `Insights for ${target.fileName}` : "Insights"}
      focusKey={target ? panelFocusKey(target) : undefined}
    >
      {target &&
        (target.shareToken !== null ? (
          <InsightsPanelFor
            key={target.shareToken}
            shareToken={target.shareToken}
            fileName={target.fileName}
            file={target.file}
            onClose={onClose}
            focusHeading={created.current === target.shareToken}
          />
        ) : (
          // Keyed by the capture, so opening another one while a link is
          // being made starts a fresh panel instead of carrying the first
          // one's "Creating link…" over to it.
          <CaptureInsightsPanel
            key={panelFocusKey(target)}
            target={target}
            onClose={onClose}
            onLinkCreated={(capture, shareToken) => {
              // The link belongs to the capture it was made for: if the panel
              // has moved on to another capture meanwhile, it stays as it is.
              setTarget((prev) => {
                if (!prev || prev.shareToken !== null || !prev.capture || !sameCapture(prev.capture, capture)) return prev;
                created.current = shareToken;
                return { ...prev, shareToken };
              });
            }}
          />
        ))}
    </SidePanel>
  );
}

/**
 * What the panel is about, for `SidePanel`'s focus handling: the capture
 * when it was opened for one, so making its link (which gives the target a
 * token) does not count as opening the panel for something new.
 */
function panelFocusKey(target: InsightsSheetTarget): string {
  return target.capture ? `capture:${target.capture.label}/${target.capture.relativePath}` : (target.shareToken ?? "");
}

/** Two captures are the same file: the same drive and drive-relative path. */
export function sameCapture(a: CaptureLinkSource, b: CaptureLinkSource): boolean {
  return a.label === b.label && a.relativePath === b.relativePath;
}

/**
 * A capture opened before a link was known (a Captures row with none, or
 * the tray): its newest link from the share listing already loaded, else
 * the "Create link" step. Nothing is fetched per capture to find it.
 */
function CaptureInsightsPanel({
  target,
  onClose,
  onLinkCreated,
}: {
  target: InsightsSheetTarget;
  onClose: () => void;
  onLinkCreated: (capture: CaptureLinkSource, shareToken: string) => void;
}) {
  const { sharesFor, isLoading, isError, refetch } = useCaptureShares();
  const capture = target.capture;
  const share = capture ? newestShare(sharesFor(capture.label, capture.relativePath, target.file?.size)) : null;
  if (!share && isError) {
    // Not "No link yet": the capture may well have one. Offering Create
    // link here is how it ended up with a second one.
    return <ListingErrorPanel target={target} onClose={onClose} onRetry={refetch} />;
  }
  if (share) {
    return (
      <InsightsPanelFor
        key={share.shareToken}
        shareToken={share.shareToken}
        fileName={target.fileName}
        file={target.file}
        onClose={onClose}
      />
    );
  }
  return (
    <NoLinkPanel
      target={target}
      listingLoading={isLoading}
      onClose={onClose}
      onLinkCreated={onLinkCreated}
    />
  );
}

/** After Create link, when the new link's switches could not be turned on. */
export const SWITCHES_NOT_SENT =
  "The link was made, but its Insights, comments and reactions couldn't be turned on. Turn them on in Link settings.";

/** The no-link step's words. */
export const NO_LINK_TITLE = "No link yet";
export const CREATE_LINK = "Create link";
/** Said with every no-link step: what kind of link Create link makes. */
export const NO_LINK_PUBLIC = "Anyone with the link can open it, and it keeps working until you turn it off.";
/**
 * What Create link would give this file, from Rust's answer
 * (`insights_panel_link_default`: the plan, the server, and for a capture
 * Settings' "Track views, comments and reactions"), or `null` before it
 * answers. A screenshot or recording is "this capture"; anything else, and
 * anything before Rust answers, is "this file".
 */
export function noLinkBody(
  defaults: (Pick<LinkSettingsDefault, "offered" | "on" | "switchesInPlan"> & { isCapture?: boolean }) | null,
): string {
  const noun = defaults?.isCapture === false || !defaults ? "file" : "capture";
  let first = `Create a link to share this ${noun}.`;
  if (defaults?.on.insights) {
    first = defaults.on.comments
      ? `Create a link to see how many people view this ${noun}, and their comments and reactions, here.`
      : `Create a link to see how many people view this ${noun} here.`;
  } else if (defaults?.switchesInPlan === false && defaults.offered.insights) {
    first = `Create a link to share this ${noun}. Counting views, comments and reactions comes with paid Drive plans.`;
  } else if (defaults?.switchesInPlan === true && defaults.offered.insights && defaults.isCapture !== false) {
    first = `Create a link to share this ${noun}. It won't count views, comments or reactions: that's turned off in Settings, Screenshots & Recording.`;
  }
  return `${first} ${NO_LINK_PUBLIC}`;
}

/** Create link found the file's own link and gave that one again. */
export const REUSED_COPIED = "This file already had a link. It's copied.";
export const REUSED = "This file already had a link.";

/** The file's links could not be read: say so, and offer to try again. */
export const LISTING_ERROR_TITLE = "Couldn't check for a link";
export const LISTING_ERROR_BODY = "Hippius couldn't load this file's links, so it can't tell yet whether it already has one.";

function ListingErrorPanel({ target, onClose, onRetry }: { target: InsightsSheetTarget; onClose: () => void; onRetry: () => void }) {
  return (
    <div className="relative flex h-full min-h-0 flex-col font-geist" data-testid="insights-panel-listing-error">
      <PanelHeader
        file={target.file}
        fileName={target.fileName}
        location={captureLocation(target)}
        subtitle={null}
        onClose={onClose}
      />
      <div className={BODY}>
        <div role="alert">
          <EmptyBlock
            icon={<Link2 className="size-[18px]" />}
            title={LISTING_ERROR_TITLE}
            body={LISTING_ERROR_BODY}
            action={
              <Button variant="defaultStable" size="sm" className="mt-3" onClick={onRetry}>
                Try again
              </Button>
            }
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The panel for a capture with no link: what Insights need, and "Create
 * link". Nothing is made until the button is pressed; Rust makes the link
 * the tray's Copy link way, with its switches on where the plan includes
 * them, and the panel then shows that link's Insights.
 */
function NoLinkPanel({
  target,
  listingLoading,
  onClose,
  onLinkCreated,
}: {
  target: InsightsSheetTarget;
  listingLoading: boolean;
  onClose: () => void;
  onLinkCreated: (capture: CaptureLinkSource, shareToken: string) => void;
}) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const capture = target.capture;
  // What a new link for this file would get, so the words promise only
  // that. Rust decides it; a failed read just keeps the plain wording.
  const defaults = useQuery({
    queryKey: ["insights-panel-link-defaults", capture?.label ?? null, target.fileName],
    queryFn: () => getInsightsPanelLinkDefault(capture?.label ?? "", target.fileName),
    enabled: Boolean(capture),
    retry: false,
  });

  const create = async () => {
    if (!capture || creating) return;
    setCreating(true);
    setError(null);
    try {
      const link = await createCaptureLink(capture.label, capture.relativePath, capture.fileId, capture.size);
      // The row's link badge and Insights button, and Shared Links, read the
      // listing: ask it again so they show the new link.
      void queryClient.invalidateQueries({ queryKey: [SHARES_QUERY_KEY] });
      if (link.reused) toast.success(link.copied ? REUSED_COPIED : REUSED);
      else toast.success(link.copied ? "Link created and copied" : "Link created");
      // Said, not left to be found: the switches it asked for are off.
      if (link.switchesNotSent) toast.error(SWITCHES_NOT_SENT);
      onLinkCreated(capture, link.shareToken);
    } catch (e) {
      setError(errorMessage(e));
      setCreating(false);
    }
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col font-geist" data-testid="insights-panel-no-link">
      <PanelHeader
        file={target.file}
        fileName={target.fileName}
        location={captureLocation(target)}
        subtitle={listingLoading ? null : NO_LINK_TITLE}
        onClose={onClose}
      />
      <div className={BODY}>
        {listingLoading ? (
          <InsightsSkeleton />
        ) : (
          <EmptyBlock
            icon={<Link2 className="size-[18px]" />}
            title={NO_LINK_TITLE}
            body={noLinkBody(defaults.data ?? null)}
            action={
              capture ? (
                <div className="mt-3 flex flex-col items-start gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    className="gap-1.5"
                    disabled={creating}
                    aria-busy={creating || undefined}
                    onClick={() => void create()}
                  >
                    <Link2 className="size-3.5" aria-hidden />
                    {creating ? "Creating link…" : CREATE_LINK}
                  </Button>
                  {error && (
                    <p role="alert" className="text-xs leading-[1.45] text-error-50 dark:text-error-70">
                      {error}
                    </p>
                  )}
                </div>
              ) : null
            }
          />
        )}
      </div>
    </div>
  );
}

/** Where a capture the panel was opened for lives, for its preview. */
function captureLocation(target: InsightsSheetTarget): DriveLocation | null {
  return target.capture ? { label: target.capture.label, relativePath: target.capture.relativePath } : null;
}

/**
 * The no-link panel's header: the capture's name, a line under it, Close,
 * and the capture's preview under them.
 */
function PanelHeader({
  file,
  fileName,
  location,
  subtitle,
  onClose,
}: {
  file?: FormattedUserFile;
  fileName: string;
  location: DriveLocation | null;
  subtitle: string | null;
  onClose: () => void;
}) {
  const unlocked = !useAppLocked();
  const { media, source } = usePanelMedia({ file, fileName, location, unlocked });
  return (
    <header className={HEADER}>
      {source}
      <TitleRow fileName={fileName} subtitle={subtitle} onClose={onClose} />
      {media.status !== "none" && (
        <div className="mt-4">
          <MediaPreview media={media} fileName={fileName} />
        </div>
      )}
    </header>
  );
}

/** The panel's header: 24px sides, the sections under it 20px apart. */
const HEADER = "shrink-0 px-6 pt-5";

/**
 * The header's top row: the file's name (up to two lines), its line under
 * it, then the Link settings gear (when there is one) and Close.
 */
function TitleRow({
  fileName,
  subtitle,
  onClose,
  titleId,
  settings,
  rowRef,
}: {
  fileName: string;
  subtitle: ReactNode;
  onClose: () => void;
  titleId?: string;
  settings?: ReactNode;
  rowRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div ref={rowRef} className="flex items-start gap-1">
      <div className="min-w-0 flex-1 pr-1">
        <h2
          id={titleId}
          tabIndex={-1}
          data-panel-autofocus
          title={fileName}
          className={cn(
            "line-clamp-2 break-words text-[16px] font-semibold leading-[22px] tracking-[-0.2px] outline-none",
            STRONG,
          )}
        >
          <span className="sr-only">Insights for </span>
          {fileName}
        </h2>
        {subtitle ? (
          <p className={cn("mt-1 text-[13px] leading-[18px]", MUTED)} data-testid="insights-subtitle">
            {subtitle}
          </p>
        ) : null}
      </div>
      {settings}
      <button type="button" aria-label="Close" onClick={onClose} className={ICON_BUTTON}>
        <X className="size-4" />
      </button>
    </div>
  );
}

/** The recording's length: the capture's own, else what the viewers pin it to. */
function useDurationMs(shareToken: string, mediaMs: number | null): number | null {
  const commentsEnabled = useAtomValue(shareCommentsEnabledAtom);
  const insights = useQuery({
    queryKey: insightsQueryKey(shareToken),
    queryFn: () => getShareInsights(shareToken),
    ...PANEL_QUERY,
  });
  const comments = useQuery({
    queryKey: commentsQueryKey(shareToken),
    queryFn: () => listShareComments(shareToken),
    ...PANEL_QUERY,
    enabled: commentsEnabled,
  });
  if (mediaMs !== null) return mediaMs;
  const viewers = insights.data?.viewers;
  if (!viewers || viewers.state !== "shown") return null;
  return estimateDurationMs(viewers.value, comments.data?.comments ?? []);
}

function anyLocked(insights: ShareInsights): boolean {
  return (
    insights.completion.state === "locked" || insights.retention.state === "locked" || insights.viewers.state === "locked"
  );
}

/**
 * The panel, top to bottom: a fixed header (the name, "Shared … · link on"
 * and any switch that is off, the Link settings gear, Close, then the
 * capture's preview and the link with Copy), a fixed summary of the numbers,
 * fixed tabs (Comments, Viewers, Reactions), and one scrolling body for the
 * selected tab. With twenty comments only the body scrolls, so the header and
 * the counts stay in view.
 */
function InsightsPanelFor({
  shareToken,
  fileName,
  file,
  onClose,
  focusHeading = false,
}: {
  shareToken: string;
  fileName: string;
  file?: FormattedUserFile;
  onClose: () => void;
  /** Take focus on mount: the panel stayed open while its content changed. */
  focusHeading?: boolean;
}) {
  const commentsEnabled = useAtomValue(shareCommentsEnabledAtom);
  const tabsId = useId();
  const titleId = useId();
  const popoverId = useId();
  const [chosenTab, setChosenTab] = useState<InsightsTab | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const titleRowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusHeading) document.getElementById(titleId)?.focus();
    // Once, on mount: later renders must not pull focus back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Link settings: open or not, where it sits, and what opened it.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTop, setSettingsTop] = useState(56);
  const settingsOpener = useRef<HTMLElement | null>(null);
  const openSettings = (from: HTMLElement) => {
    settingsOpener.current = from;
    const root = rootRef.current?.getBoundingClientRect();
    const row = titleRowRef.current?.getBoundingClientRect();
    if (root && row && row.bottom > 0) setSettingsTop(Math.round(row.bottom - root.top + 6));
    setSettingsOpen(true);
  };

  // The recording's length, read off the capture's preview when it is on
  // this device; otherwise worked out from the viewers (`estimateDurationMs`).
  const [mediaMs, setMediaMs] = useState<number | null>(null);
  const durationMs = useDurationMs(shareToken, mediaMs);
  const summary = useCachedShare(shareToken);
  // Seen in the listing, then gone from it: the link was revoked (from
  // Shared Links, say) while its panel was open.
  const seenInListing = useRef(false);
  if (summary) seenInListing.current = true;
  const turnedOff = seenInListing.current && summary === null;
  // The link to show and copy, and a picture of the capture, each only as far
  // as this computer can open them: see `panelLink` and `planPanelMedia`.
  const appLocked = useAppLocked();
  const link = panelLink(summary, appLocked);
  const { media, source } = usePanelMedia({ file, fileName, location: locationOf(summary), unlocked: !appLocked });
  const subtitle = headerLine({
    sharedAt: summary?.createdAt ?? null,
    durationMs,
    expiresAt: summary ? summary.expiresAt : undefined,
  });

  const insights = useQuery({
    queryKey: insightsQueryKey(shareToken),
    queryFn: () => getShareInsights(shareToken),
    ...PANEL_QUERY,
  });
  const switches = useLinkSwitches(shareToken);
  const reactions = useQuery({
    queryKey: reactionsQueryKey(shareToken),
    queryFn: () => getShareReactions(shareToken),
    ...PANEL_QUERY,
    enabled: commentsEnabled,
  });
  const moderation = useCommentModeration(shareToken, commentsEnabled);
  const settings = switches.current.data ?? null;
  // What the link has turned off, said once in the header's line; the gear
  // changes it.
  const offLine = switchesOffLine(settings);
  const notCounting = settings?.offered.insights === true && !settings.on.insights;

  const commentList = moderation.comments.data?.comments ?? [];
  const commentCount = commentsEnabled ? commentList.length : 0;
  const plan = insights.data?.plan ?? null;

  // A link nothing has happened on yet shows its zeros and each tab's one
  // empty line, the same layout as a busy one.
  const loading = insights.isPending;

  const viewers = insights.data?.viewers.state === "shown" ? insights.data.viewers.value : null;
  const tabs: Array<{ tabKey: InsightsTab; tabName: string }> = [];
  if (commentsEnabled) {
    tabs.push({
      tabKey: "comments",
      tabName: tabLabel("Comments", moderation.comments.isSuccess ? commentList.length : null),
    });
  }
  if (insights.isSuccess) tabs.push({ tabKey: "viewers", tabName: tabLabel("Viewers", viewers ? viewers.length : null) });
  // Only on a server with document views (Rust sends `pages` only then).
  const pages = insights.data?.pages ?? null;
  if (insights.isSuccess && pagesTabShown(pages, fileName)) tabs.push({ tabKey: "pages", tabName: "Pages" });
  if (commentsEnabled) {
    tabs.push({ tabKey: "reactions", tabName: tabLabel("Reactions", reactions.isSuccess ? reactions.data.total : null) });
  }
  const has = (key: InsightsTab | null) => key !== null && tabs.some((t) => t.tabKey === key);
  const fallback = defaultInsightsTab(commentCount);
  const tab: InsightsTab | null = has(chosenTab) ? chosenTab : has(fallback) ? fallback : (tabs[0]?.tabKey ?? null);
  const goToTab = (next: InsightsTab) => {
    setChosenTab(next);
    scrollRef.current?.scrollTo?.({ top: 0 });
  };

  const tabContent = (key: InsightsTab): ReactNode => {
    switch (key) {
      case "comments":
        return (
          <CommentsTab
            moderation={moderation}
            plan={plan}
            offLine={switchOffLine(settings, "comments")}
            onTurnOn={openSettings}
          />
        );
      case "viewers":
        return insights.data ? (
          <ViewersTab
            insights={insights.data}
            notCounting={notCounting}
            offLine={switchOffLine(settings, "insights")}
            onTurnOn={openSettings}
            onUpgrade={onClose}
            video={VIDEO_NAME.test(fileName)}
            durationMs={durationMs}
            comments={commentsEnabled ? commentList : []}
          />
        ) : null;
      case "pages":
        return pages ? (
          <PagesTab
            pages={pages}
            notCounting={notCounting}
            offLine={switchOffLine(settings, "insights")}
            onTurnOn={openSettings}
            onUpgrade={onClose}
          />
        ) : null;
      case "reactions":
        return (
          <ReactionsTab
            reactions={reactions}
            offLine={switchOffLine(settings, "reactions")}
            onTurnOn={openSettings}
          />
        );
    }
  };

  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 flex-col font-geist" data-testid="insights-panel">
      <ListingKeeper />
      <header className={HEADER}>
        {source}
        <TitleRow
          fileName={fileName}
          titleId={titleId}
          rowRef={titleRowRef}
          onClose={onClose}
          subtitle={turnedOff ? LINK_TURNED_OFF : [subtitle, offLine].filter(Boolean).join(" · ")}
          settings={
            !turnedOff && (
            <button
              type="button"
              {...{ [SETTINGS_TRIGGER_ATTR]: "" }}
              aria-label="Link settings"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              aria-controls={settingsOpen ? popoverId : undefined}
              onClick={(e) => (settingsOpen ? setSettingsOpen(false) : openSettings(e.currentTarget))}
              className={cn(ICON_BUTTON, settingsOpen && "bg-grey-90 text-grey-10 dark:bg-white/10 dark:text-white")}
            >
              <Settings className="size-4" aria-hidden />
            </button>
            )
          }
        />
        {!turnedOff && (
          <div className="mt-4 flex flex-col gap-3">
            <MediaPreview media={media} fileName={fileName} onDuration={setMediaMs} />
            <LinkField link={link} />
          </div>
        )}
      </header>

      {settingsOpen && !turnedOff && (
        <LinkSettingsPopover
          id={popoverId}
          shareToken={shareToken}
          switches={switches}
          top={settingsTop}
          opener={settingsOpener}
          onClose={() => setSettingsOpen(false)}
          onLeave={onClose}
        />
      )}

      {turnedOff ? (
        <div className={BODY}>
          <EmptyBlock icon={<Link2 className="size-[18px]" />} title={LINK_TURNED_OFF} body={LINK_TURNED_OFF_BODY} />
        </div>
      ) : loading ? (
        <div className={BODY}>
          <InsightsSkeleton />
        </div>
      ) : (
        <>
          <Stats
            insights={insights}
            notCounting={notCounting}
            video={VIDEO_NAME.test(fileName)}
            commentCount={!commentsEnabled ? undefined : moderation.comments.isSuccess ? commentList.length : null}
          />
          {tabs.length > 1 && tab && (
            <div className="shrink-0 px-6 pt-5">
              <TabList
                idBase={tabsId}
                ariaLabel="Insights"
                tabs={tabs}
                activeTab={tab}
                onTabChange={(key) => goToTab(key as InsightsTab)}
                className={cn("flex w-full rounded-[9px] p-[3px]", FILL)}
                gap="gap-[3px]"
                width="min-w-0 flex-1"
                height="h-[30px]"
                tabItemPaddingX="px-1.5"
                textClassName="text-[13px] font-medium"
                showTooltip={false}
              />
            </div>
          )}
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-3" data-testid="insights-body">
            {tabs.length > 1
              ? tabs.map(({ tabKey }) => (
                  <TabPanel key={tabKey} idBase={tabsId} tabKey={tabKey} activeTab={tab ?? ""}>
                    {tabContent(tabKey)}
                  </TabPanel>
                ))
              : tab && tabContent(tab)}
          </div>
        </>
      )}
    </div>
  );
}

/** A body below the header that scrolls: the panel's 24px sides. */
const BODY = "min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-5";

/** The panel of a link revoked while it was open. */
export const LINK_TURNED_OFF = "This link is turned off";
export const LINK_TURNED_OFF_BODY = "People with the link can't open it any more. Share the file again to make a new link.";

/**
 * A link's row from the share listing already loaded (`findCachedShare`),
 * kept current: the header shows a new link's date once the listing that
 * Create link asked for arrives, and a link revoked elsewhere (Shared Links)
 * drops out. Nothing is fetched for it.
 */
function useCachedShare(shareToken: string) {
  const queryClient = useQueryClient();
  const subscribe = useCallback((onChange: () => void) => queryClient.getQueryCache().subscribe(onChange), [queryClient]);
  const read = useCallback(() => findCachedShare(queryClient, shareToken), [queryClient, shareToken]);
  return useSyncExternalStore(subscribe, read, read);
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 id={id} className={cn("text-[13px] font-semibold", STRONG)}>
          {title}
        </h3>
        {aside !== undefined && aside !== null && <span className={cn("text-right text-xs", MUTED)}>{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function InsightsSkeleton() {
  return (
    <div data-testid="insights-loading" className="flex flex-col gap-5" aria-busy="true">
      <div className="flex items-end justify-between">
        <div className={cn(SKELETON, "h-8 w-28")} />
        <div className={cn(SKELETON, "h-7 w-24")} />
      </div>
      <div className={cn(SKELETON, "h-[30px] rounded-[8px]")} />
      <div className="flex flex-col gap-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={cn(SKELETON, "h-10")} />
        ))}
      </div>
    </div>
  );
}

/** "47 views" on the left; who viewed on the right. */
function Hero({ views, aside }: { views: number; aside: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3">
      <p className={cn("flex items-baseline gap-1.5", STRONG)}>
        <span className="text-[28px] font-semibold leading-none tracking-[-0.03em] tabular-nums">{views}</span>
        <span className={cn("text-sm font-medium", MUTED)}>{views === 1 ? "view" : "views"}</span>
      </p>
      <div className={cn("flex min-w-0 items-center justify-end gap-1.5 text-right text-xs", MUTED)}>{aside}</div>
    </div>
  );
}

/** Reaction totals, most first. */
function sortedReactions(reactions: ShareReactions | null | undefined): ReactionCount[] {
  return [...(reactions?.counts ?? [])].sort((a, b) => b.count - a.count);
}

/**
 * The numbers that stay in view above the tabs, three cells in one box:
 * Views, Viewers, and Comments, or for a recording how much of it people
 * watched on average. What the free plan does not include is not drawn here
 * (a locked recording shows Comments instead); the Viewers tab carries its
 * lock. `commentCount` is `undefined` on a server without comments (the
 * cell is left out) and `null` while they load.
 */
function Stats({
  insights,
  notCounting,
  video,
  commentCount,
}: {
  insights: UseQueryResult<ShareInsights>;
  notCounting: boolean;
  video: boolean;
  commentCount: number | null | undefined;
}) {
  const online = useIsOnline();
  if (insights.isError) {
    return (
      <section aria-label="Summary" className="shrink-0 px-6 pt-5">
        <div role="alert" className={cn("flex flex-col items-start gap-2 p-3", CARD)}>
          <p className="text-sm text-grey-20 dark:text-grey-dark-800">
            {loadErrorLine("insights", insights.error, online)}
          </p>
          <Button variant="defaultStable" size="sm" onClick={() => void insights.refetch()}>
            Try again
          </Button>
        </div>
      </section>
    );
  }
  const data = insights.data!;
  const locked = anyLocked(data);
  if (locked && notCounting) {
    // A free link that is not counting views has no real numbers at all.
    return (
      <section aria-label="Summary" className="shrink-0 px-6 pt-5">
        <p className={cn("flex items-center gap-1.5 text-[13.5px] font-medium", MUTED)}>
          <EyeOff aria-hidden className="size-3.5" />
          Not counting views
        </p>
      </section>
    );
  }
  const completion = video && data.completion.state === "shown" ? data.completion.value : null;
  const cells: Array<{ label: string; value: ReactNode }> = [
    { label: "Views", value: data.totalViews },
    { label: "Viewers", value: data.uniqueViewers },
  ];
  if (completion !== null) cells.push({ label: "Watched", value: formatPercent(completion) });
  else if (commentCount !== undefined) {
    cells.push({
      label: "Comments",
      value: commentCount ?? <span aria-hidden className={cn(SKELETON, "inline-block h-5 w-6 align-middle")} />,
    });
  }
  return (
    <section aria-label="Summary" className="shrink-0 px-6 pt-5">
      <dl
        className={cn("grid rounded-[10px]", RING)}
        style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}
      >
        {cells.map(({ label, value }, i) => (
          <div key={label} className={cn("flex min-w-0 flex-col-reverse px-3.5 py-3", i > 0 && cn("border-l", HAIRLINE))}>
            <dt className={cn("mt-0.5 truncate text-xs", MUTED)}>{label}</dt>
            <dd className={cn("truncate text-[22px] font-semibold leading-7 tracking-[-0.4px] tabular-nums", STRONG)}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function KpiStrip({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl
      className={cn("grid overflow-hidden rounded-[12px] border", HAIRLINE)}
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
    >
      {items.map(({ label, value }, i) => (
        <div key={label} className={cn("flex min-w-0 flex-col gap-0.5 px-2.5 py-2", i > 0 && cn("border-l", HAIRLINE))}>
          <dt className={cn("truncate text-[11.5px]", MUTED)}>{label}</dt>
          <dd className={cn("truncate text-[18px] font-semibold leading-7 tabular-nums tracking-[-0.01em]", STRONG)}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The Viewers tab: where people stopped (for a recording) and who viewed,
 * most recent first. On the free plan, the lock over sample data.
 */
function ViewersTab({
  insights,
  notCounting,
  offLine,
  onTurnOn,
  onUpgrade,
  video,
  durationMs,
  comments,
}: {
  insights: ShareInsights;
  /** The link's Insights switch is off, so its view counts are not being kept. */
  notCounting: boolean;
  offLine: string | null;
  onTurnOn: (from: HTMLElement) => void;
  onUpgrade: () => void;
  /** A recording, so it has watch time; a picture or other file has none. */
  video: boolean;
  durationMs: number | null;
  comments: ShareComment[];
}) {
  const { retention, viewers } = insights;

  if (anyLocked(insights)) {
    // Everything here is drawn from SAMPLE data, blurred, with no real value
    // anywhere in it: Rust sends none for a locked metric. A free link that
    // is not counting views has no real numbers at all, so its counts are
    // samples under the lock too. A picture's sample has no watch time.
    return (
      <Locked {...lockCopy({ video, notCounting })} onUpgrade={onUpgrade}>
        <div className="flex flex-col gap-4 p-3.5 pt-10">
          {notCounting && (
            <Hero views={SAMPLE_VIEWS} aside={<span>{countLabel(SAMPLE_UNIQUE_VIEWERS, "person viewed", "people viewed")}</span>} />
          )}
          {video && (
            <>
              <KpiStrip
                items={[
                  { label: "Completion", value: formatPercent(SAMPLE_COMPLETION) },
                  { label: "Average watch", value: formatWatched(SAMPLE_AVERAGE_WATCH_MS) },
                ]}
              />
              <RetentionChart values={SAMPLE_RETENTION} durationMs={252_000} />
            </>
          )}
          <ViewerRows viewers={video ? SAMPLE_VIEWERS : SAMPLE_STILL_VIEWERS} video={video} />
        </div>
      </Locked>
    );
  }

  const notice = offLine ? <SwitchOffNotice line={offLine} onTurnOn={onTurnOn} /> : null;

  // Comments or reactions without a single counted view (a link that
  // stopped counting, say): one line, not a zero and an empty list.
  if (insights.totalViews === 0) {
    return (
      <>
        {notice}
        <EmptyLine icon={<Eye />} text="No views yet" />
      </>
    );
  }

  const retentionValues = retention.state === "shown" ? retention.value : null;
  const viewerRows = viewers.state === "shown" ? viewers.value : [];
  const drop = retentionValues ? biggestDrop(retentionValues) : null;
  return (
    <div className="flex flex-col gap-5">
      {notice}
      {retentionValues && (
        <Section title="Where people stopped" aside={drop ? `Most left at ${formatMomentAt(drop.at, durationMs)}` : undefined}>
          <RetentionChart values={retentionValues} durationMs={durationMs} comments={comments} />
        </Section>
      )}
      {viewerRows.length === 0 ? (
        <EmptyLine icon={<Eye />} text="No viewers listed yet" />
      ) : (
        <ViewerRows viewers={viewerRows} video={video} paged />
      )}
    </div>
  );
}

/**
 * The Pages tab, for a PDF, Word or PowerPoint link: how many visits reached
 * each page (the drop-off) and the median time on it. On the free plan, the
 * lock over sample pages and viewers.
 */
function PagesTab({
  pages,
  notCounting,
  offLine,
  onTurnOn,
  onUpgrade,
}: {
  pages: Gated<InsightsPages | null>;
  notCounting: boolean;
  offLine: string | null;
  onTurnOn: (from: HTMLElement) => void;
  onUpgrade: () => void;
}) {
  if (pages.state === "locked") {
    // SAMPLE data only, blurred: Rust sends no pages for a locked link.
    return (
      <Locked {...pagesLockCopy({ notCounting })} onUpgrade={onUpgrade}>
        <div className="flex flex-col gap-4 p-3.5 pt-10">
          <PageRows pages={SAMPLE_PAGES} />
          <ViewerRows viewers={SAMPLE_DOCUMENT_VIEWERS} video={false} />
        </div>
      </Locked>
    );
  }
  const notice = offLine ? <SwitchOffNotice line={offLine} onTurnOn={onTurnOn} /> : null;
  if (!pages.value) {
    return (
      <>
        {notice}
        <EmptyLine icon={<FileText />} text="No page views yet" />
      </>
    );
  }
  const drop = biggestPageDrop(pages.value.reach);
  return (
    <div className="flex flex-col gap-5">
      {notice}
      <Section title="Drop-off by page" aside={drop ? `Most left after page ${drop.afterPage}` : undefined}>
        <PageRows pages={pages.value} paged />
      </Section>
    </div>
  );
}

/**
 * One row a page: its number, a bar and the share of visits that reached it,
 * and the median time on it. `paged` lists `PAGES_PAGE` at a time.
 */
function PageRows({ pages, paged = false }: { pages: InsightsPages; paged?: boolean }) {
  const [limit, setLimit] = useState(PAGES_PAGE);
  const all = pages.reach.map((reach, i) => ({ page: i + 1, reach, ms: pages.medianMs[i] ?? 0 }));
  const shown = paged ? all.slice(0, limit) : all;
  return (
    <>
      <div aria-hidden className={cn("mb-1 flex items-center gap-3 text-[11.5px]", MUTED)}>
        <span className="w-14 shrink-0">Page</span>
        <span className="min-w-0 flex-1">Reached</span>
        <span className="w-11 shrink-0 text-right">Time</span>
      </div>
      <ul className="flex flex-col" aria-label="Pages">
        {shown.map(({ page, reach, ms }) => (
          <li key={page} className="flex items-center gap-3 py-1.5">
            <span className={cn("w-14 shrink-0 text-[13px] tabular-nums", STRONG)}>Page {page}</span>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div className={cn(BAR_TRACK, "min-w-0 flex-1")} aria-hidden>
                <div className={BAR_FILL} style={{ width: `${Math.round(reach)}%` }} />
              </div>
              <span className={cn("w-9 shrink-0 text-right text-xs tabular-nums", MUTED)}>
                <span className="sr-only">reached by </span>
                {Math.round(reach)}%
              </span>
            </div>
            <span className={cn("w-11 shrink-0 text-right text-xs tabular-nums", MUTED)}>
              <span className="sr-only">, median time </span>
              {formatWatched(ms)}
            </span>
          </li>
        ))}
      </ul>
      {shown.length < all.length && (
        <div className="mt-2 flex items-center justify-between gap-3">
          <button type="button" className={TEXT_LINK} onClick={() => setLimit((n) => n + PAGES_PAGE)}>
            Show more pages
          </button>
          <span className={cn("text-xs tabular-nums", MUTED)}>
            {shown.length} of {all.length}
          </span>
        </div>
      )}
    </>
  );
}

/**
 * The panel's one empty block: an icon, a line and a sentence on a quiet
 * card. `compact` is the one-line form a tab uses inside a busier panel.
 */
function EmptyBlock({
  icon,
  title,
  body,
  action,
  compact = false,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cn("flex items-start gap-3", compact ? "px-3 py-2.5" : "p-3.5", CARD)}>
      <span
        aria-hidden
        className={cn(
          "flex shrink-0 items-center justify-center bg-primary-50/10 text-primary-50 dark:bg-primary-50/20 dark:text-primary-brand-dark",
          compact ? "size-7 rounded-[8px]" : "size-9 rounded-[10px]",
        )}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <p className={cn("text-[13.5px] font-semibold leading-5", STRONG)}>{title}</p>
        <p className={cn("mt-0.5 text-xs leading-[1.45]", MUTED)}>{body}</p>
        {action}
      </div>
    </div>
  );
}

/**
 * The locked part of the panel: what it holds is drawn blurred, hidden from
 * assistive tech and unreachable by keyboard or pointer, under one prompt,
 * with a "Sample data" label in its corner so the made-up numbers are never
 * read as the link's. Both sit in one grid cell, so the box is as tall as
 * the taller of the two.
 */
function Locked({
  children,
  title,
  body,
  onUpgrade,
}: {
  children: ReactNode;
  title: string;
  body: string;
  onUpgrade: () => void;
}) {
  const router = useRouter();
  return (
    <div
      data-testid="insights-locked"
      className={cn("relative grid overflow-hidden rounded-[12px] border bg-white dark:bg-[#1c1c1c]", HAIRLINE)}
    >
      <div aria-hidden="true" inert className="pointer-events-none col-start-1 row-start-1 select-none opacity-60 blur-[5px]">
        {children}
      </div>
      <div
        className={cn(
          "col-start-1 row-start-1 flex items-center justify-center p-4",
          "bg-gradient-to-b from-white/30 via-white/85 to-white dark:from-[#1c1c1c]/30 dark:via-[#1c1c1c]/85 dark:to-[#1c1c1c]",
        )}
      >
        <span
          data-testid="insights-sample-label"
          className="absolute left-3 top-3 inline-flex h-5 items-center rounded-full border border-grey-80 bg-white px-2 text-[11px] font-medium text-grey-30 dark:border-[#494949] dark:bg-[#262626] dark:text-grey-dark-700"
        >
          {SAMPLE_LABEL}
        </span>
        <div className="flex max-w-[290px] flex-col items-center gap-2 text-center">
          <span
            aria-hidden
            className="mb-1 flex size-[38px] items-center justify-center rounded-[11px] bg-primary-50/10 text-primary-50 dark:bg-primary-50/20 dark:text-primary-brand-dark"
          >
            <BarChart3 className="size-[18px]" />
          </span>
          <p className={cn("text-[14px] font-semibold", STRONG)}>{title}</p>
          <p className="text-[12.5px] leading-5 text-grey-30 dark:text-grey-dark-700">{body}</p>
          <div className="mt-1 flex flex-wrap justify-center gap-2">
            <Button
              variant="primary"
              size="sm"
              className="gap-1.5"
              onClick={() => {
                onUpgrade();
                router.push(BILLING_ROUTE);
              }}
            >
              <Sparkles className="size-3.5" aria-hidden />
              {UPGRADE_PLAN}
            </Button>
            <Button
              variant="defaultStable"
              size="sm"
              onClick={() => void openUrl(PRICING_URL).catch(() => toast.error("Couldn't open the plans page."))}
            >
              {COMPARE_PLANS}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Viewer rows; `paged` lists `VIEWERS_PAGE` at a time behind "Show more
 * viewers". Only a recording's rows say how much each viewer watched.
 */
function ViewerRows({ viewers, video, paged = false }: { viewers: InsightsViewer[]; video: boolean; paged?: boolean }) {
  const [limit, setLimit] = useState(VIEWERS_PAGE);
  const shown = paged ? viewers.slice(0, limit) : viewers;
  return (
    <>
      <ul className={cn("flex flex-col divide-y", DIVIDE)} aria-label="Viewers">
        {shown.map((v) => (
          <ViewerRow key={v.viewerId} viewer={v} video={video} />
        ))}
      </ul>
      {shown.length < viewers.length && (
        <div className="mt-2 flex items-center justify-between gap-3">
          <button type="button" className={TEXT_LINK} onClick={() => setLimit((n) => n + VIEWERS_PAGE)}>
            Show more viewers
          </button>
          <span className={cn("text-xs tabular-nums", MUTED)}>
            {shown.length} of {viewers.length}
          </span>
        </div>
      )}
    </>
  );
}

/**
 * One viewer, most recent first: their avatar, name and when they last
 * looked, and for a recording how much of it they watched. A viewer who
 * confirmed an email on a link that asks for one is named by it when they
 * chose no name; with a name, the email goes under it. No mark says it is
 * verified, as on the console: Rust drops every email that fails the
 * server's check, so an email on screen is always a proven one.
 */
function ViewerRow({ viewer: v, video }: { viewer: InsightsViewer; video: boolean }) {
  const watched = formatWatched(v.watchedMs);
  const email = v.email ?? null;
  const shownName = v.name ?? email;
  const emailLine = v.name !== null && email !== null;
  return (
    <li className="flex items-center gap-3 py-3">
      <InsightsAvatar name={shownName} size="md" />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-1.5">
          <PersonName name={shownName} className="text-[13px]" />
          {v.visits > 1 && <span className={cn("shrink-0 whitespace-nowrap text-xs", MUTED)}>{v.visits} visits</span>}
        </p>
        {emailLine && (
          <p className={cn("mt-px block min-w-0 overflow-hidden text-xs", MUTED)}>
            <MiddleTruncate text={email} kind="email" />
          </p>
        )}
        {v.lastViewedAt && <p className={cn("mt-px text-xs", MUTED)}>{formatAgo(v.lastViewedAt)}</p>}
      </div>
      {/* A document's viewer: how many of its pages they saw. */}
      {!video && v.pagesSeen != null && v.pageCount != null && (
        <p className={cn("shrink-0 whitespace-nowrap text-xs tabular-nums", MUTED)}>
          {pagesSeenLabel(v.pagesSeen, v.pageCount)}
        </p>
      )}
      {video && v.completion !== null && (
        <>
          <div className={cn(BAR_TRACK, "w-[72px] shrink-0")} aria-hidden>
            <div className={BAR_FILL} style={{ width: formatPercent(v.completion) }} />
          </div>
          <p className={cn("w-9 shrink-0 text-right text-xs tabular-nums", MUTED)} title={`Watched ${watched}`}>
            <span className="sr-only">Watched {watched}, </span>
            {formatPercent(v.completion)}
            <span className="sr-only"> of the recording</span>
          </p>
        </>
      )}
    </li>
  );
}

/**
 * The Reactions tab: a bar per emoji, most first. Shown whatever the
 * Reactions switch says (it hides the bar from viewers, not the totals from
 * the owner) and on every plan, since they are not a locked insight.
 */
function ReactionsTab({
  reactions,
  offLine,
  onTurnOn,
}: {
  reactions: UseQueryResult<ShareReactions>;
  offLine: string | null;
  onTurnOn: (from: HTMLElement) => void;
}) {
  const online = useIsOnline();
  const sorted = useMemo(() => sortedReactions(reactions.data), [reactions.data]);
  const max = sorted[0]?.count ?? 0;
  return (
    <div>
      {offLine && <SwitchOffNotice line={offLine} onTurnOn={onTurnOn} />}
      {reactions.isPending ? (
        <div className={cn(SKELETON, "h-8")} />
      ) : reactions.isError ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className={cn("text-sm", MUTED)}>{loadErrorLine("reactions", reactions.error, online)}</p>
          <Button variant="defaultStable" size="sm" onClick={() => void reactions.refetch()}>
            Try again
          </Button>
        </div>
      ) : sorted.length === 0 ? (
        <EmptyLine icon={<SmilePlus />} text="No reactions yet" />
      ) : (
        <ul className="flex flex-col gap-[7px]" aria-label="Reaction totals">
          {sorted.map(({ emoji, count }) => (
            <li key={emoji} className="grid grid-cols-[22px_minmax(0,1fr)_28px] items-center gap-2.5">
              <span className="text-base leading-none">{emoji}</span>
              <span aria-hidden className="h-2 overflow-hidden rounded-[4px] bg-grey-90 dark:bg-[#333]">
                <span
                  className="block h-full rounded-[4px] bg-primary-50 dark:bg-primary-brand-dark"
                  style={{ width: max > 0 ? `${(count / max) * 100}%` : 0 }}
                />
              </span>
              <span className="text-right text-[12.5px] font-medium tabular-nums text-grey-30 dark:text-grey-dark-700">
                {count}
                <span className="sr-only">{count === 1 ? " reaction" : " reactions"}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
