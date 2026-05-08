import { Icons } from "@/components/ui";
import { ChartPoint } from "@/lib/types/chartTypes";
import ChartTrends, { ChartTrendsConfig } from "@/components/ui/chart-trends";
import StorageUsedTooltip from "./StorageUsedTooltip";
import { formatBytes } from "@/app/lib/utils/formatBytes";

// Drive-scoped: the chart and the "Total Storage Used" tile both
// feed off /user-extended-storage-metrics?storage=drive — the same
// snapshot endpoint, just bucketed by day with carry-forward in
// `get_drive_storage_chart`. Before 2026-05-08 the chart pulled
// from /user-credits-by-storage-history (event-driven) and could
// disagree with the tile by hundreds of MB after a deletion until
// the next billing event landed; the move closes that drift.
const config: ChartTrendsConfig = {
  invokeCommand: "get_drive_storage_chart",
  selfFetch: true,
  title: "Storage Usage",
  icon: <Icons.Chart className="relative size-4 @sm:size-5 text-primary-50" />,
  emptyText: "No Storage Usage Data Available",
  lineColor: "#3B82F6",
  dataKey: "balance",
  yAccessor: (d: ChartPoint) => d?.balance || 0,
  yTickFormat: (v) => {
    const num = Number(v);
    if (num === 0) return "0 B";
    return num > 1 ? formatBytes(num, 1) : num.toString();
  },
  yTickLabelProps: () => ({
    fontSize: 10,
    fill: "#6B7280",
    textAnchor: "end" as const,
    verticalAnchor: "middle" as const,
    width: 150,
    angle: -35,
    dx: -3,
  }),
  margin: { top: 10, left: 60, bottom: 30, right: 5 },
  gridMarginClasses: "mt-[0.625rem] ml-[3.75rem] mb-[1.875rem] mr-[1.3125rem]",
  renderTooltip: (tooltipData, timeRange) => (
    <StorageUsedTooltip tooltipData={tooltipData} timeRange={timeRange} />
  ),
  variant: "card",
};

const StorageUsageTrends: React.FC<{
  accountId?: string;
  isLoading?: boolean;
  className?: string;
  onRetry?: () => void;
}> = (props) => <ChartTrends config={config} {...props} />;

export default StorageUsageTrends;
