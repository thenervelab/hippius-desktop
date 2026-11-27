"use client";

import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { getViewerVisits, type ViewerVisit, type ViewerVisits as ViewerVisitsPage } from "@/app/lib/tauri/shareInsights";
import { useIsOnline } from "@/app/lib/hooks/useIsOnline";
import { formatWatched, loadErrorLine, pagesSeenLabel } from "./insightsView";
import { LoadError } from "./LoadError";
import { PANEL_QUERY, viewerVisitsQueryKey } from "./queryKeys";
import { PageBars } from "./PageBars";
import { MUTED, SKELETON, STRONG, TEXT_LINK } from "./panelStyles";

/** "Nov 20, 9:12 AM" in the owner's own zone. */
export function formatVisitAt(rfc3339: string): string {
  const t = Date.parse(rfc3339);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** "3 visits · 9:00" over every visit. */
export function visitsSummary(page: Pick<ViewerVisitsPage, "visitsTotal" | "timeSpentMs">): string {
  const visits = `${page.visitsTotal} ${page.visitsTotal === 1 ? "visit" : "visits"}`;
  return page.timeSpentMs > 0 ? `${visits} · ${formatWatched(page.timeSpentMs)}` : visits;
}

/** What one visit shows on its right: its time and, for a document, its pages. */
export function visitLine(v: ViewerVisit, pageCount: number | null): string {
  const parts: string[] = [];
  if (v.timeSpentMs !== null && v.timeSpentMs > 0) parts.push(formatWatched(v.timeSpentMs));
  if (v.pagesSeen !== null) {
    parts.push(pageCount !== null ? pagesSeenLabel(v.pagesSeen, pageCount) : `${v.pagesSeen} ${v.pagesSeen === 1 ? "page" : "pages"}`);
  }
  return parts.join(" · ");
}

/**
 * One viewer's own visits, opened from their row in the Viewers tab: their
 * total visits and time, their time on each page of a document (a bar a
 * page, a page they skipped greyed), and each visit newest first. Read from
 * Rust a page of 100 visits at a time.
 */
export function ViewerVisits({ shareToken, viewerId }: { shareToken: string; viewerId: string }) {
  const online = useIsOnline();
  const query = useInfiniteQuery({
    queryKey: viewerVisitsQueryKey(shareToken, viewerId),
    queryFn: ({ pageParam }) => getViewerVisits(shareToken, viewerId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last: ViewerVisitsPage) => last.nextBefore ?? undefined,
    ...PANEL_QUERY,
  });
  const first = query.data?.pages[0] ?? null;
  const visits = useMemo(() => query.data?.pages.flatMap((p) => p.visits) ?? [], [query.data]);

  if (query.isPending) return <div className={cn(SKELETON, "h-16 rounded-[10px]")} data-testid="viewer-visits-loading" />;
  if (query.isError || !first) {
    return <LoadError line={loadErrorLine("this viewer's visits", query.error, online)} onRetry={() => void query.refetch()} />;
  }
  const pages = first.pageTimeMs;
  return (
    <div className="flex flex-col gap-3" data-testid="viewer-visits">
      <p className={cn("text-xs tabular-nums", MUTED)}>{visitsSummary(first)}</p>
      {pages && pages.length > 1 && (
        <div>
          <p className={cn("text-xs font-medium", STRONG)}>Time per page</p>
          <PageBars
            values={pages}
            height={48}
            listLabel="Time per page"
            summary={`Time per page over ${pages.length} pages.`}
            label={(i) => `Page ${i + 1}`}
            valueText={(i) => ((pages[i] ?? 0) > 0 ? formatWatched(pages[i] ?? 0) : "not seen")}
            testId="viewer-page-time"
          />
        </div>
      )}
      <ul className="flex flex-col gap-1.5" aria-label="Visits">
        {visits.map((v) => (
          <li key={`${v.startedAt}-${v.lastSeenAt}`} className="flex items-center justify-between gap-3 text-xs">
            <span className="min-w-0 truncate text-grey-20 dark:text-grey-dark-800">{formatVisitAt(v.startedAt)}</span>
            <span className={cn("shrink-0 tabular-nums", MUTED)}>{visitLine(v, pages ? pages.length : null)}</span>
          </li>
        ))}
      </ul>
      {query.hasNextPage && (
        <button
          type="button"
          className={TEXT_LINK}
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          <ChevronDown aria-hidden className="size-[13px]" />
          Show more visits
        </button>
      )}
    </div>
  );
}
