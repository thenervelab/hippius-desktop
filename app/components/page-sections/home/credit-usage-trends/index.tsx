import { Account } from "@/app/lib/types/accounts";
import { Icons } from "@/components/ui";
import InfoTooltip from "@/components/ui/info-tooltip";
import { ChartPoint } from "@/lib/types/chartTypes";
import ChartTrends, { ChartTrendsConfig } from "@/components/ui/chart-trends";
import { DRIVE_SCOPED_CREDITS_ENABLED } from "@/app/lib/featureFlags";
import CreditUsedTooltip from "./CreditsUsedTooltip";

// Two parallel chart shapes feed the same component:
//
// 1. drive-scoped (DRIVE_SCOPED_CREDITS_ENABLED = true) — backend self-
//    fetches /user-credits-by-storage-history?storage_type=drive so the
//    chart matches the drive-only Total Storage Used tile.
// 2. wallet-wide (default) — legacy /marketplace/credit feed transformed
//    on the FE; covers drive + S3 + every other product. The title row
//    carries an InfoTooltip explaining the scope difference vs. the
//    storage tile so users can read the chart correctly.
//
// The Rust IPCs and FE hook backing path 1 stay live so flipping the
// flag is the only change needed to switch.
const driveScopedTitle = "Credit Usage";
const walletWideTitle = (
  <span className="inline-flex items-center gap-1">
    Credit Usage
    <InfoTooltip>
      Credits consumption includes both drive + S3 storage.
    </InfoTooltip>
  </span>
);

const sharedConfig = {
  icon: <Icons.Tag2 className="relative size-4 @sm:size-5 text-primary-50" />,
  emptyText: "No Credits Data Available",
  lineColor: "#2563eb",
  dataKey: "balance",
  yAccessor: (d: ChartPoint) => d?.balance || 0,
  yMaxPadding: 1.02,
  yTickFormat: (v: number | { valueOf(): number }) => {
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
  renderTooltip: (tooltipData: Parameters<ChartTrendsConfig["renderTooltip"]>[0], timeRange: string) => (
    <CreditUsedTooltip tooltipData={tooltipData} timeRange={timeRange} />
  ),
  variant: "card" as const,
} satisfies Omit<ChartTrendsConfig, "title" | "invokeCommand" | "selfFetch">;

const driveScopedConfig: ChartTrendsConfig = {
  ...sharedConfig,
  title: driveScopedTitle,
  invokeCommand: "get_drive_credits_chart",
  selfFetch: true,
};

const walletWideConfig: ChartTrendsConfig = {
  ...sharedConfig,
  title: walletWideTitle,
  invokeCommand: "format_credits_chart",
};

const config = DRIVE_SCOPED_CREDITS_ENABLED ? driveScopedConfig : walletWideConfig;

const CreditUsageTrends: React.FC<{
  // Either prop set is valid; the chart picks the path via `selfFetch`
  // on the active config. The wrapper just forwards.
  accountId?: string;
  chartData?: Account[];
  isLoading?: boolean;
  className?: string;
  onRetry?: () => void;
}> = (props) => <ChartTrends config={config} {...props} />;

export default CreditUsageTrends;
