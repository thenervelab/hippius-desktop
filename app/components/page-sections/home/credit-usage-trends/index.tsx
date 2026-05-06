import { Icons } from "@/components/ui";
import { ChartPoint } from "@/lib/types/chartTypes";
import ChartTrends, { ChartTrendsConfig } from "@/components/ui/chart-trends";
import CreditUsedTooltip from "./CreditsUsedTooltip";

// Drive-scoped: the chart and the "Total Credit Used" tile in DetailList
// both feed off /user-credits-by-storage-history?storage_type=drive, so
// the chart and the card always agree about scope (replaces the old
// wallet-wide /marketplace/credit + transform_marketplace_credits flow).
const config: ChartTrendsConfig = {
  invokeCommand: "get_drive_credits_chart",
  selfFetch: true,
  title: "Credit Usage",
  icon: <Icons.Tag2 className="relative size-4 @sm:size-5 text-primary-50" />,
  emptyText: "No Credits Data Available",
  lineColor: "#2563eb",
  dataKey: "balance",
  yAccessor: (d: ChartPoint) => d?.balance || 0,
  yMaxPadding: 1.02,
  yTickFormat: (v) => {
    const num = Number(v);
    if (num >= 0.0001) {
      if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
      if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
      return num.toFixed(num < 0.01 ? 4 : 2);
    }
    return num.toString();
  },
  margin: { top: 10, left: 45, bottom: 30, right: 5 },
  gridMarginClasses: "mt-[0.625rem] ml-[2.8125rem] mb-[1.875rem] mr-[1.3125rem]",
  renderTooltip: (tooltipData, timeRange) => (
    <CreditUsedTooltip tooltipData={tooltipData} timeRange={timeRange} />
  ),
  variant: "card",
};

const CreditUsageTrends: React.FC<{
  accountId?: string;
  isLoading?: boolean;
  className?: string;
  onRetry?: () => void;
}> = (props) => <ChartTrends config={config} {...props} />;

export default CreditUsageTrends;
