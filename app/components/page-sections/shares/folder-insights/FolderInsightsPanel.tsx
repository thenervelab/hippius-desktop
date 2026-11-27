"use client";

// The owner's Insights for one folder link (a document room): how often its
// files were opened and by how many people, which files (a document's pages
// and the time on them), and who opened what. Export CSV saves the same
// activity, one row per person and file. The link's one switch, Insights on
// or off, sits in Link settings.
//
// Opened from a folder link's row on Shared Links (`folderInsightsAtom`), in
// the side panels' one slot (`SidePanel`), so it closes File Details, the
// file link's Insights and Manage access. Read by the listing's token hash,
// so it works for a link made on another device. Every number, and whether
// it is locked, comes from Rust.
//
// The header's gear opens Link settings as a view of the same panel
// (`LinkSettingsView`, as for a file link): the Insights switch, then the
// link's rules (`FolderLinkRules`): Ask for email as a row, Allow list and
// NDA a level further in, where the server has them for folder links. A
// link with an NDA text, or any accepts, gets an NDA tab of who accepted.

import { useId, useMemo, useRef, useState } from "react";
import { useAtom } from "jotai";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, Settings, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { SidePanel } from "@/components/ui/SidePanel";
import TabList from "@/components/ui/tabs/TabList";
import TabPanel from "@/components/ui/tabs/TabPanel";
import { SettingsToggle } from "@/app/components/page-sections/settings/SettingsToggle";
import { cn } from "@/lib/utils";
import { BILLING_ROUTE } from "@/app/lib/routes";
import { useIsOnline } from "@/app/lib/hooks/useIsOnline";
import { getFolderInsights, setFolderInsights, type FolderInsights } from "@/app/lib/tauri/folderInsights";
import { LoadError } from "@/components/page-sections/shares/insights/LoadError";
import {
  actionErrorLine,
  headerLine,
  loadErrorLine,
  tabLabel,
  UPGRADE_PLAN,
} from "@/components/page-sections/shares/insights/insightsView";
import { CARD, FILL, HAIRLINE, ICON_BUTTON, MUTED, RING, SKELETON, STRONG } from "@/components/page-sections/shares/insights/panelStyles";
import { PANEL_MUTATION, PANEL_QUERY } from "@/components/page-sections/shares/insights/queryKeys";
import { NdaTab, NDA_TAB, useNdaAccepts } from "@/components/page-sections/shares/insights/NdaTab";
import { FolderLinkRules } from "@/components/page-sections/shares/rules/LinkRules";
import {
  LINK_SETTINGS,
  LinkSettingsView,
  PanelViews,
  SETTINGS_TRIGGER_ATTR,
} from "@/components/page-sections/shares/insights/LinkSettingsView";
import {
  folderLinkViewKey,
  useLinkSettingsView,
} from "@/components/page-sections/shares/insights/linkSettingsViewState";
import { saveFolderInsightsCsv } from "./exportFolderCsv";
import { FolderFilesTab, FolderLocked, FolderPeopleTab, type FolderInsightsTab } from "./FolderInsightsBody";
import {
  folderInsightsAtom,
  folderInsightsQueryKey,
  LINK_ACTIVITY_QUERY_KEY,
  type FolderInsightsTarget,
} from "./folderInsightsTarget";

export const FOLDER_INSIGHTS_PANEL_WIDTH_PX = 400;
/** Where the width the owner dragged the panel to is kept. */
export const FOLDER_INSIGHTS_PANEL_WIDTH_KEY = "hippius:folder-insights-panel-width";

/** The switch's line, by plan. */
export const SWITCH_LINE = "Count views of the files in this folder. Viewers see a short note.";
export const SWITCH_LINE_FREE = "Count views of the files in this folder. On paid Drive plans.";
/** Shown under the switch when turning it on needs a paid plan. */
export const SWITCH_NEEDS_PLAN = "Insights for folder links are available on paid Drive plans.";

export default function FolderInsightsPanel() {
  const [target, setTarget] = useAtom(folderInsightsAtom);
  const onClose = () => setTarget(null);
  return (
    <SidePanel
      open={target !== null}
      onClose={onClose}
      width={FOLDER_INSIGHTS_PANEL_WIDTH_PX}
      resizable={{ storageKey: FOLDER_INSIGHTS_PANEL_WIDTH_KEY }}
      label={target ? `Insights for ${target.name}` : "Insights"}
      focusKey={target?.tokenHash}
    >
      {target && <PanelFor key={target.tokenHash} target={target} onClose={onClose} />}
    </SidePanel>
  );
}

/** The header's line: "Shared Nov 3 · link on · Insights off". */
export function folderSubtitle(target: FolderInsightsTarget, insightsOn: boolean | null, now: number = Date.now()): string {
  const base = headerLine({ sharedAt: target.createdAt, durationMs: null, expiresAt: target.expiresAt, now });
  const parts = [target.revoked ? base.replace(/link (on|expired)$/, "link revoked") : base];
  if (insightsOn === false && !target.revoked) parts.push("Insights off");
  return parts.filter(Boolean).join(" · ");
}

function PanelFor({ target, onClose }: { target: FolderInsightsTarget; onClose: () => void }) {
  const tabsId = useId();
  const online = useIsOnline();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<FolderInsightsTab | "nda">("files");
  const [insightsOn, setInsightsOn] = useState<boolean | null>(target.insightsOn);
  const [exporting, setExporting] = useState(false);
  // Link settings, a view of this panel, kept open or not per link.
  const settingsView = useLinkSettingsView(folderLinkViewKey(target.tokenHash));
  const settingsOpener = useRef<HTMLElement | null>(null);
  const settingsOpen = settingsView.isOpen && !target.revoked;
  const ndaAccepts = useNdaAccepts(target.tokenHash, "folder");

  const insights = useQuery({
    queryKey: folderInsightsQueryKey(target.tokenHash),
    queryFn: () => getFolderInsights(target.tokenHash),
    ...PANEL_QUERY,
  });
  const data: FolderInsights | null = insights.data ?? null;
  // A free plan's link that counts nothing has no numbers at all: the
  // upgrade prompt over a sample, not a row of zeros.
  const countsNothing = data !== null && data.plan === "free" && insightsOn === false && data.totalViews === 0;
  const canExport = data !== null && data.people.state === "shown" && data.people.value.length > 0;

  const exportCsv = async () => {
    setExporting(true);
    try {
      if ((await saveFolderInsightsCsv(target.tokenHash, target.name)) === "saved") toast.success("CSV saved");
    } catch (err) {
      toast.error(actionErrorLine("export the CSV", err, online));
    } finally {
      setExporting(false);
    }
  };

  // Folder viewers are anonymous: an accept without a typed name shows by
  // the label the People tab gives the same viewer.
  const viewerNames = useMemo(() => {
    const names: Record<string, string | null> = {};
    if (data?.people.state === "shown") for (const p of data.people.value) names[p.viewerId] = p.label;
    return names;
  }, [data]);
  const activeTab = tab === "nda" && !ndaAccepts.shown ? "files" : tab;

  const tabs = data
    ? [
        { tabKey: "files", tabName: tabLabel("Files", data.files.length) },
        { tabKey: "people", tabName: tabLabel("People", data.people.state === "shown" ? data.people.value.length : null) },
        ...(ndaAccepts.shown ? [{ tabKey: "nda", tabName: tabLabel(NDA_TAB, ndaAccepts.count) }] : []),
      ]
    : [];

  const insightsBase = (
    <>
      <header className="shrink-0 px-6 pt-5">
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1 pr-1">
            <h2
              tabIndex={-1}
              data-panel-autofocus={!settingsOpen || undefined}
              title={target.name}
              className={cn("line-clamp-2 break-words text-[16px] font-semibold leading-[22px] tracking-[-0.2px] outline-none", STRONG)}
            >
              <span className="sr-only">Insights for </span>
              <bdi>{target.name}</bdi>
            </h2>
            <p className={cn("mt-1 text-[13px] leading-[18px]", MUTED)} data-testid="folder-insights-subtitle">
              {folderSubtitle(target, insightsOn)}
            </p>
          </div>
          {canExport && (
            <button
              type="button"
              aria-label="Export CSV"
              title="Export CSV"
              disabled={exporting}
              onClick={() => void exportCsv()}
              className={ICON_BUTTON}
            >
              {exporting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />}
            </button>
          )}
          {!target.revoked && (
            <button
              type="button"
              {...{ [SETTINGS_TRIGGER_ATTR]: "" }}
              aria-label={LINK_SETTINGS}
              onClick={(e) => {
                settingsOpener.current = e.currentTarget;
                settingsView.show();
              }}
              className={ICON_BUTTON}
            >
              <Settings className="size-4" aria-hidden />
            </button>
          )}
          <button type="button" aria-label="Close" onClick={onClose} className={ICON_BUTTON}>
            <X className="size-4" />
          </button>
        </div>
      </header>

      {insights.isPending ? (
        <div className="min-h-0 flex-1 px-6 pt-5" data-testid="folder-insights-loading" aria-busy="true">
          <div className={cn(SKELETON, "h-[68px] rounded-[10px]")} />
          <div className={cn(SKELETON, "mt-5 h-[30px] rounded-[9px]")} />
          {[0, 1, 2].map((i) => (
            <div key={i} className={cn(SKELETON, "mt-3 h-10")} />
          ))}
        </div>
      ) : insights.isError ? (
        <div className="px-6 pt-5">
          <LoadError line={loadErrorLine("insights", insights.error, online)} onRetry={() => void insights.refetch()} />
        </div>
      ) : countsNothing ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-5">
          <FolderLocked notCounting onUpgrade={onClose} />
        </div>
      ) : (
        data && (
          <>
            <section aria-label="Summary" className="shrink-0 px-6 pt-5">
              <dl className={cn("grid grid-cols-3 rounded-[10px]", RING)} data-testid="folder-insights-summary">
                {[
                  { label: "Views", value: data.totalViews },
                  { label: "Viewers", value: data.uniqueViewers },
                  { label: "Files", value: data.files.length },
                ].map(({ label, value }, i) => (
                  <div key={label} className={cn("flex min-w-0 flex-col-reverse px-3.5 py-3", i > 0 && cn("border-l", HAIRLINE))}>
                    <dt className={cn("mt-0.5 truncate text-xs", MUTED)}>{label}</dt>
                    <dd className={cn("truncate text-[22px] font-semibold leading-7 tracking-[-0.4px] tabular-nums", STRONG)}>{value}</dd>
                  </div>
                ))}
              </dl>
            </section>
            <div className="shrink-0 px-6 pt-5">
              <TabList
                idBase={tabsId}
                ariaLabel="Insights"
                tabs={tabs}
                activeTab={activeTab}
                onTabChange={(key) => {
                  setTab(key as FolderInsightsTab | "nda");
                  scrollRef.current?.scrollTo?.({ top: 0 });
                }}
                className={cn("flex w-full rounded-[9px] p-[3px]", FILL)}
                gap="gap-[3px]"
                width="min-w-0 flex-1"
                height="h-[30px]"
                tabItemPaddingX="px-1.5"
                textClassName="text-[13px] font-medium"
                showTooltip={false}
              />
            </div>
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-3" data-testid="folder-insights-body">
              <TabPanel idBase={tabsId} tabKey="files" activeTab={activeTab}>
                <FolderFilesTab insights={data} />
              </TabPanel>
              <TabPanel idBase={tabsId} tabKey="people" activeTab={activeTab}>
                <FolderPeopleTab insights={data} notCounting={insightsOn === false} onUpgrade={onClose} />
              </TabPanel>
              {ndaAccepts.shown && (
                <TabPanel idBase={tabsId} tabKey="nda" activeTab={activeTab}>
                  <NdaTab state={ndaAccepts} viewerNames={viewerNames} shareToken={target.tokenHash} fileName={target.name} kind="folder" />
                </TabPanel>
              )}
            </div>
          </>
        )
      )}
    </>
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden font-geist" data-testid="folder-insights-panel">
      <PanelViews
        open={settingsOpen}
        opener={settingsOpener}
        base={insightsBase}
        settings={
          <LinkSettingsView view={settingsView}>
            <FolderLinkSettings target={target} insightsOn={insightsOn} plan={data?.plan ?? null} onInsightsChange={setInsightsOn} onLeave={onClose} />
          </LinkSettingsView>
        }
      />
    </div>
  );
}

/**
 * A folder link's Link settings: its Insights switch, then its rules (Ask
 * for email as a row; Allow list and NDA open a level further in, and while
 * one is open only its editor shows).
 */
function FolderLinkSettings({
  target,
  insightsOn,
  plan,
  onInsightsChange,
  onLeave,
}: {
  target: FolderInsightsTarget;
  insightsOn: boolean | null;
  plan: "free" | "paid" | null;
  onInsightsChange: (on: boolean) => void;
  onLeave: () => void;
}) {
  const router = useRouter();
  const [rulePushed, setRulePushed] = useState(false);
  const upgrade = () => {
    onLeave();
    router.push(BILLING_ROUTE);
  };
  return (
    <div className="flex flex-col gap-3" data-testid="folder-link-rules">
      {!rulePushed && (
        <FolderInsightsSwitch target={target} on={insightsOn === true} plan={plan} onChange={onInsightsChange} onLeave={onLeave} />
      )}
      <FolderLinkRules tokenHash={target.tokenHash} onUpgrade={upgrade} onPushedChange={setRulePushed} />
    </div>
  );
}

/**
 * The folder link's one switch. Rust says when turning it on needs a paid
 * plan (`needsPaidPlan`), and the prompt shows under it; turning it off
 * always works.
 */
function FolderInsightsSwitch({
  target,
  on,
  plan,
  onChange,
  onLeave,
}: {
  target: FolderInsightsTarget;
  on: boolean;
  plan: "free" | "paid" | null;
  onChange: (on: boolean) => void;
  onLeave: () => void;
}) {
  const router = useRouter();
  const online = useIsOnline();
  const queryClient = useQueryClient();
  const [needsPlan, setNeedsPlan] = useState(false);
  const save = useMutation({
    mutationFn: (value: boolean) => setFolderInsights(target.tokenHash, value),
    ...PANEL_MUTATION,
    onSuccess: (outcome) => {
      if (outcome.outcome === "needsPaidPlan") {
        setNeedsPlan(true);
        return;
      }
      setNeedsPlan(false);
      onChange(outcome.insights);
      void queryClient.invalidateQueries({ queryKey: folderInsightsQueryKey(target.tokenHash) });
      void queryClient.invalidateQueries({ queryKey: [LINK_ACTIVITY_QUERY_KEY] });
    },
    onError: (err) => toast.error(actionErrorLine("change that setting", err, online)),
  });
  return (
    <div className={cn("flex flex-col gap-2 px-3.5 py-3", CARD)} data-testid="folder-insights-switch">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className={cn("text-[13px] font-medium", STRONG)}>Insights</p>
          <p className={cn("text-xs", MUTED)}>{plan === "free" ? SWITCH_LINE_FREE : SWITCH_LINE}</p>
        </div>
        <SettingsToggle
          checked={on}
          ariaLabel="Insights"
          disabled={save.isPending}
          onCheckedChange={(value) => save.mutate(value)}
        />
      </div>
      {needsPlan && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2">
          <p className={cn("text-xs", MUTED)}>{SWITCH_NEEDS_PLAN}</p>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              onLeave();
              router.push(BILLING_ROUTE);
            }}
          >
            {UPGRADE_PLAN}
          </Button>
        </div>
      )}
    </div>
  );
}
