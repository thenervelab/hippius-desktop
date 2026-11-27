"use client";

import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronDown, Download, FileCheck } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { getNdaAccepts, type NdaAccept, type NdaAccepts } from "@/app/lib/tauri/shareNda";
import type { LinkKind } from "@/app/lib/tauri/shareGate";
import { PersonName } from "./CommentThreads";
import { EmptyLine } from "./EmptyLine";
import { InsightsAvatar } from "./InsightsAvatar";
import { ndaAcceptsQueryKey, PANEL_QUERY } from "./queryKeys";
import { saveNdaAcceptsCsv, saveNdaRecord } from "./exportNda";
import { actionErrorLine } from "./insightsView";
import { useIsOnline } from "@/app/lib/hooks/useIsOnline";
import { HAIRLINE, MUTED, RING, STRONG, TEXT_LINK } from "./panelStyles";

export const NDA_TAB = "NDA";
export const EARLIER_TEXT = "Earlier text";
export const NO_ACCEPTS = "No one has accepted yet";
export const TEXT_NOT_HERE = "This text can't be opened here.";
export const EXPORT_ACCEPTS = "Export";
export const RECORD = "Record";

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
export function useNdaAccepts(shareToken: string, kind: LinkKind = "file") {
  const query = useInfiniteQuery({
    queryKey: ndaAcceptsQueryKey(shareToken, kind),
    queryFn: ({ pageParam }) => getNdaAccepts(shareToken, pageParam, kind),
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
 * The NDA tab: the link's current text, then a table of who accepted and
 * when, newest first. A person shows by the name they typed when they
 * accepted, else the email they proved on a link that asks for one (Rust
 * shows it only when it matches the server's check), else by the name the
 * Viewers tab gives them, else as an anonymous viewer. An
 * accept of a text the owner has since replaced says so.
 *
 * Export saves every accept as CSV, and each accept has a Record: both built
 * and written by Rust where the owner chooses, through the native save
 * dialog, in the console's layout. An accept of the current text needs that
 * text open here; an earlier text's record says the text is not kept.
 */
export function NdaTab({
  state,
  viewerNames,
  shareToken,
  fileName,
  kind = "file",
}: {
  state: NdaAcceptsState;
  /** The Viewers tab's names, by viewer id. */
  viewerNames: Readonly<Record<string, string | null>>;
  /** A file link's token, or a folder link's token hash. */
  shareToken: string;
  fileName: string;
  kind?: LinkKind;
}) {
  const { query, pages } = state;
  const first = pages[0] ?? null;
  const accepts = useMemo(() => acceptsNewestFirst(pages), [pages]);
  const online = useIsOnline();
  // What is being saved: the export, or one accept's record by id.
  const [saving, setSaving] = useState<"export" | number | null>(null);

  const run = (what: "export" | number, doing: string, done: string, task: () => Promise<"saved" | "cancelled">) => {
    if (saving !== null) return;
    setSaving(what);
    task()
      .then((outcome) => {
        if (outcome === "saved") toast.success(done);
      })
      .catch((err: unknown) => toast.error(actionErrorLine(doing, err, online)))
      .finally(() => setSaving(null));
  };

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
        <div className="mb-1 flex items-center justify-between gap-3">
          <h3 className={cn("text-[13px] font-semibold", STRONG)}>Accepted</h3>
          {accepts.length > 0 && (
            <button
              type="button"
              className={TEXT_LINK}
              disabled={saving !== null}
              onClick={() =>
                run("export", "export the accepts", "Accepts saved as CSV", () => saveNdaAcceptsCsv(shareToken, fileName, viewerNames, kind))
              }
            >
              <Download aria-hidden className="size-[13px]" />
              {EXPORT_ACCEPTS}
            </button>
          )}
        </div>
        {accepts.length === 0 ? (
          <EmptyLine icon={<FileCheck />} text={NO_ACCEPTS} />
        ) : (
          // A narrow panel (a phone-width window) folds the time under the
          // name, so names keep their room; nothing scrolls sideways.
          <div className="@container">
          <table className="w-full table-fixed border-collapse text-left" aria-label="Accepted">
            <thead>
              <tr className={cn("border-b text-xs", HAIRLINE, MUTED)}>
                <th scope="col" className="py-2 pr-2 font-medium">
                  Name
                </th>
                <th scope="col" className="hidden w-[38%] py-2 pr-2 font-medium @sm:table-cell">
                  Accepted
                </th>
                <th scope="col" className="w-[76px] py-2">
                  <span className="sr-only">{RECORD}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {accepts.map((a) => {
                const name = a.signerName ?? a.email ?? viewerNames[a.viewerId] ?? null;
                const recordable = a.earlier || first?.text != null;
                return (
                  <tr key={a.id} data-testid="nda-accept" className={cn("border-b last:border-b-0", HAIRLINE)}>
                    <td className="py-2.5 pr-2 align-middle">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <InsightsAvatar name={name} size="md" />
                        <div className="min-w-0 flex-1">
                          <PersonName name={name} className="min-w-0 text-[13px]" />
                          <p className={cn("truncate text-xs @sm:hidden", MUTED)}>
                            {formatAcceptedAt(a.acceptedAt)}
                            {a.earlier && ` · ${EARLIER_TEXT}`}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="hidden py-2.5 pr-2 align-middle @sm:table-cell">
                      <p className="truncate text-xs text-grey-20 dark:text-grey-dark-800">{formatAcceptedAt(a.acceptedAt)}</p>
                      {a.earlier && <p className={cn("truncate text-xs", MUTED)}>{EARLIER_TEXT}</p>}
                    </td>
                    <td className="py-2.5 text-right align-middle">
                      {recordable && (
                        <button
                          type="button"
                          className={cn(TEXT_LINK, "ml-auto")}
                          aria-label={`${RECORD} for ${name ?? "this accept"}`}
                          disabled={saving !== null}
                          onClick={() =>
                            run(a.id, "save the record", "Record saved", () => saveNdaRecord(shareToken, fileName, a.id, kind))
                          }
                        >
                          {RECORD}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
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
