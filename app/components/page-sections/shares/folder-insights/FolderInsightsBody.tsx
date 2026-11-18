"use client";

// What a folder link's Insights show, from Rust's answer: the files that were
// opened (most viewed first) and the people who opened them (the room). A
// file opens to its pages, when it is a document, and who opened it; a
// person opens to the files they read. On a plan without the viewer list the
// People tab is the blurred sample under the upgrade prompt, as on a file
// link. Everything here only draws: the order, times and labels come from
// Rust.

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BarChart3, ChevronDown, Eye, FileText, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BILLING_ROUTE } from "@/app/lib/routes";
import type { FolderFile, FolderInsights, RoomPerson } from "@/app/lib/tauri/folderInsights";
import type { InsightsPages } from "@/app/lib/tauri/shareInsights";
import { EmptyLine } from "@/components/page-sections/shares/insights/EmptyLine";
import { InsightsAvatar } from "@/components/page-sections/shares/insights/InsightsAvatar";
import {
  COMPARE_PLANS,
  formatAgo,
  formatPercent,
  formatWatched,
  pagesSeenLabel,
  PRICING_URL,
  SAMPLE_LABEL,
  UPGRADE_PLAN,
  VIEWERS_PAGE,
} from "@/components/page-sections/shares/insights/insightsView";
import {
  BAR_FILL,
  BAR_TRACK,
  DIVIDE,
  FOCUS,
  HAIRLINE,
  MUTED,
  STRONG,
  TEXT_LINK,
} from "@/components/page-sections/shares/insights/panelStyles";
import { SAMPLE_FILES, SAMPLE_PEOPLE } from "./folderInsightsSample";

export type FolderInsightsTab = "files" | "people";

/** The upgrade prompt's words on a plan without the viewer list. */
export const FOLDER_LOCK_TITLE = "See who opened what";
export const FOLDER_LOCK_BODY = "Your views are being counted. Who opened each file, and the pages and time, come with paid Drive plans.";
export const FOLDER_LOCK_BODY_OFF = "Count this folder's views and see who opened each file, page by page.";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const ROW = cn(
  "flex w-full min-w-0 items-center gap-3 rounded-[8px] px-2 py-2.5 text-left",
  "hover:bg-grey-90/70 dark:hover:bg-white/[0.06]",
  FOCUS,
);

/** The Files tab: each file opened, with its views, and for a document the time on it. */
export function FolderFilesTab({ insights }: { insights: FolderInsights }) {
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState(VIEWERS_PAGE);
  if (insights.files.length === 0) return <EmptyLine icon={<Eye />} text="No views yet" />;
  const shown = insights.files.slice(0, limit);
  return (
    <section aria-label="Files" className="flex flex-col">
      <ul className={cn("-mx-2 flex flex-col divide-y", DIVIDE)} data-testid="folder-insights-files">
        {shown.map((file) => (
          <FileItem
            key={file.path}
            file={file}
            expanded={open === file.path}
            onToggle={() => setOpen((cur) => (cur === file.path ? null : file.path))}
          />
        ))}
      </ul>
      <ShowMore shown={shown.length} total={insights.files.length} onMore={() => setLimit((n) => n + VIEWERS_PAGE)}>
        Show more files
      </ShowMore>
    </section>
  );
}

function FileItem({ file, expanded, onToggle }: { file: FolderFile; expanded: boolean; onToggle: () => void }) {
  const expandable = file.viewers.state === "shown";
  const facts = [plural(file.totalViews, "view", "views"), plural(file.uniqueViewers, "person", "people")];
  if (file.read !== null) facts.push(`${formatPercent(file.read)} read`);
  const body = (
    <>
      <FileText aria-hidden className={cn("size-4 shrink-0", MUTED)} />
      <span className="grid min-w-0 flex-1 gap-px">
        <span className={cn("truncate text-[13px]", STRONG)} title={file.path}>
          <bdi>{file.name}</bdi>
        </span>
        <span className={cn("truncate text-xs", MUTED)} data-testid="folder-file-facts">
          {file.folder ? (
            <>
              <bdi>{file.folder}</bdi>
              {" · "}
            </>
          ) : null}
          {facts.join(" · ")}
        </span>
      </span>
      {file.timeMs !== null ? <TimeCell ms={file.timeMs} /> : null}
      {expandable ? (
        <ChevronDown aria-hidden className={cn("size-4 shrink-0 transition-transform", MUTED, expanded && "rotate-180")} />
      ) : null}
    </>
  );
  return (
    <li data-testid="folder-insights-file" data-path={file.path}>
      {expandable ? (
        <button type="button" aria-expanded={expanded} onClick={onToggle} className={ROW}>
          {body}
        </button>
      ) : (
        <div className={cn(ROW, "hover:bg-transparent dark:hover:bg-transparent")}>{body}</div>
      )}
      {expanded && expandable ? <FileDetail file={file} /> : null}
    </li>
  );
}

/** One file opened: its pages when it is a document, then who opened it. */
function FileDetail({ file }: { file: FolderFile }) {
  const viewers = file.viewers.state === "shown" ? file.viewers.value : [];
  return (
    <div className="flex flex-col gap-4 px-2 pb-4 pt-1" data-testid="folder-file-detail">
      {file.pages ? <PageRows pages={file.pages} /> : null}
      <section aria-label={`Who opened ${file.name}`}>
        <h3 className={cn("mb-1 text-[12.5px] font-semibold", STRONG)}>Viewers</h3>
        {viewers.length === 0 ? (
          <p className={cn("text-xs", MUTED)}>No views yet</p>
        ) : (
          <ul className={cn("flex flex-col divide-y", DIVIDE)}>
            {viewers.map((v) => (
              <PersonLine
                key={v.viewerId}
                label={v.label}
                detail={[
                  v.lastViewedAt ? formatAgo(v.lastViewedAt) : null,
                  v.pagesSeen !== null && v.pageCount !== null ? pagesSeenLabel(v.pagesSeen, v.pageCount) : null,
                  v.completion !== null ? `${formatPercent(v.completion)} watched` : null,
                  v.visits > 1 ? `${v.visits} visits` : null,
                ]}
                timeMs={v.pageTimeMs}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** A document's pages: how many visits reached each, and the median time on it. */
function PageRows({ pages }: { pages: InsightsPages }) {
  const [limit, setLimit] = useState(10);
  const all = pages.reach.map((reach, i) => ({ page: i + 1, reach, ms: pages.medianMs[i] ?? 0 }));
  const shown = all.slice(0, limit);
  return (
    <section aria-label="Pages">
      <div aria-hidden className={cn("mb-1 flex items-center gap-3 text-[11.5px]", MUTED)}>
        <span className="w-14 shrink-0">Page</span>
        <span className="min-w-0 flex-1">Reached</span>
        <span className="w-11 shrink-0 text-right">Time</span>
      </div>
      <ul className="flex flex-col">
        {shown.map(({ page, reach, ms }) => (
          <li key={page} className="flex items-center gap-3 py-1">
            <span className={cn("w-14 shrink-0 text-[12.5px] tabular-nums", STRONG)}>Page {page}</span>
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
      <ShowMore shown={shown.length} total={all.length} onMore={() => setLimit((n) => n + 10)}>
        Show more pages
      </ShowMore>
    </section>
  );
}

/** One person: the neutral avatar, the label, a line of facts and the time on the right. */
function PersonLine({ label, detail, timeMs }: { label: string; detail: ReadonlyArray<string | null>; timeMs: number | null }) {
  return (
    <li className="flex min-w-0 items-center gap-3 py-2">
      <InsightsAvatar name={null} size="row" />
      <PersonText label={label} detail={detail} />
      {timeMs !== null ? <TimeCell ms={timeMs} /> : null}
    </li>
  );
}

function PersonText({ label, detail }: { label: string; detail: ReadonlyArray<string | null> }) {
  return (
    <span className="grid min-w-0 flex-1 gap-px">
      <span className={cn("truncate text-[13px]", STRONG)}>{label}</span>
      <span className={cn("truncate text-xs", MUTED)}>{detail.filter(Boolean).join(" · ")}</span>
    </span>
  );
}

function TimeCell({ ms }: { ms: number }) {
  return (
    <span className={cn("shrink-0 text-xs tabular-nums", MUTED)} data-testid="folder-time">
      {formatWatched(ms)}
      <span className="sr-only"> spent reading</span>
    </span>
  );
}

/** The People tab, the folder as a room: everyone who opened something, most recent first. */
export function FolderPeopleTab({
  insights,
  notCounting,
  onUpgrade,
}: {
  insights: FolderInsights;
  notCounting: boolean;
  onUpgrade: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState(VIEWERS_PAGE);
  if (insights.people.state === "locked") {
    return <FolderLocked notCounting={notCounting} onUpgrade={onUpgrade} />;
  }
  const people = insights.people.value;
  if (people.length === 0) return <EmptyLine icon={<Eye />} text="No views yet" />;
  const shown = people.slice(0, limit);
  return (
    <section aria-label="People" className="flex flex-col">
      <PeopleList people={shown} open={open} onToggle={(id) => setOpen((cur) => (cur === id ? null : id))} />
      <ShowMore shown={shown.length} total={people.length} onMore={() => setLimit((n) => n + VIEWERS_PAGE)}>
        Show more people
      </ShowMore>
    </section>
  );
}

function PeopleList({
  people,
  open,
  onToggle,
}: {
  people: RoomPerson[];
  open: string | null;
  onToggle: (viewerId: string) => void;
}) {
  return (
    <ul className={cn("-mx-2 flex flex-col divide-y", DIVIDE)} data-testid="folder-insights-people">
      {people.map((p) => {
        const expanded = open === p.viewerId;
        return (
          <li key={p.viewerId} data-testid="folder-insights-person">
            <button type="button" aria-expanded={expanded} onClick={() => onToggle(p.viewerId)} className={ROW}>
              <InsightsAvatar name={null} size="md" />
              <PersonText
                label={p.label}
                detail={[`Opened ${plural(p.files.length, "file", "files")}`, p.lastViewedAt ? formatAgo(p.lastViewedAt) : null]}
              />
              {p.pageTimeMs !== null ? <TimeCell ms={p.pageTimeMs} /> : null}
              <ChevronDown aria-hidden className={cn("size-4 shrink-0 transition-transform", MUTED, expanded && "rotate-180")} />
            </button>
            {expanded ? (
              <ul className="flex flex-col px-2 pb-3 pl-12" data-testid="folder-person-files">
                {p.files.map((f) => (
                  <li key={f.path} className="flex min-w-0 items-start gap-2 py-1.5">
                    <FileText aria-hidden className={cn("mt-0.5 size-3.5 shrink-0", MUTED)} />
                    <span className="grid min-w-0 flex-1 gap-px">
                      <span className={cn("truncate text-[12.5px]", STRONG)} title={f.path}>
                        <bdi>{f.name}</bdi>
                      </span>
                      <span className={cn("truncate text-xs", MUTED)}>
                        {[
                          f.lastViewedAt ? formatAgo(f.lastViewedAt) : null,
                          f.pagesSeen !== null && f.pageCount !== null ? pagesSeenLabel(f.pagesSeen, f.pageCount) : null,
                          f.visits > 1 ? `${f.visits} visits` : null,
                          f.pageTimeMs !== null ? formatWatched(f.pageTimeMs) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function ShowMore({ shown, total, onMore, children }: { shown: number; total: number; onMore: () => void; children: ReactNode }) {
  if (shown >= total) return null;
  return (
    <div className="mt-2 flex items-center justify-between gap-3">
      <button type="button" className={TEXT_LINK} onClick={onMore}>
        {children}
      </button>
      <span className={cn("text-xs tabular-nums", MUTED)}>
        {shown} of {total}
      </span>
    </div>
  );
}

/**
 * The locked People tab: sample rows, blurred, hidden from assistive tech and
 * unreachable, under one prompt, with "Sample data" in the corner so the
 * made-up numbers are never read as the link's. Rust sends no viewer for a
 * locked plan, so nothing real can be in it.
 */
export function FolderLocked({ notCounting, onUpgrade }: { notCounting: boolean; onUpgrade: () => void }) {
  const router = useRouter();
  return (
    <div
      data-testid="folder-insights-locked"
      className={cn("relative grid overflow-hidden rounded-[12px] border bg-white dark:bg-[#1c1c1c]", HAIRLINE)}
    >
      <div aria-hidden="true" inert className="pointer-events-none col-start-1 row-start-1 select-none opacity-60 blur-[5px]">
        <div className="flex flex-col gap-2 p-3.5 pt-10">
          <ul className={cn("flex flex-col divide-y", DIVIDE)}>
            {SAMPLE_FILES.map((f) => (
              <li key={f.name} className="flex items-center gap-3 py-2">
                <FileText className={cn("size-4", MUTED)} />
                <PersonText label={f.name} detail={[f.facts]} />
              </li>
            ))}
          </ul>
          <PeopleList people={SAMPLE_PEOPLE} open={null} onToggle={() => {}} />
        </div>
      </div>
      <div
        className={cn(
          "col-start-1 row-start-1 flex items-center justify-center p-4",
          "bg-gradient-to-b from-white/30 via-white/85 to-white dark:from-[#1c1c1c]/30 dark:via-[#1c1c1c]/85 dark:to-[#1c1c1c]",
        )}
      >
        <span className="absolute left-3 top-3 inline-flex h-5 items-center rounded-full border border-grey-80 bg-white px-2 text-[11px] font-medium text-grey-30 dark:border-[#494949] dark:bg-[#262626] dark:text-grey-dark-700">
          {SAMPLE_LABEL}
        </span>
        <div className="flex max-w-[290px] flex-col items-center gap-2 text-center">
          <span
            aria-hidden
            className="mb-1 flex size-[38px] items-center justify-center rounded-[11px] bg-primary-50/10 text-primary-50 dark:bg-primary-50/20 dark:text-primary-brand-dark"
          >
            <BarChart3 className="size-[18px]" />
          </span>
          <p className={cn("text-[14px] font-semibold", STRONG)}>{FOLDER_LOCK_TITLE}</p>
          <p className="text-[12.5px] leading-5 text-grey-30 dark:text-grey-dark-700">
            {notCounting ? FOLDER_LOCK_BODY_OFF : FOLDER_LOCK_BODY}
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
