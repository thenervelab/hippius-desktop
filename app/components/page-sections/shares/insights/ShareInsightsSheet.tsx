"use client";

import { useState, type ReactNode } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Lock, Loader2, MessageSquare, SlidersHorizontal, SmilePlus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { FramedDialog } from "@/components/ui/FramedDialog";
import { cn } from "@/lib/utils";
import { BILLING_ROUTE } from "@/app/lib/routes";
import {
  insightsSheetAtom,
  shareCommentsEnabledAtom,
} from "@/app/lib/global-atoms/sharesAtoms";
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
import { formatRelative } from "@/app/lib/utils/timeRelative";
import {
  DEFINITIONS,
  LOCKED_ACTION,
  LOCKED_BODY,
  LOCKED_PROMPT,
  SAMPLE_COMPLETION,
  SAMPLE_RETENTION,
  SAMPLE_UNIQUE_VIEWERS,
  SAMPLE_VIEWERS,
  SAMPLE_VIEWS,
  formatMoment,
  formatPercent,
  viewerName,
  viewerSummary,
} from "./insightsView";

const CARD = cn(
  "rounded-[8px] border p-3",
  "border-grey-80 bg-white",
  "dark:border-[#494949] dark:bg-[#1f1f1f]",
);
const LABEL = "text-xs font-medium text-grey-50 dark:text-grey-dark-600";
const VALUE = "mt-1 text-xl font-semibold tabular-nums text-grey-10 dark:text-white";

export const insightsQueryKey = (shareToken: string) => ["share-insights", shareToken] as const;
export const commentsQueryKey = (shareToken: string) => ["share-comments", shareToken] as const;
export const reactionsQueryKey = (shareToken: string) => ["share-reactions", shareToken] as const;
export const linkSettingsQueryKey = (shareToken: string) => ["share-link-settings", shareToken] as const;

/**
 * The owner's Insights for one link, opened from Shared Links, a row on the
 * Captures page or the capture card (`insightsSheetAtom`). Mounted once in
 * the pages layout. Every number, and whether it is locked, comes from Rust.
 */
export default function ShareInsightsSheet() {
  const [target, setTarget] = useAtom(insightsSheetAtom);
  if (!target) return null;
  return (
    <FramedDialog
      open
      onClose={() => setTarget(null)}
      title="Insights"
      headerLayout="leading"
      subtitle={<span className="block truncate" title={target.fileName}>{target.fileName}</span>}
      maxWidth="max-w-[640px]"
    >
      <InsightsBody shareToken={target.shareToken} onLeave={() => setTarget(null)} />
    </FramedDialog>
  );
}

export function InsightsBody({ shareToken, onLeave }: { shareToken: string; onLeave: () => void }) {
  const commentsEnabled = useAtomValue(shareCommentsEnabledAtom);
  const insights = useQuery({
    queryKey: insightsQueryKey(shareToken),
    queryFn: () => getShareInsights(shareToken),
    retry: false,
  });
  // The same query Link settings reads: whether this link counts views.
  const switches = useQuery({
    queryKey: linkSettingsQueryKey(shareToken),
    queryFn: () => getLinkSettings(shareToken),
    retry: false,
  });
  const notCounting = switches.data?.offered.insights === true && !switches.data.on.insights;

  return (
    <div className="flex flex-col gap-4 font-geist">
      {insights.isPending ? (
        <InsightsSkeleton />
      ) : insights.isError ? (
        <div role="alert" className={cn(CARD, "flex flex-col items-start gap-2")}>
          <p className="text-sm text-grey-20 dark:text-grey-dark-800">
            Couldn&apos;t load insights. {errorMessage(insights.error)}
          </p>
          <Button variant="defaultStable" size="sm" onClick={() => void insights.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <InsightsNumbers insights={insights.data} notCounting={notCounting} onUpgrade={onLeave} />
      )}
      {commentsEnabled && <CommentsSection shareToken={shareToken} />}
      {commentsEnabled && <ReactionsSection shareToken={shareToken} />}
      <LinkSettingsSection shareToken={shareToken} onLeave={onLeave} />
      <HowWeCalculate />
    </div>
  );
}

function InsightsSkeleton() {
  return (
    <div data-testid="insights-loading" className="flex flex-col gap-3" aria-busy="true">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-[72px] animate-pulse rounded-[8px] bg-grey-light-200 motion-reduce:animate-none dark:bg-black-500" />
        ))}
      </div>
      <div className="h-32 animate-pulse rounded-[8px] bg-grey-light-200 motion-reduce:animate-none dark:bg-black-500" />
    </div>
  );
}

function InsightsNumbers({
  insights,
  notCounting,
  onUpgrade,
}: {
  insights: ShareInsights;
  /** The link's Insights switch is off, so its view counts are not being kept. */
  notCounting: boolean;
  onUpgrade: () => void;
}) {
  const { completion, retention, viewers } = insights;
  const anyLocked = completion.state === "locked" || retention.state === "locked" || viewers.state === "locked";

  const views = (
    <>
      <Stat label="Views" value={String(insights.totalViews)} />
      <Stat label="Unique viewers" value={String(insights.uniqueViewers)} />
    </>
  );

  if (anyLocked) {
    // Everything past the two numbers is drawn from SAMPLE data, blurred,
    // with no real value anywhere in it: Rust sends none for a locked metric.
    // A free link that is not counting views has no real numbers at all, so
    // its two counts are samples under the prompt too, rather than a "0"
    // that reads as nobody having opened it.
    return (
      <>
        {!notCounting && <div className="grid grid-cols-2 gap-3">{views}</div>}
        <Locked onUpgrade={onUpgrade}>
          <div className="flex flex-col gap-3">
            {notCounting && (
              <div className="grid grid-cols-2 gap-3">
                <Stat label="Views" value={String(SAMPLE_VIEWS)} />
                <Stat label="Unique viewers" value={String(SAMPLE_UNIQUE_VIEWERS)} />
              </div>
            )}
            <Stat label="Completion" value={formatPercent(SAMPLE_COMPLETION)} />
            <RetentionCard values={SAMPLE_RETENTION} />
            <ViewerList viewers={SAMPLE_VIEWERS} />
          </div>
        </Locked>
      </>
    );
  }

  const completionValue = completion.state === "shown" ? completion.value : null;
  const retentionValues = retention.state === "shown" ? retention.value : null;
  const viewerRows = viewers.state === "shown" ? viewers.value : [];
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {views}
        <Stat
          label="Completion"
          value={completionValue === null ? "None yet" : formatPercent(completionValue)}
          muted={completionValue === null}
        />
      </div>
      {retentionValues && <RetentionCard values={retentionValues} />}
      {insights.totalViews === 0 ? (
        <p className="text-sm text-grey-50 dark:text-grey-dark-600">
          No one has opened this link yet. Views show up here once someone does.
        </p>
      ) : (
        <ViewerList viewers={viewerRows} />
      )}
    </>
  );
}

function Stat({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={CARD}>
      <p className={LABEL}>{label}</p>
      <p className={cn(VALUE, muted && "text-base font-medium text-grey-50 dark:text-grey-dark-600")}>{value}</p>
    </div>
  );
}

/**
 * The locked part of the sheet: what it holds is drawn blurred, hidden from
 * assistive tech and unreachable by keyboard or pointer, under one prompt.
 */
function Locked({ children, onUpgrade }: { children: ReactNode; onUpgrade: () => void }) {
  const router = useRouter();
  return (
    <div data-testid="insights-locked" className="relative">
      <div aria-hidden="true" inert className="pointer-events-none select-none blur-[6px]">
        {children}
      </div>
      <div className="absolute inset-0 flex items-center justify-center p-3">
        <div
          className={cn(
            "flex max-w-[340px] flex-col items-center gap-3 rounded-[10px] border px-4 py-4 text-center shadow-lg",
            "border-grey-80 bg-white/95",
            "dark:border-[#494949] dark:bg-[#1f1f1f]/95",
          )}
        >
          <span className="flex size-9 items-center justify-center rounded-full bg-primary-50/10 text-primary-50 dark:bg-primary-brand-dark/15 dark:text-primary-brand-dark">
            <Lock className="size-4" aria-hidden />
          </span>
          <div>
            <p className="text-sm font-medium text-grey-10 dark:text-white">{LOCKED_PROMPT}</p>
            <p className="mt-1 text-xs text-grey-50 dark:text-grey-dark-600">{LOCKED_BODY}</p>
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              onUpgrade();
              router.push(BILLING_ROUTE);
            }}
          >
            {LOCKED_ACTION}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Where people stopped watching: one point per 1% of the recording. */
function RetentionCard({ values }: { values: number[] }) {
  const w = 300;
  const h = 80;
  const n = Math.max(values.length - 1, 1);
  const points = values.map((v, i) => `${((i / n) * w).toFixed(1)},${(h - (Math.min(100, Math.max(0, v)) / 100) * h).toFixed(1)}`);
  const end = values.length > 0 ? Math.round(values[values.length - 1]) : 0;
  return (
    <div className={CARD}>
      <div className="flex items-baseline justify-between gap-2">
        <p className={LABEL}>Retention</p>
        <p className="text-xs text-grey-50 dark:text-grey-dark-600">{end}% reached the end</p>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Retention: ${end}% of visits reached the end`}
        className="mt-2 h-24 w-full text-primary-50 dark:text-primary-brand-dark"
      >
        <polygon points={`0,${h} ${points.join(" ")} ${w},${h}`} className="fill-current opacity-15" />
        <polyline points={points.join(" ")} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-grey-50 dark:text-grey-dark-600">
        <span>Start</span>
        <span>End</span>
      </div>
    </div>
  );
}

function ViewerList({ viewers }: { viewers: InsightsViewer[] }) {
  return (
    <div className={CARD}>
      <p className={LABEL}>Who watched</p>
      {viewers.length === 0 ? (
        <p className="mt-2 text-sm text-grey-50 dark:text-grey-dark-600">No one yet.</p>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-grey-80 dark:divide-[#333]">
          {viewers.map((v) => (
            <li key={v.viewerId} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-grey-10 dark:text-white">
                  <bdi>{viewerName(v.name)}</bdi>
                </p>
                <p className="text-xs text-grey-50 dark:text-grey-dark-600">{viewerSummary(v)}</p>
              </div>
              {v.lastViewedAt && (
                <span className="shrink-0 text-xs text-grey-50 dark:text-grey-dark-600">{formatRelative(v.lastViewedAt)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Which question a comment row is asking, if any. */
type RowQuestion = { id: string; kind: "delete" | "block" } | null;

function CommentsSection({ shareToken }: { shareToken: string }) {
  const queryClient = useQueryClient();
  const comments = useQuery({
    queryKey: commentsQueryKey(shareToken),
    queryFn: () => listShareComments(shareToken),
    retry: false,
  });
  const [asking, setAsking] = useState<RowQuestion>(null);
  // Comments whose author was blocked from this sheet. The server keeps the
  // block but never lists it, so this is the only place it shows; it lasts
  // while the sheet is open.
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

  const list = comments.data?.comments ?? [];
  return (
    <section className={CARD} aria-labelledby="insights-comments">
      <div className="flex items-center gap-2">
        <MessageSquare className="size-4 text-grey-50 dark:text-grey-dark-600" aria-hidden />
        <h3 id="insights-comments" className="text-sm font-medium text-grey-10 dark:text-white">
          Comments
          {list.length > 0 && <span className="ml-1.5 font-normal text-grey-50 dark:text-grey-dark-600">{list.length}</span>}
        </h3>
      </div>
      {comments.isPending ? (
        <div className="mt-3 h-10 animate-pulse rounded bg-grey-light-200 motion-reduce:animate-none dark:bg-black-500" />
      ) : comments.isError ? (
        <p className="mt-2 text-sm text-grey-50 dark:text-grey-dark-600">
          Couldn&apos;t load comments. {errorMessage(comments.error)}
        </p>
      ) : (
        <>
          {comments.data.unreadable && (
            <p className="mt-2 text-sm text-grey-50 dark:text-grey-dark-600">{comments.data.unreadable}</p>
          )}
          {list.length === 0 ? (
            <p className="mt-2 text-sm text-grey-50 dark:text-grey-dark-600">No comments yet.</p>
          ) : (
            <ul className="mt-2 flex flex-col divide-y divide-grey-80 dark:divide-[#333]">
              {list.map((c) => (
                <CommentRow
                  key={c.id}
                  comment={c}
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
        </>
      )}
    </section>
  );
}

const ROW_ICON = cn(
  "shrink-0 rounded p-1 text-grey-50 transition-colors",
  "hover:text-error-70 dark:text-grey-dark-600 dark:hover:text-error-70",
  "disabled:opacity-50",
);

function CommentRow({
  comment,
  asking,
  blocked,
  busy,
  onAsk,
  onCancel,
  onDelete,
  onBlock,
}: {
  comment: ShareComment;
  asking: "delete" | "block" | null;
  blocked: boolean;
  busy: boolean;
  onAsk: (kind: "delete" | "block") => void;
  onCancel: () => void;
  onDelete: () => void;
  onBlock: (on: boolean) => void;
}) {
  const meta = [formatRelative(comment.createdAt), comment.atMs !== null ? formatMoment(comment.atMs) : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-xs text-grey-50 dark:text-grey-dark-600">
          <bdi className="font-medium text-grey-20 dark:text-grey-dark-800">{viewerName(comment.name)}</bdi>
          {meta ? ` · ${meta}` : null}
        </p>
        {comment.text !== null ? (
          <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-grey-10 dark:text-white">{comment.text}</p>
        ) : (
          <p className="mt-0.5 text-sm italic text-grey-50 dark:text-grey-dark-600">This comment couldn&apos;t be read.</p>
        )}
        {blocked && asking === null && (
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-grey-50 dark:text-grey-dark-600">
            <span>Blocked: they can&apos;t comment or react on this link.</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => onBlock(false)}
              className="font-medium text-primary-50 hover:underline disabled:opacity-50 dark:text-primary-brand-dark"
            >
              Unblock
            </button>
          </p>
        )}
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
          {!blocked && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAsk("block")}
              aria-label="Block commenter"
              title="Block commenter"
              className={ROW_ICON}
            >
              <Ban className="size-4" aria-hidden />
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => onAsk("delete")}
            aria-label="Delete comment"
            title="Delete comment"
            className={ROW_ICON}
          >
            <Trash2 className="size-4" aria-hidden />
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * The link's reaction totals. Shown whatever the Reactions switch says (it
 * hides the bar from viewers, not the totals from the owner) and on every
 * plan, since they are not a locked insight.
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
  return (
    <section className={CARD} aria-labelledby="insights-reactions">
      <div className="flex items-center gap-2">
        <SmilePlus className="size-4 text-grey-50 dark:text-grey-dark-600" aria-hidden />
        <h3 id="insights-reactions" className="text-sm font-medium text-grey-10 dark:text-white">
          Reactions
          {total > 0 && (
            <span className="ml-1.5 font-normal text-grey-50 dark:text-grey-dark-600">
              <span className="sr-only">, </span>
              {total}
              <span className="sr-only"> total</span>
            </span>
          )}
        </h3>
      </div>
      {switches.data?.offered.reactions && !switches.data.on.reactions && (
        <p className="mt-2 text-xs text-grey-50 dark:text-grey-dark-600">
          Reactions are off, so viewers don&apos;t see these or add new ones.
        </p>
      )}
      {reactions.isPending ? (
        <div className="mt-3 h-8 animate-pulse rounded bg-grey-light-200 motion-reduce:animate-none dark:bg-black-500" />
      ) : reactions.isError ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="text-sm text-grey-50 dark:text-grey-dark-600">
            Couldn&apos;t load reactions. {errorMessage(reactions.error)}
          </p>
          <Button variant="defaultStable" size="sm" onClick={() => void reactions.refetch()}>
            Try again
          </Button>
        </div>
      ) : reactions.data.counts.length === 0 ? (
        <p className="mt-2 text-sm text-grey-50 dark:text-grey-dark-600">No reactions yet.</p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Reaction totals">
          {reactions.data.counts.map(({ emoji, count }) => (
            <li
              key={emoji}
              className={cn(
                "flex h-8 min-w-[44px] items-center justify-center gap-1 rounded-full border px-2.5 text-sm",
                "border-grey-80 bg-grey-100 text-grey-10",
                "dark:border-[#494949] dark:bg-[#161616] dark:text-white",
              )}
            >
              <span>{emoji}</span>
              <span className="text-xs tabular-nums">{count}</span>
              <span className="sr-only">{count === 1 ? " reaction" : " reactions"}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The link's Insights, Comments and Reactions switches. Each change is sent
 * at once, shows at once, and is put back if the server refuses it. Only the
 * switches Rust says this server takes are drawn.
 */
function LinkSettingsSection({ shareToken, onLeave }: { shareToken: string; onLeave: () => void }) {
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
      <section className={CARD} aria-labelledby="insights-link-settings">
        <LinkSettingsHeading />
        <p className="mt-2 text-sm text-grey-50 dark:text-grey-dark-600">
          Couldn&apos;t load this link&apos;s settings. {errorMessage(current.error)}
        </p>
      </section>
    ) : null;
  }
  return (
    <section className={CARD} aria-labelledby="insights-link-settings">
      <LinkSettingsHeading />
      <LinkEngagementSwitches
        offered={current.data.offered}
        value={current.data.on}
        disabled={save.isPending}
        insightsInPlan={current.data.insightsInPlan ?? null}
        onChange={(next) => save.mutate(next)}
        onUpgrade={() => {
          onLeave();
          router.push(BILLING_ROUTE);
        }}
      />
    </section>
  );
}

function LinkSettingsHeading() {
  return (
    <div className="flex items-center gap-2">
      <SlidersHorizontal className="size-4 text-grey-50 dark:text-grey-dark-600" aria-hidden />
      <h3 id="insights-link-settings" className="text-sm font-medium text-grey-10 dark:text-white">
        Link settings
      </h3>
    </div>
  );
}

function HowWeCalculate() {
  return (
    <details className="group text-sm">
      <summary className="cursor-pointer select-none text-xs font-medium text-primary-50 hover:underline dark:text-primary-brand-dark">
        See how we calculate this
      </summary>
      <dl className="mt-2 flex flex-col gap-2">
        {DEFINITIONS.map(({ term, meaning }) => (
          <div key={term}>
            <dt className="text-xs font-medium text-grey-20 dark:text-grey-dark-800">{term}</dt>
            <dd className="text-xs text-grey-50 dark:text-grey-dark-600">{meaning}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
