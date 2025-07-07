// BalanceTrends.tsx
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
import { COLORS } from "./constants";

const timeRangeOptions: Option[] = [
  { value: "week", label: "This Week" },
  { value: "month", label: "This Month" },
  { value: "quarter", label: "3 Months" },
  { value: "year", label: "This Year" },
];

const BalanceTrends: React.FC<{
  chartData?: Account[];
  isLoading?: boolean;
  className?: string;
}> = ({ chartData, isLoading, className }) => {
  const [timeRange, setTimeRange] = useState<string>("week");

  const formattedChartData: ChartPoint[] = useMemo(() => {
    if (!chartData?.length) return [];
    return formatAccountsForChartByRange(
      chartData,
      timeRange as "week" | "month" | "quarter" | "year"
    );
  }, [chartData, timeRange]);

  function getNiceTicksAlways(min: number, max: number, cnt = 5) {
    min = 0;
    if (max === 0 || Math.abs(max - min) < 1e-6) max = min + 0.0001;
    const rawStep = (max - min) / (cnt - 1);
    const mag = 10 ** Math.floor(Math.log10(rawStep));
    let step = mag;
    if (rawStep / step > 5) step *= 5;
    else if (rawStep / step > 2) step *= 2;
    const last = Math.ceil(max / step) * step;
    const n = Math.round((last - min) / step) + 1;
    return Array.from({ length: n }, (_, i) => +(min + i * step).toFixed(6));
  }

  const yTicks = useMemo(() => {
    if (!formattedChartData.length) return [0, 1];
    const allVals = formattedChartData.flatMap((d) => [d.balance, d.credit]);
    const mx = Math.max(...allVals, 0);
    return getNiceTicksAlways(0, mx, 5);
  }, [formattedChartData]);

  let xLabels: string[] = [];
  if (timeRange === "week") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today);
      d.setDate(today.getDate() - (6 - i));
      return d;
    });
    xLabels = dates.map((d) =>
      d.toLocaleDateString("en-US", { weekday: "short" })
    );
  } else if (timeRange === "month") {
    const today = new Date().getDate();
    xLabels =
      today <= 15
        ? Array.from({ length: today }, (_, i) =>
            String(i + 1).padStart(2, "0")
          )
        : [
            ...Array.from({ length: Math.ceil(today / 2) }, (_, i) =>
              String(1 + i * 2).padStart(2, "0")
            ),
            String(today).padStart(2, "0"),
          ];
  } else if (timeRange === "quarter") {
    if (formattedChartData.length) {
      xLabels = getQuarterDateLabels(formattedChartData[0].x, 10);
    }
  } else {
    const baseYear = chartData?.length
      ? new Date(
          chartData[chartData.length - 1].processed_timestamp
        ).getFullYear()
      : new Date().getFullYear();
    const now = new Date().getFullYear();
    const months = baseYear === now ? new Date().getMonth() + 1 : 12;
    xLabels = MONTHS.slice(0, months);
  }

  return (
    <InView triggerOnce threshold={0.2}>
      {({ ref }) => (
        <div ref={ref} className={`py-4 pr-4 pl-8 w-full ${className || ""}`}>
          <div className="border border-grey-80 rounded-lg h-full relative">
            <div className="absolute left-2  z-50">
              <div className="flex ml-8 mt-4 text-grey-70 font-medium items-center gap-x-3 text-xs">
                <div className="flex items-center gap-x-2">
                  <div className="w-6 h-0.5 bg-primary-40" />
                  Balance
                </div>

                <div className="flex items-center gap-x-2">
                  <div className="w-6 h-0 border-t-2 border-dashed border-primary-70" />
                  Credit
                </div>
              </div>
            </div>
            <div className="absolute right-4 top-2 z-50">
              <Select
                options={timeRangeOptions}
                value={timeRange}
                onValueChange={setTimeRange}
              />
            </div>
            <Graphsheet
              className="absolute inset-0"
              majorCell={{
                lineColor: [232, 237, 248, 1],
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
              ) : !formattedChartData.length ? (
                <div className="flex flex-col items-center justify-center w-full h-full font-medium">
                  <Icons.Search className="size-8 text-primary-60" />
                  <span className="mt-4 text-center text-grey-40">
                    No Balance Data Available
                  </span>
                </div>
              ) : (
                <div className="w-full h-full pt-4">
                  <LineChart
                    key={`chart-${timeRange}-${formattedChartData.length}`}
                    className="w-full h-full"
                    data={formattedChartData}
                    xScaleType="band"
                    yDomain={[yTicks[0], yTicks[yTicks.length - 1]]}
                    margin={{ top: 34, left: 45, bottom: 30, right: 5 }}
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
                      {
                        dataKey: "credit",
                        xAccessor: (d: ChartPoint) => d.bandLabel ?? d.x,
                        yAccessor: (d: ChartPoint) => d.credit,
                        lineColor: COLORS.credit,
                        lineType: "dashed",
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
