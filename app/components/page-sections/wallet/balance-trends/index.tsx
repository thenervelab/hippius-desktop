import { useMemo, useState } from "react";
import { Icons, Graphsheet, Select, LineChart } from "@/components/ui";
import { Option } from "@/components/ui/select";
import { Account } from "@/app/lib/types/accounts";
import {
  formatAccountsForChartByRange,
  ChartPoint,
} from "@/app/lib/utils/getFormatDataForAccountsChart";
import { InView } from "react-intersection-observer";
import {
  getQuarterDateLabels,
  MONTHS,
} from "@/app/lib/utils/getXlablesForAccounts";
import BalanceTrendsTooltip from "./BalanceTrendsTooltip";

// === Time‐Range Options ===
const timeRangeOptions: Option[] = [
  { value: "week", label: "This Week" },
  { value: "month", label: "This Month" },
  { value: "quarter", label: "3 Months" },
  { value: "year", label: "This Year" },
];

// === Line Color ===
const COLORS = {
  line: "#2563eb",
};

const BalanceTrends: React.FC<{
  chartData?: Account[];
  isLoading?: boolean;
  className?: string;
  onRetry?: () => void;
}> = ({ chartData, isLoading }) => {
  const [timeRange, setTimeRange] = useState<string>("week");

  // Format raw account‐data into ChartPoint[] according to the selected range
  const formattedChartData: ChartPoint[] = useMemo(() => {
    if (!chartData || chartData.length === 0) {
      return [];
    }
    return formatAccountsForChartByRange(
      chartData,
      timeRange as "week" | "month" | "quarter" | "year"
    );
  }, [chartData, timeRange]);

  // Create “nice” Y ticks that always start at 0
  function getNiceTicksAlways(min: number, max: number, tickCount = 5) {
    min = 0;
    if (max === 0 || Math.abs(max - min) < 1e-6) {
      max = min + 0.0001;
    }
    const rawStep = (max - min) / (tickCount - 1);
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    let niceStep = magnitude;
    if (rawStep / niceStep > 5) niceStep *= 5;
    else if (rawStep / niceStep > 2) niceStep *= 2;

    const lastTick = Math.ceil(max / niceStep) * niceStep;
    const nTicks = Math.round((lastTick - min) / niceStep) + 1;

    return Array.from(
      { length: nTicks },
      (_, i) => +(min + i * niceStep).toFixed(6)
    );
  }

  // Compute Y‐ticks
  const yTicks = useMemo(() => {
    if (!formattedChartData.length) return [0, 1];
    const balances = formattedChartData.map((d) => d.balance);
    const max = Math.max(...balances, 0);
    return getNiceTicksAlways(0, max, 5);
  }, [formattedChartData]);

  // Build X‐labels (strings) depending on selected range
  let xLabels: string[] = [];
  if (timeRange === "week") {
    const last7Dates = (() => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(today);
        d.setDate(today.getDate() - (6 - i));
        return d;
      });
    })();
    xLabels = last7Dates.map((date) =>
      date.toLocaleDateString("en-US", { weekday: "short" })
    );
  } else if (timeRange === "month" && formattedChartData.length > 0) {
    const date = new Date();
    const today = date.getDate();
    if (today <= 15) {
      xLabels = Array.from({ length: today }, (_, i) =>
        String(i + 1).padStart(2, "0")
      );
    } else {
      xLabels = [];
      for (let i = 1; i <= today; i += 2) {
        xLabels.push(String(i).padStart(2, "0"));
      }
      const todayLabel = String(today).padStart(2, "0");
      if (!xLabels.includes(todayLabel)) xLabels.push(todayLabel);
    }
  } else if (timeRange === "quarter" && formattedChartData.length > 0) {
    const date = new Date(formattedChartData[0].x || new Date());
    xLabels = getQuarterDateLabels(date, 10);
  } else if (timeRange === "year") {
    const baseYear =
      chartData && chartData.length
        ? new Date(
            chartData[chartData.length - 1].processed_timestamp
          ).getFullYear()
        : new Date().getFullYear();
    const now = new Date();
    const currentYear = now.getFullYear();
    const monthsToShow = baseYear === currentYear ? now.getMonth() + 1 : 12;
    xLabels = MONTHS.slice(0, monthsToShow);
  }

  return (
    <InView triggerOnce threshold={0.2}>
      {({ ref }) => (
        <div ref={ref} className="p-4 w-full">
          <div
            className={
              "border border-grey-80 flex flex-col rounded-lg h-full relative"
            }
          >
            <div className="absolute right-4 top-4 z-50">
              <Select
                options={timeRangeOptions}
                value={timeRange}
                onValueChange={(value) => {
                  setTimeRange(value);
                }}
              />
            </div>
            <Graphsheet
              className="absolute right-0 left-0 top-0 w-full h-full"
              majorCell={{
                lineColor: [232, 237, 248, 1.0],
                lineWidth: 2,
                cellDim: 100,
              }}
              minorCell={{
                lineColor: [251, 252, 254, 1],
                lineWidth: 1,
                cellDim: 15,
              }}
            />

            <div className="relative w-full h-full flex">
              {isLoading ? (
                <div className="flex items-center justify-center w-full h-full">
                  <Icons.Loader className="size-8 animate-spin text-primary-60" />
                </div>
              ) : formattedChartData.length === 0 ? (
                <div className="flex font-medium flex-col items-center justify-center w-full h-full">
                  <Icons.Search className="size-8 text-primary-60" />
                  <span className="max-w-40 text-center text-grey-40 mt-4">
                    No Balance Data Available
                  </span>
                </div>
              ) : (
                <div className="w-full h-full pt-4">
                  <LineChart
                    key={`chart-${timeRange}-${formattedChartData.length}`}
                    className="w-full h-full"
                    data={formattedChartData}
                    plots={[
                      {
                        dataKey: "balance",
                        xAccessor: (d: ChartPoint) =>
                          d.bandLabel ? d.bandLabel : d?.x,
                        yAccessor: (d: ChartPoint) => d?.balance || 0,
                        lineColor: COLORS.line,
                      },
                    ]}
                    xScaleType="band" // Always use band for every range
                    yDomain={[yTicks[0], yTicks[yTicks.length - 1]]}
                    margin={{ top: 34, left: 45, bottom: 30, right: 5 }}
                    showVerticalCrosshair={true}
                    showHorizontalCrosshair={true}
                    xAxisProps={{
                      numTicks: xLabels.length,
                      tickFormat: (_, i) => xLabels[i] || "",
                      label: "",
                      hideTicks: false,
                      hideAxisLine: false,
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
                      label: "",
                      tickFormat: (v) => {
                        const num = Number(v);
                        if (num >= 0.0001) {
                          if (num >= 1000000)
                            return `${(num / 1000000).toFixed(1)}M`;
                          if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
                          return num.toFixed(num < 0.01 ? 4 : 2);
                        }
                        return num.toString();
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
                    renderTooltip={(tooltipData) => (
                      <BalanceTrendsTooltip tooltipData={tooltipData} />
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
