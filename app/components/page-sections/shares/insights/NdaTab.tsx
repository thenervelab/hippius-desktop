"use client";

import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronDown, FileCheck } from "lucide-react";

import { cn } from "@/lib/utils";
import { getNdaAccepts, type NdaAccept, type NdaAccepts } from "@/app/lib/tauri/shareNda";
import { PersonName } from "./CommentThreads";
import { EmptyLine } from "./EmptyLine";
import { InsightsAvatar } from "./InsightsAvatar";
import { ndaAcceptsQueryKey, PANEL_QUERY } from "./queryKeys";
import { DIVIDE, MUTED, RING, STRONG, TEXT_LINK } from "./panelStyles";

export const NDA_TAB = "NDA";
export const EARLIER_TEXT = "Earlier text";
export const NO_ACCEPTS = "No one has accepted yet";
export const TEXT_NOT_HERE = "This text can't be opened here.";

/** "Nov 10, 2026, 12:03 PM" in the owner's own zone. */
export function formatAcceptedAt(rfc3339: string): string {
  const t = Date.parse(rfc3339);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Every accept the pages hold, newest first. The server lists them oldest first. */
export function acceptsNewestFirst(pages: readonly NdaAccepts[]): NdaAccept[] {
  return pages
    .flatMap((p) => p.accepts)
    .sort((a, b) => (Date.parse(b.acceptedAt) || 0) - (Date.parse(a.acceptedAt) || 0) || b.id - a.id);
}

/**
 * A link's NDA text and its accepts, a page of up to 500 at a time, refreshed
 * every 30 s while the panel is open. `shown` is whether the panel has an NDA
 * tab: the server has NDA texts and the link has a text or any accepts.
 */
export function useNdaAccepts(shareToken: string) {
  const query = useInfiniteQuery({
    queryKey: ndaAcceptsQueryKey(shareToken),
    queryFn: ({ pageParam }) => getNdaAccepts(shareToken, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last: NdaAccepts) => last.nextAfter ?? undefined,
    refetchInterval: 30_000,
    ...PANEL_QUERY,
  });
  const pages = query.data?.pages ?? [];
  const first = pages[0] ?? null;
  const count = pages.reduce((n, p) => n + p.accepts.length, 0);
  const shown = first !== null && first.offered && (first.hasText || count > 0);
  return { query, pages, shown, count };
}

export type NdaAcceptsState = ReturnType<typeof useNdaAccepts>;

/**
 * The NDA tab: the link's current text, then who accepted and when, newest
 * first. A person shows by the email they proved on a link that asks for one
 * (Rust shows it only when it matches the server's check), else by the name
 * the Viewers tab gives them, else as an anonymous viewer. An accept of a
 * text the owner has since replaced says so.
 */
export function NdaTab({
  state,
  viewerNames,
}: {
  state: NdaAcceptsState;
  /** The Viewers tab's names, by viewer id. */
  viewerNames: Readonly<Record<string, string | null>>;
}) {
  const { query, pages } = state;
  const first = pages[0] ?? null;
  const accepts = useMemo(() => acceptsNewestFirst(pages), [pages]);

  return (
    <div className="flex flex-col gap-5" data-testid="nda-tab">
      {first?.hasText && (
        <section aria-label="NDA text">
          <h3 className={cn("mb-2 text-[13px] font-semibold", STRONG)}>Text</h3>
          {first.text !== null ? (
            <div
              tabIndex={0}
              data-testid="nda-current-text"
              className={cn(
                "max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-[10px] px-3 py-2 text-[13px] outline-none",
                RING,
                "text-grey-20 dark:text-grey-dark-800",
              )}
            >
              {first.text}
            </div>
          ) : (
            <p className={cn("text-xs", MUTED)}>{TEXT_NOT_HERE}</p>
          )}
        </section>
      )}
      <section aria-label="Accepted">
        <h3 className={cn("mb-1 text-[13px] font-semibold", STRONG)}>Accepted</h3>
        {accepts.length === 0 ? (
          <EmptyLine icon={<FileCheck />} text={NO_ACCEPTS} />
        ) : (
          <ul className={cn("flex flex-col divide-y", DIVIDE)} aria-label="Accepted">
            {accepts.map((a) => {
              const name = a.email ?? viewerNames[a.viewerId] ?? null;
              return (
                <li key={a.id} data-testid="nda-accept" className="flex min-w-0 items-center gap-3 py-3">
                  <InsightsAvatar name={name} size="md" />
                  <div className="min-w-0 flex-1">
                    <PersonName name={name} className="text-[13px]" />
                    <p className={cn("mt-px truncate text-xs", MUTED)}>
                      {formatAcceptedAt(a.acceptedAt)}
                      {a.earlier && ` · ${EARLIER_TEXT}`}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {query.hasNextPage && (
          <button
            type="button"
            className={cn(TEXT_LINK, "mt-2")}
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            <ChevronDown aria-hidden className="size-[13px]" />
            Show more
          </button>
        )}
      </section>
    </div>
  );
}
