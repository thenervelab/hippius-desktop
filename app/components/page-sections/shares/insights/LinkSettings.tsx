"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { BILLING_ROUTE } from "@/app/lib/routes";
import {
  getLinkSettings,
  setLinkSettings,
  switchChange,
  type LinkSettingsChange,
  type LinkSettingsDefault,
} from "@/app/lib/tauri/shareInsights";
import { useIsOnline } from "@/app/lib/hooks/useIsOnline";
import LinkEngagementSwitches from "@/components/page-sections/drive/LinkEngagementSwitches";
import RecipientLinks from "./RecipientLinks";
import { LinkRules } from "@/components/page-sections/shares/rules/LinkRules";
import type { ShareSummary, ShareTtl } from "@/app/lib/tauri/shares";
import { setShareExpiryDate, updateShareExpiry } from "@/app/lib/tauri/shares";
import { SHARES_QUERY_KEY } from "@/app/lib/hooks/useSharedFiles";
import { LinkVisitEmailsSelect } from "@/components/page-sections/drive/SecureLinkSection";
import { linkSettingsQueryKey, PANEL_MUTATION, PANEL_QUERY } from "./queryKeys";
import { actionErrorLine, DEFINITIONS, isDownloadNotInPlan, isWatermarkNotInPlan, loadErrorLine } from "./insightsView";
import { LoadError } from "./LoadError";
import { HAIRLINE, MUTED, SKELETON, TEXT_LINK } from "./panelStyles";

/**
 * A link's Insights, Comments and Reactions switches (and Allow download,
 * where the server has it): what the header's line says and what Link
 * settings changes. Each change sends only the switch flipped, shows at
 * once, is put back if the server refuses it, and is then read back from the
 * server, so what shows is what the link has. Turning downloads off refused
 * for the plan shows the upgrade prompt (`downloadRefused`), not a toast.
 */
export function useLinkSwitches(shareToken: string) {
  const queryClient = useQueryClient();
  const key = linkSettingsQueryKey(shareToken);
  const [downloadRefused, setDownloadRefused] = useState(false);
  const [watermarkRefused, setWatermarkRefused] = useState(false);
  const current = useQuery({
    queryKey: key,
    queryFn: () => getLinkSettings(shareToken),
    ...PANEL_QUERY,
  });
  const save = useMutation({
    ...PANEL_MUTATION,
    mutationFn: (change: LinkSettingsChange) => setLinkSettings(shareToken, change),
    onMutate: async (change) => {
      // A read still in flight would land over the change shown here.
      await queryClient.cancelQueries({ queryKey: key });
      const before = queryClient.getQueryData<LinkSettingsDefault>(key);
      if (before) {
        const { download, watermark, ...switches } = change;
        queryClient.setQueryData<LinkSettingsDefault>(key, {
          ...before,
          on: { ...before.on, ...switches },
          download: download ?? before.download,
          watermark: watermark ?? before.watermark,
        });
      }
      setDownloadRefused(false);
      setWatermarkRefused(false);
      return { before };
    },
    onError: (err, _change, ctx) => {
      if (ctx?.before) queryClient.setQueryData(key, ctx.before);
      if (isDownloadNotInPlan(err)) {
        setDownloadRefused(true);
        return;
      }
      if (isWatermarkNotInPlan(err)) {
        setWatermarkRefused(true);
        return;
      }
      toast.error(actionErrorLine("change that setting", err, navigator.onLine));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  return { current, save, downloadRefused, watermarkRefused };
}

export type LinkSwitches = ReturnType<typeof useLinkSwitches>;

/**
 * A file link's Link settings, drawn in the side panel's Link settings view
 * (`LinkSettingsView`): the Unlock line once at the top while the Drive is
 * locked, the link's rules (short ones as rows with their control, Allow
 * list and NDA a level further in), the Insights, Comments and Reactions
 * switches, "Emails about this link", Links per person and "How we count
 * views". While a rule's own level is open only its editor shows.
 */
export function FileLinkSettings({
  shareToken,
  fileName,
  share,
  switches,
  onLeave,
}: {
  /** The link these settings are for. */
  shareToken: string;
  fileName: string;
  /** The link's row in the share listing, for its expiry and password. */
  share: ShareSummary | null;
  switches: LinkSwitches;
  /** Closes the whole panel (the upgrade prompt leaves for the plans page). */
  onLeave: () => void;
}) {
  const router = useRouter();
  const { current, save, downloadRefused, watermarkRefused } = switches;
  const online = useIsOnline();
  const queryClient = useQueryClient();
  // A rule's editor is open in place of everything else.
  const [pushed, setPushed] = useState(false);
  const [expirySaving, setExpirySaving] = useState(false);
  const [ttl, setTtl] = useState<ShareTtl | null>(null);
  const changeExpiry = (next: ShareTtl) => {
    if (expirySaving) return;
    const before = ttl;
    setTtl(next);
    setExpirySaving(true);
    updateShareExpiry(shareToken, next)
      .then(() => queryClient.invalidateQueries({ queryKey: [SHARES_QUERY_KEY] }))
      .catch((err: unknown) => {
        setTtl(before);
        toast.error(actionErrorLine("change the expiry", err, navigator.onLine));
      })
      .finally(() => setExpirySaving(false));
  };
  // A chosen end date in place of a preset.
  const changeExpiryDate = (day: string) => {
    if (expirySaving) return;
    setExpirySaving(true);
    setShareExpiryDate(shareToken, day)
      .then(() => {
        setTtl(null);
        return queryClient.invalidateQueries({ queryKey: [SHARES_QUERY_KEY] });
      })
      .catch((err: unknown) => toast.error(actionErrorLine("change the expiry", err, navigator.onLine)))
      .finally(() => setExpirySaving(false));
  };
  const upgrade = () => {
    onLeave();
    router.push(BILLING_ROUTE);
  };
  // Views are counted unless the link has Insights turned off; a server
  // without the switch counts as it always did.
  const viewsCounted = !(current.data?.offered.insights === true && !current.data.on.insights);

  return (
    <div className="flex flex-col gap-3">
      {/* The link's rules; a long rule's editor opens in their place. */}
      <LinkRules
        shareToken={shareToken}
        fileName={fileName}
        mimeType={share?.mimeType ?? null}
        download={current.data?.download ?? null}
        onDownloadChange={(download) => save.mutate({ download })}
        downloadRefused={downloadRefused}
        watermark={current.data?.watermark ?? null}
        onWatermarkChange={(watermark) => save.mutate({ watermark })}
        watermarkRefused={watermarkRefused}
        savingSwitches={save.isPending}
        switchesInPlan={current.data?.switchesInPlan ?? null}
        expiresAt={share ? share.expiresAt : undefined}
        expiry={share ? { ttl, saving: expirySaving, onChange: changeExpiry, onDate: changeExpiryDate } : null}
        // Known only where this computer holds the link's key.
        passwordOn={share?.shareUrl ? share.isPrivate : null}
        onUpgrade={upgrade}
        onPushedChange={setPushed}
      />
      {!pushed && (
        <>
          {current.isPending ? (
            <div className={cn(SKELETON, "h-[150px] rounded-[12px]")} />
          ) : current.isError ? (
            <LoadError line={loadErrorLine("this link's settings", current.error, online)} onRetry={() => void current.refetch()} />
          ) : current.data.offered.insights ? (
            <LinkEngagementSwitches
              layout="list"
              offered={current.data.offered}
              value={current.data.on}
              disabled={save.isPending}
              switchesInPlan={current.data.switchesInPlan ?? null}
              onChange={(next) => save.mutate(switchChange(current.data.on, next))}
              onUpgrade={upgrade}
            />
          ) : (
            <p className={cn("text-sm", MUTED)}>This server doesn&apos;t offer settings for links yet.</p>
          )}
          {/* Every file link, counting views or not: None also stops its
              NDA and refused viewer emails. Drawn only where Rust has it. */}
          <div className="empty:hidden">
            <LinkVisitEmailsSelect shareToken={shareToken} viewsCounted={viewsCounted} layout="list" />
          </div>
          {/* Drawn only where Rust offers it: a server with links per person. */}
          <div className="empty:hidden">
            <RecipientLinks layout="list" shareToken={shareToken} onUpgrade={upgrade} />
          </div>
          <div className={cn("border-t pt-2.5", HAIRLINE)}>
            <HowWeCountViews />
          </div>
        </>
      )}
    </div>
  );
}

/** What each number means, opened in place: there is no help page for it yet. */
export function HowWeCountViews() {
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

/**
 * The one line a tab shows while its switch is off, with Turn on, which
 * opens Link settings (where a free plan gets the upgrade prompt instead).
 */
export function SwitchOffNotice({ line, onTurnOn }: { line: string; onTurnOn: (from: HTMLElement) => void }) {
  return (
    <div className={cn("mb-3 flex items-center justify-between gap-3 rounded-[10px] px-3 py-2", "bg-[#0000000A] dark:bg-white/[0.04]")}>
      <p className={cn("min-w-0 text-xs leading-[1.45]", MUTED)}>{line}</p>
      <button
        type="button"
        onClick={(e) => onTurnOn(e.currentTarget)}
        className={cn(TEXT_LINK, "shrink-0 whitespace-nowrap")}
      >
        Turn on
      </button>
    </div>
  );
}
