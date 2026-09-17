"use client";

import React from "react";
import { Database, MonitorSmartphone } from "lucide-react";

import TabList from "@/components/ui/tabs/TabList";
import {
  useFileTypeSummary,
  useSourceSummary,
} from "@/app/lib/hooks/api/useDriveSummaries";

import BreakdownCard, { type BreakdownSlice } from "./BreakdownCard";

/**
 * What is in the drive, two ways, behind one tab control.
 *
 * These were two cards side by side. Three cards in the Overview's row left
 * each one a third wide, and below the three-across breakpoint they stacked
 * into a column of near-identical bar charts: the same shape twice, reading
 * as repetition rather than as two answers. One card with a tab keeps the
 * row at two cards, which is the width each of them actually has content
 * for, and it is the shape the console already uses.
 *
 * File types leads because it answers the commoner question. Which client
 * uploaded a file matters when something is missing; what KIND of files fill
 * a drive is what someone opening the page is usually asking.
 *
 * Both halves are fetched, not just the visible one: they are two cached
 * counter reads, and fetching on tab change would make the switch wait on
 * the network every time.
 */
type BreakdownTab = "types" | "sources";

/** The console's own tabs, verbatim, so the two clients read the same. */
const TABS = [
  { tabKey: "types", tabName: "File types" },
  { tabKey: "sources", tabName: "Upload sources" },
];

const DriveBreakdownCard: React.FC<{ className?: string }> = ({ className }) => {
  const [tab, setTab] = React.useState<BreakdownTab>("types");

  const types = useFileTypeSummary();
  const sources = useSourceSummary();

  const typeSlices: BreakdownSlice[] = React.useMemo(
    () => [
      { key: "images", label: "Images", count: types.data?.images ?? 0, color: "#F34E5E" },
      { key: "videos", label: "Videos", count: types.data?.videos ?? 0, color: "#7CD4F5" },
      { key: "docs", label: "Docs", count: types.data?.docs ?? 0, color: "#3066DD" },
      {
        key: "others",
        label: "Others",
        count: types.data?.others ?? 0,
        color: "#9A9A9A",
        // The same caveat the sources card carries on its grey bucket, so the
        // two tabs explain themselves the same way.
        note: "(before tracking)",
      },
    ],
    [types.data],
  );

  const sourceSlices: BreakdownSlice[] = React.useMemo(
    () => [
      { key: "desktop", label: "Desktop", count: sources.data?.desktop ?? 0, color: "#3066DD" },
      { key: "console", label: "Console", count: sources.data?.console ?? 0, color: "#4ECB9C" },
      { key: "mobile", label: "Mobile", count: sources.data?.mobile ?? 0, color: "#A78BFA" },
      {
        key: "other",
        label: "Other",
        count: sources.data?.other ?? 0,
        color: "#6B6B6B",
        note: "(before tracking)",
      },
    ],
    [sources.data],
  );

  const showingTypes = tab === "types";
  const active = showingTypes ? types : sources;

  return (
    <BreakdownCard
      title={showingTypes ? "Drive file types" : "Drive upload sources"}
      icon={
        showingTypes ? (
          <Database className="size-[14px]" />
        ) : (
          <MonitorSmartphone className="size-[14px]" />
        )
      }
      slices={showingTypes ? typeSlices : sourceSlices}
      isLoading={active.isLoading}
      isError={active.isError}
      emptyText={
        showingTypes
          ? "Upload a file and its type will appear here."
          : "Upload a file and the client that sent it will appear here."
      }
      headerRight={
        <TabList
          tabs={TABS}
          activeTab={tab}
          onTabChange={(value) => setTab(value as BreakdownTab)}
          width="min-w-0"
          height="h-8"
          className="max-w-full overflow-x-auto"
        />
      }
      className={className}
    />
  );
};

export default DriveBreakdownCard;
