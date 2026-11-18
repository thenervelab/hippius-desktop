"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { SHARES_QUERY_KEY } from "@/app/lib/hooks/useSharedFiles";
import { getGroupInsights, revokeRecipientLink, type GroupPerson } from "@/app/lib/tauri/shareRecipients";
import { actionErrorLine, loadErrorLine } from "./insightsView";
import { InsightsAvatar } from "./InsightsAvatar";
import { LoadError } from "./LoadError";
import { groupInsightsQueryKey, PANEL_QUERY } from "./queryKeys";
import { DIVIDE, FOCUS, MUTED, STRONG } from "./panelStyles";

export const YOUR_LINK = "Your link";
export const UNNAMED_LINK = "Unnamed link";
export const NAMES_HIDDEN = "Some names can't be opened on this computer.";
export const OVER_BUDGET = "This file has a lot of views, so only the counts are shown.";

/** The row's one line of numbers: views, viewers and pages. */
export function personFacts(p: Pick<GroupPerson, "views" | "viewers" | "pages">): string {
  return [p.views === 1 ? "1 view" : `${p.views} views`, p.viewers === 1 ? "1 viewer" : `${p.viewers} viewers`, p.pages]
    .filter(Boolean)
    .join(" · ");
}

export function personName(p: Pick<GroupPerson, "recipient" | "name">): string {
  return p.recipient ? (p.name ?? UNNAMED_LINK) : YOUR_LINK;
}

/**
 * Insights grouped by person for the link's file: one row per live link of
 * its group, read every 30 s while the group has more than one link. `shown`
 * is whether the panel has a People tab (Rust's `offered`).
 */
export function useGroupInsights(shareToken: string) {
  const query = useQuery({
    queryKey: groupInsightsQueryKey(shareToken),
    queryFn: () => getGroupInsights(shareToken),
    refetchInterval: (q) => (q.state.data?.offered ? 30_000 : false),
    ...PANEL_QUERY,
  });
  return { query, shown: query.data?.offered === true, count: query.data?.people.length ?? null };
}

export type GroupInsightsState = ReturnType<typeof useGroupInsights>;

/**
 * The People tab: each person the file went to, with their views, viewers,
 * how far they read a document and the emails they proved, plus the file's
 * own link. A person's link can be revoked here; the others keep working.
 */
export function PeopleTab({ state }: { state: GroupInsightsState }) {
  const { query } = state;
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  if (query.isError) {
    return <LoadError line={loadErrorLine("load people", query.error, navigator.onLine)} onRetry={() => void query.refetch()} />;
  }
  const data = query.data;
  if (!data) return null;

  const revoke = async (person: GroupPerson) => {
    setRevoking(person.shareToken);
    try {
      await revokeRecipientLink(person.shareToken);
      toast.success(`Link for ${personName(person)} revoked`);
      setConfirming(null);
      void queryClient.invalidateQueries({ queryKey: ["share-group-insights"] });
      void queryClient.invalidateQueries({ queryKey: [SHARES_QUERY_KEY] });
    } catch (err) {
      toast.error(actionErrorLine("revoke the link", err, navigator.onLine));
    } finally {
      setRevoking(null);
    }
  };

  return (
    <section aria-label="People" className="flex flex-col gap-3" data-testid="people-tab">
      {(data.namesHidden || data.overVisitBudget) && (
        <p className={cn("text-xs", MUTED)}>{[data.namesHidden && NAMES_HIDDEN, data.overVisitBudget && OVER_BUDGET].filter(Boolean).join(" ")}</p>
      )}
      <ul className={cn("flex flex-col divide-y", DIVIDE)}>
        {data.people.map((person) => {
          const name = personName(person);
          const emails = person.emails.join(", ");
          return (
            <li key={person.shareToken} data-testid="people-row" className="flex min-w-0 items-center gap-3 py-3">
              <InsightsAvatar name={person.recipient ? person.name : null} size="md" />
              <div className="grid min-w-0 flex-1 gap-0.5">
                <span className={cn("truncate text-[13px] font-semibold", STRONG)} title={name}>
                  {name}
                </span>
                <span className={cn("truncate text-xs", MUTED)}>{personFacts(person)}</span>
                {emails && (
                  <span className={cn("truncate text-xs", MUTED)} title={emails} data-testid="people-emails">
                    {emails}
                  </span>
                )}
              </div>
              {person.recipient &&
                (confirming === person.shareToken ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      disabled={revoking === person.shareToken}
                      onClick={() => void revoke(person)}
                      className={cn("rounded px-2 py-1 text-[13px] font-medium text-error-50 hover:bg-error-50/10 dark:text-error-70", FOCUS)}
                    >
                      Revoke
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(null)}
                      className={cn("rounded px-2 py-1 text-[13px] font-medium hover:bg-grey-90 dark:hover:bg-white/10", STRONG, FOCUS)}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label={`Revoke link for ${name}`}
                    onClick={() => setConfirming(person.shareToken)}
                    className={cn(
                      "shrink-0 rounded px-2 py-1 text-[13px] font-medium hover:bg-grey-90 hover:text-grey-10 dark:hover:bg-white/10 dark:hover:text-white",
                      MUTED,
                      FOCUS,
                    )}
                  >
                    Revoke
                  </button>
                ))}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
