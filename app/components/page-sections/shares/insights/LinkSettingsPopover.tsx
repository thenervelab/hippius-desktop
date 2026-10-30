"use client";

import { useCallback, useEffect, useId, useRef } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, MessageSquare, SmilePlus } from "lucide-react";
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
import { useEscapeFirst } from "@/components/page-sections/drive/share-dialog/RowConfirm";
import { linkSettingsQueryKey, PANEL_MUTATION, PANEL_QUERY } from "./queryKeys";
import { actionErrorLine, DEFINITIONS, loadErrorLine, switchPills } from "./insightsView";
import { LoadError } from "./LoadError";
import { FLOATING, FOCUS, HAIRLINE, MUTED, SKELETON, STRONG, TEXT_LINK } from "./panelStyles";

/** Marks what opens Link settings, so a press on it is not "outside". */
export const SETTINGS_TRIGGER_ATTR = "data-link-settings-trigger";

/**
 * A link's Insights, Comments and Reactions switches: what the status row
 * shows and what Link settings changes. Each change sends only the switch
 * flipped, shows at once, is put back if the server refuses it, and is then
 * read back from the server, so what shows is what the link has.
 */
export function useLinkSwitches(shareToken: string) {
  const queryClient = useQueryClient();
  const key = linkSettingsQueryKey(shareToken);
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
      if (before) queryClient.setQueryData<LinkSettingsDefault>(key, { ...before, on: { ...before.on, ...change } });
      return { before };
    },
    onError: (err, _change, ctx) => {
      if (ctx?.before) queryClient.setQueryData(key, ctx.before);
      toast.error(actionErrorLine("change that setting", err, navigator.onLine));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  return { current, save };
}

export type LinkSwitches = ReturnType<typeof useLinkSwitches>;

const PILL_ICON = { insights: BarChart3, comments: MessageSquare, reactions: SmilePlus } as const;

/**
 * The status row: a pill per switch, on or off. Off is said in words as well
 * as drawn muted, never by colour alone. Each pill opens Link settings.
 */
export function StatusPills({
  settings,
  popoverId,
  open,
  onOpen,
}: {
  settings: Pick<LinkSettingsDefault, "offered" | "on"> | null;
  popoverId: string;
  /** Link settings is open (the pills then point at it). */
  open: boolean;
  onOpen: (from: HTMLElement) => void;
}) {
  const pills = switchPills(settings);
  if (pills.length === 0) return null;
  return (
    <ul className="flex flex-wrap items-center gap-1.5" aria-label="On this link">
      {pills.map(({ key, label, on }) => {
        const Icon = PILL_ICON[key];
        return (
          <li key={key}>
            <button
              type="button"
              {...{ [SETTINGS_TRIGGER_ATTR]: "" }}
              aria-haspopup="dialog"
              aria-controls={open ? popoverId : undefined}
              aria-label={`${label} ${on ? "on" : "off"}. Change in Link settings`}
              data-state={on ? "on" : "off"}
              onClick={(e) => onOpen(e.currentTarget)}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11.5px] font-medium leading-none transition-colors",
                FOCUS,
                on
                  ? "border-primary-50/25 bg-primary-50/[0.08] text-primary-50 hover:bg-primary-50/[0.14] dark:border-primary-brand-dark/30 dark:bg-primary-brand-dark/[0.12] dark:text-primary-brand-dark"
                  : cn(
                      "border-dashed border-grey-70 bg-transparent hover:bg-grey-90 dark:border-white/20 dark:hover:bg-white/[0.06]",
                      MUTED,
                    ),
              )}
            >
              <Icon aria-hidden className="size-3" strokeWidth={2.25} />
              <span>{label}</span>
              {!on && <span className="font-semibold">off</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Link settings: the link's switches and "How we count views", in a popover
 * anchored under the panel header's gear. It is drawn inside the panel (not
 * portalled), so it sits within the narrow-window sheet's focus trap.
 * Escape, a press outside or the gear again closes it, and focus goes back
 * to whatever opened it.
 */
export function LinkSettingsPopover({
  id,
  switches,
  top,
  opener,
  onClose,
  onLeave,
}: {
  id: string;
  switches: LinkSwitches;
  /** Pixels from the panel's top: just under its header. */
  top: number;
  /** What opened it (the gear, a pill, a tab's Turn on), to give focus back to. */
  opener: React.MutableRefObject<HTMLElement | null>;
  onClose: () => void;
  /** Closes the whole panel (the upgrade prompt leaves for the plans page). */
  onLeave: () => void;
}) {
  const router = useRouter();
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const { current, save } = switches;
  const online = useIsOnline();

  // The panel hands a new `onClose` every render; the listeners read the latest.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const close = useCallback(() => {
    const panel = ref.current;
    const focused = document.activeElement;
    const lost = !focused || focused === document.body || (panel?.contains(focused) ?? false);
    onCloseRef.current();
    if (lost && opener.current?.isConnected) opener.current.focus({ preventScroll: true });
  }, [opener]);

  useEscapeFirst(ref, close);

  // Focus moves in once, when it opens: never again on a re-render (a switch
  // saving re-renders it, and focus must stay on that switch).
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (ref.current?.contains(target) || target.closest(`[${SETTINGS_TRIGGER_ATTR}]`)) return;
      onCloseRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  return (
    <div
      ref={ref}
      id={id}
      role="dialog"
      aria-labelledby={titleId}
      data-testid="link-settings"
      style={{ top, maxHeight: `calc(100% - ${top + 12}px)` }}
      onBlur={(e) => {
        // Tabbing out of it closes it, like any popover. A switch that turns
        // disabled while it saves blurs with nowhere to go: that stays open.
        const next = e.relatedTarget;
        if (next instanceof Node && !e.currentTarget.contains(next) && !(next instanceof Element && next.closest(`[${SETTINGS_TRIGGER_ATTR}]`))) {
          onCloseRef.current();
        }
      }}
      className={cn(
        "absolute right-3 z-30 flex w-[calc(100%-24px)] max-w-[320px] flex-col overflow-y-auto overscroll-contain p-3",
        FLOATING,
      )}
    >
      <h3 id={titleId} ref={titleRef} tabIndex={-1} className={cn("text-[13.5px] font-semibold outline-none", STRONG)}>
        Link settings
      </h3>
      <p className={cn("mb-2.5 mt-0.5 text-xs", MUTED)}>What people who open this link can do.</p>
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
          onUpgrade={() => {
            onLeave();
            router.push(BILLING_ROUTE);
          }}
        />
      ) : (
        <p className={cn("text-sm", MUTED)}>This server doesn&apos;t offer settings for links yet.</p>
      )}
      <div className={cn("mt-3 border-t pt-2.5", HAIRLINE)}>
        <HowWeCountViews />
      </div>
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
        {...{ [SETTINGS_TRIGGER_ATTR]: "" }}
        aria-haspopup="dialog"
        onClick={(e) => onTurnOn(e.currentTarget)}
        className={cn(TEXT_LINK, "shrink-0 whitespace-nowrap")}
      >
        Turn on
      </button>
    </div>
  );
}
