"use client";

import { useState, type ReactNode } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Loader2, MessageSquare, Trash2 } from "lucide-react";
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
  deleteShareComment,
  getShareInsights,
  listShareComments,
  type InsightsViewer,
  type ShareComment,
  type ShareInsights,
} from "@/app/lib/tauri/shareInsights";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { formatRelative } from "@/app/lib/utils/timeRelative";
import {
  DEFINITIONS,
  LOCKED_ACTION,
  LOCKED_PROMPT,
  SAMPLE_COMPLETION,
  SAMPLE_RETENTION,
  SAMPLE_VIEWERS,
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
        <InsightsNumbers insights={insights.data} onUpgrade={onLeave} />
      )}
      {commentsEnabled && <CommentsSection shareToken={shareToken} />}
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

function InsightsNumbers({ insights, onUpgrade }: { insights: ShareInsights; onUpgrade: () => void }) {
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
    return (
      <>
        <div className="grid grid-cols-2 gap-3">{views}</div>
        <Locked onUpgrade={onUpgrade}>
          <div className="flex flex-col gap-3">
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
          <p className="text-sm font-medium text-grey-10 dark:text-white">{LOCKED_PROMPT}</p>
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
                <p className="truncate text-sm font-medium text-grey-10 dark:text-white">{viewerName(v.name)}</p>
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

function CommentsSection({ shareToken }: { shareToken: string }) {
  const queryClient = useQueryClient();
  const comments = useQuery({
    queryKey: commentsQueryKey(shareToken),
    queryFn: () => listShareComments(shareToken),
    retry: false,
  });
  const [confirming, setConfirming] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => deleteShareComment(shareToken, id),
    onSuccess: () => {
      setConfirming(null);
      void queryClient.invalidateQueries({ queryKey: commentsQueryKey(shareToken) });
      void queryClient.invalidateQueries({ queryKey: insightsQueryKey(shareToken) });
    },
    onError: (err) => toast.error(`Couldn't delete the comment. ${errorMessage(err)}`),
  });

  return (
    <section className={CARD} aria-labelledby="insights-comments">
      <div className="flex items-center gap-2">
        <MessageSquare className="size-4 text-grey-50 dark:text-grey-dark-600" aria-hidden />
        <h3 id="insights-comments" className="text-sm font-medium text-grey-10 dark:text-white">
          Comments
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
          {comments.data.comments.length === 0 ? (
            <p className="mt-2 text-sm text-grey-50 dark:text-grey-dark-600">No comments yet.</p>
          ) : (
            <ul className="mt-2 flex flex-col divide-y divide-grey-80 dark:divide-[#333]">
              {comments.data.comments.map((c) => (
                <CommentRow
                  key={c.id}
                  comment={c}
                  confirming={confirming === c.id}
                  deleting={remove.isPending && remove.variables === c.id}
                  onAsk={() => setConfirming(c.id)}
                  onCancel={() => setConfirming(null)}
                  onDelete={() => remove.mutate(c.id)}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function CommentRow({
  comment,
  confirming,
  deleting,
  onAsk,
  onCancel,
  onDelete,
}: {
  comment: ShareComment;
  confirming: boolean;
  deleting: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const meta = [formatRelative(comment.createdAt), comment.atMs !== null ? formatMoment(comment.atMs) : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-xs text-grey-50 dark:text-grey-dark-600">
          <span className="font-medium text-grey-20 dark:text-grey-dark-800">{viewerName(comment.name)}</span>
          {meta ? ` · ${meta}` : null}
        </p>
        {comment.text !== null ? (
          <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-grey-10 dark:text-white">{comment.text}</p>
        ) : (
          <p className="mt-0.5 text-sm italic text-grey-50 dark:text-grey-dark-600">This comment couldn&apos;t be read.</p>
        )}
        {confirming && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-xs text-grey-30 dark:text-grey-dark-700">Delete this comment for everyone?</span>
            <Button variant="destructive" size="sm" disabled={deleting} onClick={onDelete} autoFocus>
              {deleting ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
              Delete
            </Button>
            <Button variant="defaultStable" size="sm" disabled={deleting} onClick={onCancel}>
              Cancel
            </Button>
          </div>
        )}
      </div>
      {!confirming && (
        <button
          type="button"
          onClick={onAsk}
          aria-label="Delete comment"
          title="Delete comment"
          className="shrink-0 rounded p-1 text-grey-50 transition-colors hover:text-error-70 dark:text-grey-dark-600 dark:hover:text-error-70"
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
      )}
    </li>
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
