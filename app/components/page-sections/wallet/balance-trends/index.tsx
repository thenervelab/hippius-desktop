import { Account } from "@/app/lib/types/accounts";
import { ChartPoint } from "@/lib/types/chartTypes";
import ChartTrends, { ChartTrendsConfig } from "@/components/ui/chart-trends";
import BalanceTrendsTooltip from "./BalanceTrendsTooltip";
import { COLORS } from "./constants";
import { WalletAdd } from "@/app/components/ui/icons";

const config: ChartTrendsConfig = {
  invokeCommand: "format_balance_chart",
  title: "Balance Overview",
  icon: <WalletAdd className="absolute text-primary-40 size-4 sm:size-5" />,
  emptyText: "No Balance Data Available",
  lineColor: COLORS.line,
  areaColor: COLORS.area,
  dataKey: "balance",
  yAccessor: (d: ChartPoint) => d.balance,
  yTickFormat: (v) => {
    const n = Number(v);
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return n.toFixed(n < 0.01 ? 4 : 2);
  },
  margin: { top: 20, left: 45, bottom: 30, right: 5 },
  gridMarginClasses: "mt-[2.25rem] ml-[2.6875rem] mb-[1.875rem] mr-[1.3125rem]",
  gridBgClass: "bg-[url('/wallet-chart-grid.png')]",
  renderTooltip: (tooltipData) => (
    <BalanceTrendsTooltip tooltipData={tooltipData} />
  ),
  variant: "panel",
};

const BalanceTrends: React.FC<{
  chartData?: Account[];
  isLoading?: boolean;
  className?: string;
}> = (props) => <ChartTrends config={config} {...props} />;

export default BalanceTrends;
