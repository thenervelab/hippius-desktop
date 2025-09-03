// BalanceTrends.tsx
import { useMemo, useState } from "react";
import {
  Icons,
  Select,
  LineChart,
  AbstractIconWrapper,
  ChartGridOverlay,
} from "@/components/ui";
import { Option } from "@/components/ui/select";
import { Account } from "@/app/lib/types/accounts";
import {
  formatAccountsForChartByRange,
  ChartPoint,
} from "@/app/lib/utils/getFormatDataForAccountsChart";
import { InView } from "react-intersection-observer";

import BalanceTrendsTooltip from "./BalanceTrendsTooltip";
import { COLORS } from "./constants";
import { WalletAdd } from "@/app/components/ui/icons";
import { getNiceTicksAlways } from "@/app/lib/utils/getNiceTicksAlways";
import { getXLabelsForTimeRange } from "@/app/lib/utils/getXLabelsForTimeRange";

// === Time‐Range Options ===
const timeRangeOptions: Option[] = [
  { value: "last7days", label: "Last 7 Days" },
  { value: "last30days", label: "Last 30 Days" },
  { value: "last60days", label: "Last 60 Days" },
  { value: "year", label: "This Year" },
];

const BalanceTrends: React.FC<{
  chartData?: Account[];
  isLoading?: boolean;
  className?: string;
}> = ({ chartData, isLoading, className }) => {
  const [timeRange, setTimeRange] = useState<string>("last7days");

  const formattedChartData: ChartPoint[] = useMemo(() => {
    if (!chartData?.length) return [];
    return formatAccountsForChartByRange(
      chartData,
      timeRange as "last7days" | "last30days" | "last60days" | "year"
    );
  }, [chartData, timeRange]);

  const yTicks = useMemo(() => {
    if (!formattedChartData.length) return [0, 1];
    // Only consider balance values for the y-axis scale
    const balanceValues = formattedChartData.map((d) => d.balance);
    const mx = Math.max(...balanceValues, 0);
    return getNiceTicksAlways(0, mx, 5);
  }, [formattedChartData]);

  // Build X‐labels (strings) depending on selected range
  const xLabels: string[] = useMemo(() => {
    return getXLabelsForTimeRange(formattedChartData, chartData, timeRange);
  }, [formattedChartData, chartData, timeRange]);

  return (
    <InView triggerOnce threshold={0.2}>
      {({ ref }) => (
        <div
          ref={ref}
          className={`p-4 border border-grey-80 rounded-lg w-full h-[310px] ${
            className || ""
          }`}
        >
          <div className="flex justify-between mb-3.5">
            <div className="flex gap-4 items-center">
              <AbstractIconWrapper className="size-8 sm:size-10 text-primary-40">
                <WalletAdd className="absolute text-primary-40 size-4 sm:size-5" />
              </AbstractIconWrapper>
              <span className="text-base font-medium  text-grey-60">
                Balance Overview
              </span>
            </div>

            <Select
              options={timeRangeOptions}
              value={timeRange}
              onValueChange={setTimeRange}
            />
          </div>
          <div className="border border-grey-80 rounded-lg h-[225px] relative">
            <div className="relative w-full h-full flex">
              {isLoading ? (
                <div className="flex items-center justify-center w-full h-full">
                  <Icons.Loader className="size-8 animate-spin text-primary-60" />
                </div>
              ) : !formattedChartData.length ? (
                <div className="flex flex-col items-center justify-center w-full h-full font-medium">
                  <Icons.Search className="size-8 text-primary-60" />
                  <span className="mt-4 text-center text-grey-40">
                    No Balance Data Available
                  </span>
                </div>
              ) : (
                <div className="w-full h-full pt-4 pr-4">
                  <ChartGridOverlay
                    bgClass="bg-[url('/wallet-chart-grid.png')]"
                    marginClasses="mt-[36px] ml-[43px] mb-[30px] mr-[21px]"
                  />
                  <LineChart
                    key={`chart-${timeRange}-${formattedChartData.length}`}
                    className="w-full h-full"
                    data={formattedChartData}
                    xScaleType="band"
                    yDomain={[yTicks[0], yTicks[yTicks.length - 1]]}
                    margin={{ top: 20, left: 45, bottom: 30, right: 5 }}
                    showVerticalCrosshair
                    showHorizontalCrosshair
                    xAxisProps={{
                      numTicks: xLabels.length,
                      tickFormat: (_, i) => xLabels[i] || "",
                      tickLabelProps: () => ({
                        fontSize: 10,
                        fill: "#6B7280",
                        textAnchor: "middle",
                        dy: "0.5em",
                      }),
                    }}
                    yAxisProps={{
                      numTicks: yTicks.length,
                      tickValues: yTicks,
                      tickFormat: (v) => {
                        const n = Number(v);
                        if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
                        if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
                        return n.toFixed(n < 0.01 ? 4 : 2);
                      },
                      tickLabelProps: () => ({
                        fontSize: 10,
                        fill: "#6B7280",
                        textAnchor: "end",
                        verticalAnchor: "middle",
                        angle: -35,
                        dx: -2,
                      }),
                    }}
                    plots={[
                      {
                        dataKey: "balance",
                        xAccessor: (d: ChartPoint) => d.bandLabel ?? d.x,
                        yAccessor: (d: ChartPoint) => d.balance,
                        lineColor: COLORS.balance,
                      },
                    ]}
                    renderTooltip={(td) => (
                      <BalanceTrendsTooltip tooltipData={td} />
                    )}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </InView>
  );
};

export default BalanceTrends;
