"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  BarChart3,
  Eye,
  EyeOff,
  File as FileIcon,
  ImageIcon,
  Link2,
  MessageSquare,
  Settings,
  Sparkles,
  Video,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import MiddleTruncate from "@/components/ui/MiddleTruncate";
import { SidePanel } from "@/components/ui/SidePanel";
import TabList from "@/components/ui/tabs/TabList";
import TabPanel from "@/components/ui/tabs/TabPanel";
import { cn } from "@/lib/utils";
import { BILLING_ROUTE } from "@/app/lib/routes";
import {
  insightsSheetAtom,
  shareCommentsEnabledAtom,
  type InsightsSheetTarget,
} from "@/app/lib/global-atoms/sharesAtoms";
import { findCachedShare, SHARES_QUERY_KEY } from "@/app/lib/hooks/useSharedFiles";
import { createCaptureLink } from "@/app/lib/tauri/shares";
import { newestShare, useCaptureShares } from "@/components/page-sections/drive/useCaptureInsightsItem";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { getFileUrl } from "@/app/lib/utils/fileUrlResolver";
import {
  getShareInsights,
  getShareReactions,
  listShareComments,
  type InsightsViewer,
  type ReactionCount,
  type ShareComment,
  type ShareInsights,
  type ShareReactions,
} from "@/app/lib/tauri/shareInsights";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { CommentsTab, PersonName, useCommentModeration } from "./CommentThreads";
import { InsightsAvatar } from "./InsightsAvatar";
import { LinkSettingsPopover, SETTINGS_TRIGGER_ATTR, StatusPills, SwitchOffNotice, useLinkSwitches } from "./LinkSettingsPopover";
import { commentsQueryKey, insightsQueryKey, linkSettingsQueryKey, reactionsQueryKey } from "./queryKeys";
import { RetentionChart } from "./RetentionChart";
import {
  COMPARE_PLANS,
  PRICING_URL,
  SAMPLE_AVERAGE_WATCH_MS,
  SAMPLE_COMPLETION,
  SAMPLE_RETENTION,
  SAMPLE_UNIQUE_VIEWERS,
  SAMPLE_VIEWERS,
  SAMPLE_LABEL,
  SAMPLE_STILL_VIEWERS,
  SAMPLE_VIEWS,
  SUMMARY_REACTIONS,
  UPGRADE_PLAN,
  VIEWERS_PAGE,
  averageWatchMs,
  biggestDrop,
  countLabel,
  defaultInsightsTab,
  emptyInsightsCopy,
  estimateDurationMs,
  formatAgo,
  formatMomentAt,
  formatPercent,
  formatWatched,
  headerLine,
  lockCopy,
  switchOffLine,
  tabLabel,
  type InsightsTab,
} from "./insightsView";
import { BAR_FILL, BAR_TRACK, CARD, DIVIDE, HAIRLINE, ICON_BUTTON, MUTED, SKELETON, STRONG, TEXT_LINK } from "./panelStyles";

/**
 * Wider than File Details' 305: like Manage access, this panel holds lists,
 * a chart and a row of numbers.
 */
export const INSIGHTS_PANEL_WIDTH_PX = 360;

export { insightsQueryKey, commentsQueryKey, reactionsQueryKey, linkSettingsQueryKey };

const VIDEO_NAME = /\.(mp4|mov|m4v|webm|mkv)$/i;
const IMAGE_NAME = /\.(png|jpe?g|gif|webp|bmp|heic)$/i;

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
          <CaptureInsightsPanel
            target={target}
            onClose={onClose}
            onLinkCreated={(shareToken) => {
              created.current = shareToken;
              setTarget((prev) => (prev ? { ...prev, shareToken } : prev));
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
  onLinkCreated: (shareToken: string) => void;
}) {
  const { sharesFor, isLoading } = useCaptureShares();
  const capture = target.capture;
  const share = capture ? newestShare(sharesFor(capture.label, capture.relativePath, target.file?.size)) : null;
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

/** The no-link step's words. */
export const NO_LINK_TITLE = "No link yet";
export const CREATE_LINK = "Create link";
export function noLinkBody(commentsEnabled: boolean): string {
  return commentsEnabled
    ? "Insights start once this capture has a share link. Create one to see who views it, and their comments and reactions, here."
    : "Insights start once this capture has a share link. Create one to see who views it here.";
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
  onLinkCreated: (shareToken: string) => void;
}) {
  const commentsEnabled = useAtomValue(shareCommentsEnabledAtom);
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const capture = target.capture;

  const create = async () => {
    if (!capture || creating) return;
    setCreating(true);
    setError(null);
    try {
      const link = await createCaptureLink(capture.label, capture.relativePath, capture.fileId);
      // The row's link badge and Insights button, and Shared Links, read the
      // listing: ask it again so they show the new link.
      void queryClient.invalidateQueries({ queryKey: [SHARES_QUERY_KEY] });
      toast.success(link.copied ? "Link created and copied" : "Link created");
      onLinkCreated(link.shareToken);
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
        subtitle={listingLoading ? null : NO_LINK_TITLE}
        onClose={onClose}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-4">
        {listingLoading ? (
          <InsightsSkeleton />
        ) : (
          <EmptyBlock
            icon={<Link2 className="size-[18px]" />}
            title={NO_LINK_TITLE}
            body={noLinkBody(commentsEnabled)}
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

/** The no-link panel's header: the capture, its name, a line under it, Close. */
function PanelHeader({
  file,
  fileName,
  subtitle,
  onClose,
}: {
  file?: FormattedUserFile;
  fileName: string;
  subtitle: string | null;
  onClose: () => void;
}) {
  return (
    <header className={cn("shrink-0 border-b px-4 pb-3 pt-4", HAIRLINE)}>
      <div className="flex items-center gap-2.5">
        <HeaderThumb file={file} fileName={fileName} onDuration={() => undefined} />
        <div className="min-w-0 flex-1">
          <h2
            tabIndex={-1}
            data-panel-autofocus
            title={fileName}
            className={cn("text-[15px] font-semibold leading-5 outline-none", STRONG)}
          >
            <span className="sr-only">Insights for </span>
            <MiddleTruncate text={fileName} kind="name" title={null} />
          </h2>
          {subtitle ? <p className={cn("mt-0.5 truncate text-xs", MUTED)}>{subtitle}</p> : null}
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className={ICON_BUTTON}>
          <X className="size-4" />
        </button>
      </div>
    </header>
  );
}

/** The recording's length: the capture's own, else what the viewers pin it to. */
function useDurationMs(shareToken: string, mediaMs: number | null): number | null {
  const commentsEnabled = useAtomValue(shareCommentsEnabledAtom);
  const insights = useQuery({
    queryKey: insightsQueryKey(shareToken),
    queryFn: () => getShareInsights(shareToken),
    retry: false,
  });
  const comments = useQuery({
    queryKey: commentsQueryKey(shareToken),
    queryFn: () => listShareComments(shareToken),
    retry: false,
    enabled: commentsEnabled,
  });
  if (mediaMs !== null) return mediaMs;
  const viewers = insights.data?.viewers;
  if (!viewers || viewers.state !== "shown") return null;
  return estimateDurationMs(viewers.value, comments.data?.comments ?? []);
}

/**
 * A frame of the capture when it is on this device (a recording also gives
 * the panel its length), otherwise a tile with the file's kind.
 */
function HeaderThumb({
  file,
  fileName,
  onDuration,
}: {
  file?: FormattedUserFile;
  fileName: string;
  onDuration: (ms: number) => void;
}) {
  const [failed, setFailed] = useState(false);
  const local = file ? getFileUrl(file) : null;
  const url = local?.isLocal && local.url && !failed ? local.url : null;
  const isVideo = VIDEO_NAME.test(fileName);
  const isImage = IMAGE_NAME.test(fileName);
  const Icon = isVideo ? Video : isImage ? ImageIcon : FileIcon;
  return (
    <span
      aria-hidden
      className={cn(
        "relative flex h-9 w-12 shrink-0 items-center justify-center overflow-hidden rounded-[8px]",
        url ? "bg-[#000]" : "bg-primary-50/10 text-primary-50 dark:bg-primary-50/15 dark:text-primary-brand-dark",
      )}
    >
      {url && isVideo ? (
        <video
          src={`${url}#t=0.1`}
          muted
          playsInline
          preload="metadata"
          tabIndex={-1}
          className="size-full object-cover"
          onLoadedMetadata={(e) => {
            const seconds = e.currentTarget.duration;
            if (Number.isFinite(seconds) && seconds > 0) onDuration(Math.round(seconds * 1000));
          }}
          onError={() => setFailed(true)}
        />
      ) : url && isImage ? (
        <img src={url} alt="" className="size-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <Icon className="size-[18px]" />
      )}
    </span>
  );
}

function anyLocked(insights: ShareInsights): boolean {
  return (
    insights.completion.state === "locked" || insights.retention.state === "locked" || insights.viewers.state === "locked"
  );
}

/**
 * The panel, top to bottom: a fixed header (the capture, its name, "Shared …
 * · link on", the Link settings gear, Close) with the link's switches as
 * pills under it, a fixed summary of the numbers, fixed tabs (Comments,
 * Viewers, Reactions), and one scrolling body for the selected tab. With
 * twenty comments only the body scrolls, so the switches and the counts stay
 * in view.
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

  // The recording's length, read off the capture itself when it is on this
  // device; otherwise worked out from the viewers (`estimateDurationMs`).
  const [mediaMs, setMediaMs] = useState<number | null>(null);
  const durationMs = useDurationMs(shareToken, mediaMs);
  const queryClient = useQueryClient();
  const summary = useMemo(() => findCachedShare(queryClient, shareToken), [queryClient, shareToken]);
  const subtitle = headerLine({
    sharedAt: summary?.createdAt ?? null,
    durationMs,
    expiresAt: summary ? summary.expiresAt : undefined,
  });

  const insights = useQuery({
    queryKey: insightsQueryKey(shareToken),
    queryFn: () => getShareInsights(shareToken),
    retry: false,
  });
  const switches = useLinkSwitches(shareToken);
  const reactions = useQuery({
    queryKey: reactionsQueryKey(shareToken),
    queryFn: () => getShareReactions(shareToken),
    retry: false,
    enabled: commentsEnabled,
  });
  const moderation = useCommentModeration(shareToken, commentsEnabled);
  const settings = switches.current.data ?? null;
  const notCounting = settings?.offered.insights === true && !settings.on.insights;

  const commentList = moderation.comments.data?.comments ?? [];
  const commentCount = commentsEnabled ? commentList.length : 0;
  const plan = insights.data?.plan ?? null;

  // Nothing has happened on the link yet: no views, comments or reactions.
  // Then the panel is one short block, instead of a zero, empty tabs and an
  // empty state per tab.
  const locked = insights.data !== undefined && anyLocked(insights.data);
  const noViews = insights.isSuccess && !locked && insights.data.totalViews === 0;
  const engagementSettled = !commentsEnabled || (!moderation.comments.isPending && !reactions.isPending);
  const noEngagement =
    !commentsEnabled ||
    (moderation.comments.isSuccess &&
      commentList.length === 0 &&
      !moderation.comments.data.unreadable &&
      reactions.isSuccess &&
      reactions.data.total === 0);
  const quiet = noViews && engagementSettled && noEngagement;
  // Held on the skeleton until comments and reactions answer, so the quiet
  // block never flashes in and then gives way to the tabs.
  const loading = insights.isPending || (noViews && !engagementSettled);

  const viewers = insights.data?.viewers.state === "shown" ? insights.data.viewers.value : null;
  const tabs: Array<{ tabKey: InsightsTab; tabName: string }> = [];
  if (commentsEnabled) {
    tabs.push({
      tabKey: "comments",
      tabName: tabLabel("Comments", moderation.comments.isSuccess ? commentList.length : null),
    });
  }
  if (insights.isSuccess) tabs.push({ tabKey: "viewers", tabName: tabLabel("Viewers", viewers ? viewers.length : null) });
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
      <header className={cn("shrink-0 border-b px-4 pb-3 pt-4", HAIRLINE)}>
        <div ref={titleRowRef} className="flex items-center gap-2.5">
          <HeaderThumb file={file} fileName={fileName} onDuration={setMediaMs} />
          <div className="min-w-0 flex-1">
            <h2
              id={titleId}
              tabIndex={-1}
              data-panel-autofocus
              title={fileName}
              className={cn("text-[15px] font-semibold leading-5 outline-none", STRONG)}
            >
              <span className="sr-only">Insights for </span>
              <MiddleTruncate text={fileName} kind="name" title={null} />
            </h2>
            {subtitle ? <p className={cn("mt-0.5 truncate text-xs", MUTED)}>{subtitle}</p> : null}
          </div>
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
          <button type="button" aria-label="Close" onClick={onClose} className={ICON_BUTTON}>
            <X className="size-4" />
          </button>
        </div>
        {settings && (
          <div className="mt-2.5 empty:hidden">
            <StatusPills settings={settings} popoverId={popoverId} open={settingsOpen} onOpen={openSettings} />
          </div>
        )}
      </header>

      {settingsOpen && (
        <LinkSettingsPopover
          id={popoverId}
          switches={switches}
          top={settingsTop}
          opener={settingsOpener}
          onClose={() => setSettingsOpen(false)}
          onLeave={onClose}
        />
      )}

      {loading ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-4">
          <InsightsSkeleton />
        </div>
      ) : quiet ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-4">
          <EmptyBlock
            icon={notCounting ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
            {...emptyInsightsCopy({ notCounting, commentsEnabled })}
            action={
              notCounting ? (
                <button
                  type="button"
                  {...{ [SETTINGS_TRIGGER_ATTR]: "" }}
                  aria-haspopup="dialog"
                  onClick={(e) => openSettings(e.currentTarget)}
                  className={cn(TEXT_LINK, "mt-1.5")}
                >
                  Turn on
                </button>
              ) : null
            }
          />
        </div>
      ) : (
        <>
          <Summary
            insights={insights}
            notCounting={notCounting}
            viewers={viewers}
            commentCount={commentsEnabled && moderation.comments.isSuccess ? commentList.length : null}
            reactions={commentsEnabled && reactions.isSuccess ? reactions.data : null}
          />
          {tabs.length > 1 && tab && (
            <div className={cn("shrink-0 border-b px-4 py-2", HAIRLINE)}>
              <TabList
                idBase={tabsId}
                ariaLabel="Insights"
                tabs={tabs}
                activeTab={tab}
                onTabChange={(key) => goToTab(key as InsightsTab)}
                className="flex w-full"
                width="min-w-0 flex-1"
                height="h-[30px]"
                tabItemPaddingX="px-1.5"
                textClassName="text-[12.5px] font-medium"
                showTooltip={false}
              />
            </div>
          )}
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-3" data-testid="insights-body">
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
 * The numbers that stay in view above the tabs: views and people, a
 * recording's completion and average watch, and how many comments and
 * reactions the link has. What the free plan does not include is not drawn
 * here; the Viewers tab carries its lock.
 */
function Summary({
  insights,
  notCounting,
  viewers,
  commentCount,
  reactions,
}: {
  insights: UseQueryResult<ShareInsights>;
  notCounting: boolean;
  viewers: InsightsViewer[] | null;
  /** `null` on a server without comments, or before they load. */
  commentCount: number | null;
  reactions: ShareReactions | null;
}) {
  if (insights.isError) {
    return (
      <section aria-label="Summary" className={cn("shrink-0 border-b px-4 py-3", HAIRLINE)}>
        <div role="alert" className={cn("flex flex-col items-start gap-2 p-3", CARD)}>
          <p className="text-sm text-grey-20 dark:text-grey-dark-800">
            Couldn&apos;t load insights. {errorMessage(insights.error)}
          </p>
          <Button variant="defaultStable" size="sm" onClick={() => void insights.refetch()}>
            Try again
          </Button>
        </div>
        <EngagementChips commentCount={commentCount} reactions={reactions} className="mt-2.5" />
      </section>
    );
  }
  const data = insights.data!;
  const locked = anyLocked(data);
  const viewerRows = viewers ?? [];
  const completion = data.completion.state === "shown" ? data.completion.value : null;
  const average = locked ? null : averageWatchMs(viewerRows, data.totalViews);
  const people = countLabel(data.uniqueViewers, "person viewed", "people viewed");

  let top: ReactNode;
  if (locked && notCounting) {
    // A free link that is not counting views has no real numbers at all.
    top = <QuietLine icon={<EyeOff className="size-3.5" />} text="Not counting views" />;
  } else if (!locked && data.totalViews === 0) {
    top = <QuietLine icon={<Eye className="size-3.5" />} text="No views yet" />;
  } else {
    top = (
      <Hero
        views={data.totalViews}
        aside={
          locked || data.uniqueViewers > 0 ? (
            <>
              {viewerRows.length > 0 && (
                <span className="flex" aria-hidden>
                  {viewerRows.slice(0, 4).map((v, i) => (
                    <InsightsAvatar key={v.viewerId} name={v.name} size="sm" ring className={i > 0 ? "-ml-[7px]" : ""} />
                  ))}
                </span>
              )}
              <span className="whitespace-nowrap">{people}</span>
            </>
          ) : null
        }
      />
    );
  }

  const stats = completion !== null || average !== null;
  return (
    <section aria-label="Summary" className={cn("shrink-0 border-b px-4 py-3", HAIRLINE)}>
      {top}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 empty:hidden">
        {stats && (
          <p className={cn("flex flex-wrap items-baseline gap-x-2.5 text-xs", MUTED)}>
            {completion !== null && (
              <span>
                <span className={cn("font-semibold tabular-nums", STRONG)}>{formatPercent(completion)}</span> completion
              </span>
            )}
            {average !== null && (
              <span>
                <span className={cn("font-semibold tabular-nums", STRONG)}>{formatWatched(average)}</span> avg watch
              </span>
            )}
          </p>
        )}
        <EngagementChips commentCount={commentCount} reactions={reactions} />
      </div>
    </section>
  );
}

function QuietLine({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <p className={cn("flex items-center gap-1.5 text-[13.5px] font-medium", MUTED)}>
      <span aria-hidden>{icon}</span>
      {text}
    </p>
  );
}

const CHIP = "inline-flex h-6 items-center gap-1 rounded-full bg-[#0000000A] px-2 text-[12px] dark:bg-white/[0.06]";

/** Comments and reactions as small chips: the speech bubble and each emoji with its count. */
function EngagementChips({
  commentCount,
  reactions,
  className,
}: {
  commentCount: number | null;
  reactions: ShareReactions | null;
  className?: string;
}) {
  const sorted = sortedReactions(reactions);
  const shown = sorted.slice(0, SUMMARY_REACTIONS);
  const rest = sorted.slice(SUMMARY_REACTIONS).reduce((n, r) => n + r.count, 0);
  if (!commentCount && shown.length === 0) return null;
  return (
    <ul className={cn("flex flex-wrap items-center gap-1", className)} aria-label="Comments and reactions">
      {commentCount ? (
        <li className={cn(CHIP, MUTED)}>
          <MessageSquare aria-hidden className="size-3" strokeWidth={2.25} />
          <span className={cn("font-semibold tabular-nums", STRONG)}>{commentCount}</span>
          <span className="sr-only">{commentCount === 1 ? " comment" : " comments"}</span>
        </li>
      ) : null}
      {shown.map(({ emoji, count }) => (
        <li key={emoji} className={cn(CHIP, MUTED)}>
          <span className="text-[13px] leading-none">{emoji}</span>
          <span className={cn("font-semibold tabular-nums", STRONG)}>{count}</span>
        </li>
      ))}
      {rest > 0 && (
        <li className={cn(CHIP, MUTED)}>
          +{rest}
          <span className="sr-only"> more reactions</span>
        </li>
      )}
    </ul>
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
          <ViewerRows viewers={video ? SAMPLE_VIEWERS : SAMPLE_STILL_VIEWERS} />
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
        <EmptyBlock
          compact
          icon={<Eye className="size-4" />}
          title="No views yet"
          body="Views show up here once someone opens the link."
        />
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
      <Section title="Viewers" aside="Most recent first">
        {viewerRows.length === 0 ? (
          <p className={cn("text-sm", MUTED)}>No viewers listed yet.</p>
        ) : (
          <ViewerRows viewers={viewerRows} paged />
        )}
      </Section>
    </div>
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

/** Viewer rows; `paged` lists `VIEWERS_PAGE` at a time behind "Show more viewers". */
function ViewerRows({ viewers, paged = false }: { viewers: InsightsViewer[]; paged?: boolean }) {
  const [limit, setLimit] = useState(VIEWERS_PAGE);
  const shown = paged ? viewers.slice(0, limit) : viewers;
  return (
    <>
      <ul className={cn("flex flex-col divide-y", DIVIDE)} aria-label="Viewers">
        {shown.map((v) => (
          <ViewerRow key={v.viewerId} viewer={v} />
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

function ViewerRow({ viewer: v }: { viewer: InsightsViewer }) {
  const watched = formatWatched(v.watchedMs);
  return (
    <li className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2 py-2">
      <InsightsAvatar name={v.name} size="row" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="flex min-w-0 items-baseline gap-1.5">
          <PersonName name={v.name} className="text-[13px]" />
          {v.visits > 1 && <span className={cn("shrink-0 whitespace-nowrap text-xs", MUTED)}>{v.visits} visits</span>}
        </p>
        {v.completion !== null && (
          <div className={BAR_TRACK} aria-hidden>
            <div className={BAR_FILL} style={{ width: formatPercent(v.completion) }} />
          </div>
        )}
      </div>
      <div className={cn("text-right text-xs leading-[1.35]", MUTED)}>
        {v.completion !== null && (
          <p className={cn("text-[12.5px] font-semibold tabular-nums", STRONG)} title={`Watched ${watched}`}>
            <span className="sr-only">Watched </span>
            {watched}
            <span className="sr-only">, {formatPercent(v.completion)} of the recording</span>
          </p>
        )}
        {v.lastViewedAt && <p>{formatAgo(v.lastViewedAt)}</p>}
      </div>
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
  const sorted = useMemo(() => sortedReactions(reactions.data), [reactions.data]);
  const max = sorted[0]?.count ?? 0;
  return (
    <div>
      {offLine && <SwitchOffNotice line={offLine} onTurnOn={onTurnOn} />}
      {reactions.isPending ? (
        <div className={cn(SKELETON, "h-8")} />
      ) : reactions.isError ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className={cn("text-sm", MUTED)}>Couldn&apos;t load reactions. {errorMessage(reactions.error)}</p>
          <Button variant="defaultStable" size="sm" onClick={() => void reactions.refetch()}>
            Try again
          </Button>
        </div>
      ) : sorted.length === 0 ? (
        <p className={cn("text-sm", MUTED)}>No reactions yet.</p>
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
