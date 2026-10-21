"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Ban,
  BarChart3,
  Eye,
  File as FileIcon,
  ImageIcon,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Sparkles,
  Trash2,
  Video,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { FramedDialog } from "@/components/ui/FramedDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import TabList from "@/components/ui/tabs/TabList";
import TabPanel from "@/components/ui/tabs/TabPanel";
import { cn } from "@/lib/utils";
import { BILLING_ROUTE } from "@/app/lib/routes";
import {
  insightsSheetAtom,
  shareCommentRepliesEnabledAtom,
  shareCommentsEnabledAtom,
} from "@/app/lib/global-atoms/sharesAtoms";
import { findCachedShare } from "@/app/lib/hooks/useSharedFiles";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { getFileUrl } from "@/app/lib/utils/fileUrlResolver";
import {
  blockShareCommenter,
  deleteShareComment,
  getLinkSettings,
  getShareInsights,
  getShareReactions,
  listShareComments,
  setLinkSettings,
  unblockShareCommenter,
  type InsightsViewer,
  type LinkSettings,
  type LinkSettingsDefault,
  type ShareComment,
  type ShareInsights,
} from "@/app/lib/tauri/shareInsights";
import LinkEngagementSwitches from "@/components/page-sections/drive/LinkEngagementSwitches";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { InsightsAvatar } from "./InsightsAvatar";
import { commentsQueryKey, insightsQueryKey, linkSettingsQueryKey, reactionsQueryKey } from "./queryKeys";
import { RetentionChart } from "./RetentionChart";
import {
  BLOCK_EXPLAINER,
  COMPARE_PLANS,
  DEFINITIONS,
  DELETE_EXPLAINER,
  LOCK_BODY,
  LOCK_BODY_NOT_COUNTING,
  LOCK_TITLE,
  OVERVIEW_COMMENTS,
  OVERVIEW_VIEWERS,
  PRICING_URL,
  SAMPLE_AVERAGE_WATCH_MS,
  SAMPLE_COMPLETION,
  SAMPLE_RETENTION,
  SAMPLE_UNIQUE_VIEWERS,
  SAMPLE_VIEWERS,
  SAMPLE_VIEWS,
  UPGRADE_PLAN,
  averageWatchMs,
  biggestDrop,
  countLabel,
  estimateDurationMs,
  formatAgo,
  formatMomentAt,
  formatPercent,
  formatWatched,
  headerLine,
  usesTabs,
  viewerName,
} from "./insightsView";

// The sheet's tokens: the app's own greys and brand blue, one border colour
// per theme, so every hairline in the sheet is the same.
const MUTED = "text-grey-50 dark:text-grey-dark-600";
const STRONG = "text-grey-10 dark:text-white";
const HAIRLINE = "border-grey-80 dark:border-[#494949]";
const DIVIDE = "divide-grey-80 dark:divide-[#333]";
const SKELETON = "animate-pulse rounded bg-grey-light-200 motion-reduce:animate-none dark:bg-black-500";
const BAR_TRACK = "h-1 overflow-hidden rounded-full bg-grey-90 dark:bg-[#333]";
const BAR_FILL = "h-full rounded-full bg-primary-50 dark:bg-primary-brand-dark";
const TEXT_LINK = cn(
  "inline-flex items-center gap-1 rounded text-[12.5px] font-medium text-primary-50 hover:underline",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-50/40 dark:text-primary-brand-dark",
);

export { insightsQueryKey, commentsQueryKey, reactionsQueryKey, linkSettingsQueryKey };

const VIDEO_NAME = /\.(mp4|mov|m4v|webm|mkv)$/i;
const IMAGE_NAME = /\.(png|jpe?g|gif|webp|bmp|heic)$/i;

/**
 * The owner's Insights for one link, opened from Shared Links, a row on the
 * Captures page or the capture card (`insightsSheetAtom`). Mounted once in
 * the pages layout. Every number, and whether it is locked, comes from Rust.
 */
export default function ShareInsightsSheet() {
  const [target, setTarget] = useAtom(insightsSheetAtom);
  if (!target) return null;
  return (
    <InsightsSheetFor
      key={target.shareToken}
      shareToken={target.shareToken}
      fileName={target.fileName}
      file={target.file}
      onClose={() => setTarget(null)}
    />
  );
}

function InsightsSheetFor({
  shareToken,
  fileName,
  file,
  onClose,
}: {
  shareToken: string;
  fileName: string;
  file?: FormattedUserFile;
  onClose: () => void;
}) {
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
  return (
    <FramedDialog
      open
      onClose={onClose}
      title={<span title={fileName}>{fileName}</span>}
      titleClassName="text-[15px] leading-6"
      headerLayout="leading"
      leadingVisual={<HeaderThumb file={file} fileName={fileName} onDuration={setMediaMs} />}
      subtitle={subtitle ? <span className="block truncate">{subtitle}</span> : undefined}
      maxWidth="max-w-[560px]"
    >
      <InsightsBody shareToken={shareToken} onLeave={onClose} durationMs={durationMs} />
    </FramedDialog>
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
 * the sheet its length), otherwise a tile with the file's kind.
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
        "relative flex h-9 w-16 shrink-0 items-center justify-center overflow-hidden rounded-[7px] border",
        HAIRLINE,
        "bg-grey-90 text-grey-50 dark:bg-[#2a2a2a] dark:text-grey-dark-600",
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
        <Icon className="size-4" />
      )}
    </span>
  );
}

type TabKey = "overview" | "viewers" | "comments";

export function InsightsBody({
  shareToken,
  onLeave,
  durationMs = null,
}: {
  shareToken: string;
  onLeave: () => void;
  durationMs?: number | null;
}) {
  const commentsEnabled = useAtomValue(shareCommentsEnabledAtom);
  const tabsId = useId();
  const [tab, setTab] = useState<TabKey>("overview");
  const insights = useQuery({
    queryKey: insightsQueryKey(shareToken),
    queryFn: () => getShareInsights(shareToken),
    retry: false,
  });
  // The same query On this link reads: whether this link counts views.
  const switches = useQuery({
    queryKey: linkSettingsQueryKey(shareToken),
    queryFn: () => getLinkSettings(shareToken),
    retry: false,
  });
  const moderation = useCommentModeration(shareToken, commentsEnabled);
  const notCounting = switches.data?.offered.insights === true && !switches.data.on.insights;

  const viewers = insights.data?.viewers.state === "shown" ? insights.data.viewers.value : null;
  const commentList = moderation.comments.data?.comments ?? [];
  const commentCount = commentsEnabled ? commentList.length : 0;
  const tabbed = usesTabs(viewers?.length ?? 0, commentCount);
  const plan = insights.data?.plan ?? null;

  const overview = (
    <div className="flex flex-col gap-6">
      {insights.isPending ? (
        <InsightsSkeleton />
      ) : insights.isError ? (
        <div role="alert" className={cn("flex flex-col items-start gap-2 rounded-[12px] border p-3", HAIRLINE)}>
          <p className="text-sm text-grey-20 dark:text-grey-dark-800">
            Couldn&apos;t load insights. {errorMessage(insights.error)}
          </p>
          <Button variant="defaultStable" size="sm" onClick={() => void insights.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <InsightsNumbers
          insights={insights.data}
          notCounting={notCounting}
          onUpgrade={onLeave}
          durationMs={durationMs}
          comments={commentsEnabled ? commentList : null}
          commentsLoading={commentsEnabled && moderation.comments.isPending}
          onSeeAllViewers={tabbed ? () => setTab("viewers") : null}
        />
      )}
      {commentsEnabled && (
        <CommentsSection
          moderation={moderation}
          plan={plan}
          limit={tabbed ? OVERVIEW_COMMENTS : null}
          onSeeAll={tabbed ? () => setTab("comments") : null}
        />
      )}
      {commentsEnabled && <ReactionsSection shareToken={shareToken} />}
      <OnThisLink shareToken={shareToken} onLeave={onLeave} />
      <HowWeCountViews />
    </div>
  );

  if (!tabbed) return <div className="font-geist">{overview}</div>;

  const tabs = [
    { tabName: "Overview", tabKey: "overview" },
    ...(viewers && viewers.length > 0 ? [{ tabName: `Viewers ${viewers.length}`, tabKey: "viewers" }] : []),
    ...(commentCount > 0 ? [{ tabName: `Comments ${commentCount}`, tabKey: "comments" }] : []),
  ];
  return (
    <div className="flex flex-col gap-4 font-geist">
      <TabList
        idBase={tabsId}
        ariaLabel="Insights"
        tabs={tabs}
        activeTab={tab}
        onTabChange={(key) => setTab(key as TabKey)}
        className="flex w-full"
        width="min-w-0 flex-1"
        height="h-[32px]"
        showTooltip={false}
      />
      <TabPanel idBase={tabsId} tabKey="overview" activeTab={tab}>
        {overview}
      </TabPanel>
      {viewers && viewers.length > 0 && (
        <TabPanel idBase={tabsId} tabKey="viewers" activeTab={tab}>
          <Section title="Viewers" aside="Most recent first">
            <ViewerRows viewers={viewers} />
          </Section>
        </TabPanel>
      )}
      {commentCount > 0 && (
        <TabPanel idBase={tabsId} tabKey="comments" activeTab={tab}>
          <CommentsSection moderation={moderation} plan={plan} limit={null} onSeeAll={null} />
        </TabPanel>
      )}
    </div>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h3 id={id} className={cn("text-[13.5px] font-semibold", STRONG)}>
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
    <div data-testid="insights-loading" className="flex flex-col gap-6" aria-busy="true">
      <div className="flex items-end justify-between">
        <div className={cn(SKELETON, "h-10 w-32")} />
        <div className={cn(SKELETON, "h-8 w-28")} />
      </div>
      <div className={cn(SKELETON, "h-[62px] rounded-[12px]")} />
      <div className={cn(SKELETON, "h-[150px]")} />
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className={cn(SKELETON, "h-9")} />
        ))}
      </div>
    </div>
  );
}

/** "47 views" on the left; who watched on the right. */
function Hero({ views, aside }: { views: number; aside: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3">
      <p className={cn("flex items-baseline gap-1.5", STRONG)}>
        <span className="text-[40px] font-semibold leading-none tracking-[-0.03em] tabular-nums">{views}</span>
        <span className={cn("text-sm font-medium", MUTED)}>{views === 1 ? "view" : "views"}</span>
      </p>
      <div className={cn("flex flex-col items-end gap-1.5 text-right text-xs", MUTED)}>{aside}</div>
    </div>
  );
}

function KpiStrip({ items }: { items: Array<{ label: string; value: ReactNode; muted?: boolean }> }) {
  return (
    <dl
      className={cn("grid overflow-hidden rounded-[12px] border", HAIRLINE)}
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
    >
      {items.map(({ label, value, muted }, i) => (
        <div key={label} className={cn("flex min-w-0 flex-col gap-0.5 px-2.5 py-2.5 sm:px-3", i > 0 && cn("border-l", HAIRLINE))}>
          <dt className={cn("truncate text-[11.5px]", MUTED)}>{label}</dt>
          <dd
            className={cn(
              "truncate font-semibold tabular-nums tracking-[-0.01em]",
              muted ? cn("text-sm font-medium leading-7", MUTED) : cn("text-[19px] leading-7", STRONG),
            )}
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function InsightsNumbers({
  insights,
  notCounting,
  onUpgrade,
  durationMs,
  comments,
  commentsLoading,
  onSeeAllViewers,
}: {
  insights: ShareInsights;
  /** The link's Insights switch is off, so its view counts are not being kept. */
  notCounting: boolean;
  onUpgrade: () => void;
  durationMs: number | null;
  /** The link's comments, or `null` on a server without comments. */
  comments: ShareComment[] | null;
  commentsLoading: boolean;
  /** Opens the Viewers tab; `null` lists every viewer here instead. */
  onSeeAllViewers: (() => void) | null;
}) {
  const { completion, retention, viewers } = insights;
  const anyLocked = completion.state === "locked" || retention.state === "locked" || viewers.state === "locked";

  if (anyLocked) {
    // Everything past the two numbers is drawn from SAMPLE data, blurred,
    // with no real value anywhere in it: Rust sends none for a locked metric.
    // A free link that is not counting views has no real numbers at all, so
    // its two counts are samples under the lock too, rather than a "0" that
    // reads as nobody having opened it.
    return (
      <>
        {!notCounting && (
          <Hero
            views={insights.totalViews}
            aside={
              <>
                <span className={cn("text-xl font-semibold leading-none tabular-nums", STRONG)}>
                  {insights.uniqueViewers}
                </span>
                <span>{insights.uniqueViewers === 1 ? "unique viewer" : "unique viewers"}</span>
              </>
            }
          />
        )}
        <Locked notCounting={notCounting} onUpgrade={onUpgrade}>
          <div className="flex flex-col gap-5 p-4">
            {notCounting && (
              <Hero views={SAMPLE_VIEWS} aside={<span>{SAMPLE_UNIQUE_VIEWERS} people watched</span>} />
            )}
            <KpiStrip
              items={[
                { label: "Completion", value: formatPercent(SAMPLE_COMPLETION) },
                { label: "Average watch", value: formatWatched(SAMPLE_AVERAGE_WATCH_MS) },
                { label: "Comments", value: "5" },
              ]}
            />
            <RetentionChart values={SAMPLE_RETENTION} durationMs={252_000} />
            <ViewerRows viewers={SAMPLE_VIEWERS} />
          </div>
        </Locked>
      </>
    );
  }

  const completionValue = completion.state === "shown" ? completion.value : null;
  const retentionValues = retention.state === "shown" ? retention.value : null;
  const viewerRows = viewers.state === "shown" ? viewers.value : [];
  const average = averageWatchMs(viewerRows, insights.totalViews);
  const drop = retentionValues ? biggestDrop(retentionValues) : null;

  return (
    <>
      <Hero
        views={insights.totalViews}
        aside={
          insights.uniqueViewers > 0 ? (
            <>
              <span className="flex" aria-hidden>
                {viewerRows.slice(0, 5).map((v, i) => (
                  <InsightsAvatar key={v.viewerId} name={v.name} size="sm" ring className={i > 0 ? "-ml-[7px]" : ""} />
                ))}
              </span>
              <span>{countLabel(insights.uniqueViewers, "person watched", "people watched")}</span>
            </>
          ) : null
        }
      />
      <KpiStrip
        items={[
          {
            label: "Completion",
            value: completionValue === null ? "None yet" : formatPercent(completionValue),
            muted: completionValue === null,
          },
          {
            label: "Average watch",
            value: average === null ? "None yet" : formatWatched(average),
            muted: average === null,
          },
          ...(comments !== null
            ? [
                {
                  label: "Comments",
                  value: commentsLoading ? <span className={cn(SKELETON, "inline-block h-5 w-6 align-middle")} /> : comments.length,
                },
              ]
            : []),
        ]}
      />
      {retentionValues && (
        <Section
          title="Where people stopped"
          aside={drop ? `Most left at ${formatMomentAt(drop.at, durationMs)}` : undefined}
        >
          <RetentionChart values={retentionValues} durationMs={durationMs} comments={comments ?? []} />
        </Section>
      )}
      {insights.totalViews === 0 ? (
        <EmptyState
          icon={<Eye className="size-5" />}
          title="No views yet"
          body="No one has opened this link yet. Views show up here once someone does."
        />
      ) : (
        <Section title="Viewers" aside="Most recent first">
          <ViewerRows viewers={viewerRows} limit={OVERVIEW_VIEWERS} onSeeAll={onSeeAllViewers} />
        </Section>
      )}
    </>
  );
}

function EmptyState({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
      <span
        aria-hidden
        className="mb-1 flex size-11 items-center justify-center rounded-[14px] bg-primary-50/10 text-primary-50 dark:bg-primary-50/20 dark:text-primary-brand-dark"
      >
        {icon}
      </span>
      <p className={cn("text-sm font-semibold", STRONG)}>{title}</p>
      <p className={cn("max-w-[32ch] text-xs leading-5", MUTED)}>{body}</p>
    </div>
  );
}

/**
 * The locked part of the sheet: what it holds is drawn blurred, hidden from
 * assistive tech and unreachable by keyboard or pointer, under one prompt.
 * Both sit in one grid cell, so the box is as tall as the taller of the two.
 */
function Locked({
  children,
  notCounting,
  onUpgrade,
}: {
  children: ReactNode;
  notCounting: boolean;
  onUpgrade: () => void;
}) {
  const router = useRouter();
  return (
    <div data-testid="insights-locked" className={cn("relative grid overflow-hidden rounded-[12px] border", HAIRLINE)}>
      <div aria-hidden="true" inert className="pointer-events-none col-start-1 row-start-1 select-none opacity-60 blur-[5px]">
        {children}
      </div>
      <div
        className={cn(
          "col-start-1 row-start-1 flex items-center justify-center p-5",
          "bg-gradient-to-b from-transparent via-white/80 to-white dark:via-[#1f1f1f]/80 dark:to-[#1f1f1f]",
        )}
      >
        <div className="flex max-w-[320px] flex-col items-center gap-2 text-center">
          <span
            aria-hidden
            className="mb-1 flex size-[42px] items-center justify-center rounded-[12px] bg-primary-50/10 text-primary-50 dark:bg-primary-50/20 dark:text-primary-brand-dark"
          >
            <BarChart3 className="size-5" />
          </span>
          <p className={cn("text-[14.5px] font-semibold", STRONG)}>{LOCK_TITLE}</p>
          <p className="text-[12.5px] leading-5 text-grey-30 dark:text-grey-dark-700">
            {notCounting ? LOCK_BODY_NOT_COUNTING : LOCK_BODY}
          </p>
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

function ViewerRows({
  viewers,
  limit = null,
  onSeeAll = null,
}: {
  viewers: InsightsViewer[];
  /** Rows shown before "See all"; `null` shows every one. */
  limit?: number | null;
  /** Where "See all" goes (the Viewers tab); `null` opens the rest in place. */
  onSeeAll?: (() => void) | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const capped = limit !== null && !expanded && viewers.length > limit;
  const shown = capped ? viewers.slice(0, limit) : viewers;
  return (
    <>
      <ul className={cn("flex flex-col divide-y", DIVIDE)}>
        {shown.map((v) => (
          <ViewerRow key={v.viewerId} viewer={v} />
        ))}
      </ul>
      {capped && (
        <button
          type="button"
          className={cn(TEXT_LINK, "mt-2")}
          onClick={() => (onSeeAll ? onSeeAll() : setExpanded(true))}
        >
          See all {viewers.length} viewers
        </button>
      )}
    </>
  );
}

function ViewerRow({ viewer: v }: { viewer: InsightsViewer }) {
  const watched = formatWatched(v.watchedMs);
  return (
    <li className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2.5 py-2">
      <InsightsAvatar name={v.name} />
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className={cn("truncate text-[13px] font-semibold", STRONG)}>
          <bdi>{viewerName(v.name)}</bdi>
          {v.visits > 1 && <span className={cn("ml-1.5 text-xs font-normal", MUTED)}>{v.visits} visits</span>}
        </p>
        {v.completion !== null && (
          <div className={BAR_TRACK} aria-hidden>
            <div className={BAR_FILL} style={{ width: formatPercent(v.completion) }} />
          </div>
        )}
      </div>
      <div className={cn("text-right text-xs leading-[1.35]", MUTED)}>
        {v.completion !== null && (
          <p className={cn("text-[13px] font-semibold tabular-nums", STRONG)} title={`Watched ${watched}`}>
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

/** Which question a comment row is asking, if any. */
type RowQuestion = { id: string; kind: "delete" | "block" } | null;

/**
 * The link's comments and what the owner does to them, shared by the
 * overview and the Comments tab so a block shows in both.
 */
function useCommentModeration(shareToken: string, enabled: boolean) {
  const queryClient = useQueryClient();
  const comments = useQuery({
    queryKey: commentsQueryKey(shareToken),
    queryFn: () => listShareComments(shareToken),
    retry: false,
    enabled,
  });
  const [asking, setAsking] = useState<RowQuestion>(null);
  // Comments whose author was blocked from this sheet. The server keeps the
  // block but never lists it (until hcfs #806), so this is the only place it
  // shows; it lasts while the sheet is open.
  const [blocked, setBlocked] = useState<ReadonlySet<string>>(new Set());
  const remove = useMutation({
    mutationFn: (id: string) => deleteShareComment(shareToken, id),
    onSuccess: () => {
      setAsking(null);
      void queryClient.invalidateQueries({ queryKey: commentsQueryKey(shareToken) });
      void queryClient.invalidateQueries({ queryKey: insightsQueryKey(shareToken) });
    },
    onError: (err) => toast.error(`Couldn't delete the comment. ${errorMessage(err)}`),
  });
  const block = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      on ? blockShareCommenter(shareToken, id) : unblockShareCommenter(shareToken, id),
    onSuccess: (_, { id, on }) => {
      setAsking(null);
      setBlocked((prev) => {
        const next = new Set(prev);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      });
      toast.success(on ? "Blocked. They can't comment or react on this link now." : "Unblocked.");
    },
    onError: (err, { on }) => {
      toast.error(`Couldn't ${on ? "block" : "unblock"} them. ${errorMessage(err)}`);
      // A comment that is gone takes its row with it.
      void queryClient.invalidateQueries({ queryKey: commentsQueryKey(shareToken) });
    },
  });
  return { comments, asking, setAsking, blocked, remove, block };
}

type Moderation = ReturnType<typeof useCommentModeration>;

function CommentsSection({
  moderation,
  plan,
  limit,
  onSeeAll,
}: {
  moderation: Moderation;
  plan: ShareInsights["plan"] | null;
  /** Rows shown before "See all"; `null` shows every one. */
  limit: number | null;
  onSeeAll: (() => void) | null;
}) {
  const repliesEnabled = useAtomValue(shareCommentRepliesEnabledAtom);
  const { comments, asking, setAsking, blocked, remove, block } = moderation;
  const list = comments.data?.comments ?? [];
  const shown = limit !== null ? list.slice(0, limit) : list;
  // On the free plan comments are not locked: say so beside the count.
  const aside =
    list.length === 0 ? undefined : plan === "free" ? `${list.length} · all included on your plan` : String(list.length);
  return (
    <Section title="Comments" aside={aside}>
      {comments.isPending ? (
        <div className={cn(SKELETON, "h-10")} />
      ) : comments.isError ? (
        <p className={cn("text-sm", MUTED)}>Couldn&apos;t load comments. {errorMessage(comments.error)}</p>
      ) : (
        <>
          {comments.data.unreadable && <p className={cn("mb-2 text-sm", MUTED)}>{comments.data.unreadable}</p>}
          {list.length === 0 ? (
            <EmptyState
              icon={<MessageSquare className="size-5" />}
              title="No comments yet"
              body="Comments viewers leave show up here, pinned to their moment."
            />
          ) : (
            <ul className={cn("flex flex-col divide-y", DIVIDE)}>
              {shown.map((c) => (
                <CommentRow
                  key={c.id}
                  comment={c}
                  showReplies={repliesEnabled}
                  asking={asking?.id === c.id ? asking.kind : null}
                  blocked={blocked.has(c.id)}
                  busy={
                    (remove.isPending && remove.variables === c.id) ||
                    (block.isPending && block.variables?.id === c.id)
                  }
                  onAsk={(kind) => setAsking({ id: c.id, kind })}
                  onCancel={() => setAsking(null)}
                  onDelete={() => remove.mutate(c.id)}
                  onBlock={(on) => block.mutate({ id: c.id, on })}
                />
              ))}
            </ul>
          )}
          {limit !== null && list.length > limit && onSeeAll && (
            <button type="button" className={cn(TEXT_LINK, "mt-2")} onClick={onSeeAll}>
              See all {list.length} comments
            </button>
          )}
        </>
      )}
    </Section>
  );
}

const MENU_ITEM = cn(
  "flex items-start gap-2.5 rounded-[8px] px-2.5 py-2 text-left",
  "hover:bg-grey-90 focus:bg-grey-90 dark:hover:bg-[#2a2a2a] dark:focus:bg-[#2a2a2a]",
);

function MomentChip({ atMs }: { atMs: number }) {
  return (
    <span className="rounded-[5px] bg-primary-50/10 px-1.5 py-0.5 font-mono text-[11.5px] font-medium leading-none text-primary-50 dark:bg-primary-50/20 dark:text-primary-brand-dark">
      <span className="sr-only">at </span>
      {formatWatched(atMs)}
    </span>
  );
}

function CommentRow({
  comment,
  showReplies,
  asking,
  blocked,
  busy,
  onAsk,
  onCancel,
  onDelete,
  onBlock,
}: {
  comment: ShareComment;
  /** Replies and the Owner badge, once the server has them (`share_comment_replies`). */
  showReplies: boolean;
  asking: "delete" | "block" | null;
  blocked: boolean;
  busy: boolean;
  onAsk: (kind: "delete" | "block") => void;
  onCancel: () => void;
  onDelete: () => void;
  onBlock: (on: boolean) => void;
}) {
  const name = viewerName(comment.name);
  // A menu choice opens the question in the row, whose button takes focus:
  // the menu must not pull focus back to its trigger as it closes.
  const chose = useRef(false);
  // When the question goes (answered or cancelled), its buttons go with it:
  // focus returns to the row's menu button rather than falling to the page.
  const trigger = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);
  useEffect(() => {
    if (wasAsking.current && asking === null) trigger.current?.focus();
    wasAsking.current = asking !== null;
  }, [asking]);
  const replies = showReplies ? (comment.replies ?? []) : [];
  return (
    <li className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-2.5 py-2.5">
      <InsightsAvatar name={comment.name} className={blocked ? "opacity-50" : undefined} />
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <bdi className={cn("text-[13px] font-semibold", blocked ? MUTED : STRONG)}>{name}</bdi>
          {blocked ? (
            <span
              title="They can't comment or react on this link."
              className="inline-flex h-5 items-center gap-1 rounded-full bg-error-70/10 px-[7px] text-[11px] font-semibold text-error-70"
            >
              <Ban className="size-2.5" strokeWidth={2.5} aria-hidden />
              Blocked
            </span>
          ) : (
            <>
              {comment.atMs !== null && <MomentChip atMs={comment.atMs} />}
              <span className={cn("text-xs", MUTED)}>{formatAgo(comment.createdAt)}</span>
            </>
          )}
        </p>
        {comment.text !== null ? (
          <p
            className={cn(
              "mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-[1.45]",
              blocked ? MUTED : STRONG,
            )}
          >
            {comment.text}
          </p>
        ) : (
          <p className={cn("mt-0.5 text-[13px] italic", MUTED)}>This comment couldn&apos;t be read.</p>
        )}
        {replies.map((r) => (
          <div key={r.id} className="mt-2 grid grid-cols-[20px_minmax(0,1fr)] gap-2">
            <InsightsAvatar name={r.name} size="sm" />
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-x-1.5">
                <bdi className={cn("text-[13px] font-semibold", STRONG)}>{viewerName(r.name)}</bdi>
                {r.byOwner && (
                  <span className="text-[11px] font-semibold text-primary-50 dark:text-primary-brand-dark">Owner</span>
                )}
                <span className={cn("text-xs", MUTED)}>{formatAgo(r.createdAt)}</span>
              </p>
              {r.text !== null && (
                <p className={cn("mt-0.5 whitespace-pre-wrap break-words text-[13px]", STRONG)}>{r.text}</p>
              )}
            </div>
          </div>
        ))}
        {asking && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-xs text-grey-30 dark:text-grey-dark-700">
              {asking === "delete"
                ? blocked
                  ? "Delete this comment for everyone? Its author stays blocked."
                  : "Delete this comment for everyone?"
                : "Block them on this link? They won't be able to comment or react here. Their comments stay until you delete them."}
            </span>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={asking === "delete" ? onDelete : () => onBlock(true)}
              autoFocus
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
              {asking === "delete" ? "Delete" : "Block"}
            </Button>
            <Button variant="defaultStable" size="sm" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          </div>
        )}
      </div>
      {!asking && (
        <div className="flex shrink-0 items-center gap-1">
          {blocked && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onBlock(false)}
              className={cn(TEXT_LINK, "h-7 px-1.5 disabled:opacity-50")}
            >
              Unblock
            </button>
          )}
          <DropdownMenu
            modal={false}
            onOpenChange={(open) => {
              if (open) chose.current = false;
            }}
          >
            <DropdownMenuTrigger asChild>
              <button
                ref={trigger}
                type="button"
                disabled={busy}
                aria-label={`Comment actions for ${name}`}
                className={cn(
                  "flex size-7 items-center justify-center rounded-[7px] transition-colors disabled:opacity-50",
                  MUTED,
                  "hover:bg-grey-90 data-[state=open]:bg-grey-90 data-[state=open]:text-grey-10",
                  "dark:hover:bg-[#2a2a2a] dark:data-[state=open]:bg-[#2a2a2a] dark:data-[state=open]:text-white",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-50/40",
                )}
              >
                <MoreHorizontal className="size-4" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className={cn(
                "z-[70] w-[260px] rounded-[12px] border bg-white p-1.5 shadow-lg dark:bg-[#1f1f1f]",
                HAIRLINE,
              )}
              onCloseAutoFocus={(e) => {
                if (chose.current) e.preventDefault();
              }}
            >
              {!blocked && (
                <DropdownMenuItem
                  className={MENU_ITEM}
                  onSelect={() => {
                    chose.current = true;
                    onAsk("block");
                  }}
                >
                  <Ban className={cn("mt-0.5 size-4 shrink-0", STRONG)} aria-hidden />
                  <span className="flex min-w-0 flex-col">
                    <span className={cn("text-[13px] font-medium", STRONG)}>
                      Block <bdi>{name}</bdi>
                    </span>
                    <span className={cn("text-[11.5px] leading-4", MUTED)}>{BLOCK_EXPLAINER}</span>
                  </span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                className={MENU_ITEM}
                onSelect={() => {
                  chose.current = true;
                  onAsk("delete");
                }}
              >
                <Trash2 className="mt-0.5 size-4 shrink-0 text-error-70" aria-hidden />
                <span className="flex min-w-0 flex-col">
                  <span className="text-[13px] font-medium text-error-70">Delete comment</span>
                  <span className={cn("text-[11.5px] leading-4", MUTED)}>{DELETE_EXPLAINER}</span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </li>
  );
}

/**
 * The link's reaction totals, a bar per emoji, most first. Shown whatever the
 * Reactions switch says (it hides the bar from viewers, not the totals from
 * the owner) and on every plan, since they are not a locked insight.
 */
function ReactionsSection({ shareToken }: { shareToken: string }) {
  const reactions = useQuery({
    queryKey: reactionsQueryKey(shareToken),
    queryFn: () => getShareReactions(shareToken),
    retry: false,
  });
  const switches = useQuery({
    queryKey: linkSettingsQueryKey(shareToken),
    queryFn: () => getLinkSettings(shareToken),
    retry: false,
  });
  const total = reactions.data?.total ?? 0;
  const sorted = useMemo(
    () => [...(reactions.data?.counts ?? [])].sort((a, b) => b.count - a.count),
    [reactions.data],
  );
  const max = sorted[0]?.count ?? 0;
  return (
    <Section
      title="Reactions"
      aside={
        total > 0 ? (
          <>
            {total}
            <span className="sr-only"> total</span>
          </>
        ) : undefined
      }
    >
      {switches.data?.offered.reactions && !switches.data.on.reactions && (
        <p className={cn("mb-2 text-xs", MUTED)}>Reactions are off, so viewers don&apos;t see these or add new ones.</p>
      )}
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
    </Section>
  );
}

/**
 * The link's Insights, Comments and Reactions switches. Each change is sent
 * at once, shows at once, and is put back if the server refuses it. Only the
 * switches Rust says this server takes are drawn.
 */
function OnThisLink({ shareToken, onLeave }: { shareToken: string; onLeave: () => void }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const key = linkSettingsQueryKey(shareToken);
  const current = useQuery({
    queryKey: key,
    queryFn: () => getLinkSettings(shareToken),
    retry: false,
  });
  const save = useMutation({
    mutationFn: (next: LinkSettings) => setLinkSettings(shareToken, next),
    onMutate: (next) => {
      const before = queryClient.getQueryData<LinkSettingsDefault>(key);
      if (before) queryClient.setQueryData<LinkSettingsDefault>(key, { ...before, on: next });
      return { before };
    },
    onError: (err, _next, ctx) => {
      if (ctx?.before) queryClient.setQueryData(key, ctx.before);
      toast.error(`Couldn't change that setting. ${errorMessage(err)}`);
    },
  });

  // Nothing to show on a server without the switches, or while unknown.
  if (!current.data || !current.data.offered.insights) {
    return current.isError ? (
      <Section title="On this link">
        <p className={cn("text-sm", MUTED)}>Couldn&apos;t load this link&apos;s settings. {errorMessage(current.error)}</p>
      </Section>
    ) : null;
  }
  return (
    <Section title="On this link">
      <LinkEngagementSwitches
        layout="list"
        offered={current.data.offered}
        value={current.data.on}
        disabled={save.isPending}
        switchesInPlan={current.data.switchesInPlan ?? null}
        onChange={(next) => save.mutate(next)}
        onUpgrade={() => {
          onLeave();
          router.push(BILLING_ROUTE);
        }}
      />
    </Section>
  );
}

/** What each number means, opened in place: there is no help page for it yet. */
function HowWeCountViews() {
  return (
    <details className="group text-sm">
      <summary className={cn(TEXT_LINK, "cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden")}>
        How we count views
      </summary>
      <dl className="mt-2 flex flex-col gap-2">
        {DEFINITIONS.map(({ term, meaning }) => (
          <div key={term}>
            <dt className="text-xs font-medium text-grey-20 dark:text-grey-dark-800">{term}</dt>
            <dd className={cn("text-xs", MUTED)}>{meaning}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
