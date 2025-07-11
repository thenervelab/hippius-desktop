import { useMemo, useState } from "react";
import {
  AbstractIconWrapper,
  Icons,
  Card,
  Graphsheet,
  Select,
  H4,
  RevealTextLine,
  AreaLineChart,
} from "@/components/ui";
import { cn } from "@/app/lib/utils";
import { Option } from "@/components/ui/select";
import { Account } from "@/app/lib/types/accounts";
import {
  formatAccountsForChartByRange,
  ChartPoint,
} from "@/app/lib/utils/getFormatDataForCreditsUsageChart";
import { InView } from "react-intersection-observer";
import {
  getQuarterDateLabels,
  MONTHS,
} from "@/app/lib/utils/getXlablesForAccounts";
import CreditUsedTooltip from "./CreditsUsedTooltip";
import { formatBalance } from "@/app/lib/utils/formatters/formatBalance";

// === Time‐Range Options ===
const timeRangeOptions: Option[] = [
  { value: "week", label: "This Week" },
  { value: "month", label: "This Month" },
  { value: "lastMonth", label: "Last Month" },
  { value: "year", label: "This Year" },
];

// === Line + Area Colors ===
const COLORS = {
  line: "#2563eb",
  area: "url(#area-gradient)", // Use the gradient defined in AreaLineChart
};

const CreditUsageTrends: React.FC<{
  chartData?: Account[];
  isLoading?: boolean;
  className?: string;
  onRetry?: () => void;
}> = ({ chartData, isLoading, className }) => {
  const [timeRange, setTimeRange] = useState<string>("week");

  // Format raw account‐data into ChartPoint[] according to the selected range
  const formattedChartData: ChartPoint[] = useMemo(() => {
    if (!chartData || chartData.length === 0) {
      return [];
    }
    return formatAccountsForChartByRange(
      chartData,
      timeRange as "week" | "month" | "lastMonth" | "quarter" | "year" // Add lastMonth to type
    );
  }, [chartData, timeRange]);

  // Calculate total credits used
  const totalCreditsUsed = useMemo(() => {
    if (!chartData || chartData.length === 0) return "0";

    // Sum up the total_balance from all account data
    const total = chartData.reduce((sum, account) => {
      // Extract just the numeric part - need to convert from string to BigInt since these are large numbers
      const balance = BigInt(account.total_balance);
      // Accumulate the balance
      // Using BigInt to handle large numbers accurately
      return sum + balance;
    }, BigInt(0));
    // Format to a readable number with commas
    return formatBalance(total.toString());
  }, [chartData]);

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
  } else if (timeRange === "lastMonth" && formattedChartData.length > 0) {
    // For last month, similar to month but use previous month's dates
    const now = new Date();
    const lastMonth = new Date(now);
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    const daysInLastMonth = new Date(
      lastMonth.getFullYear(),
      lastMonth.getMonth() + 1,
      0
    ).getDate();

    if (daysInLastMonth <= 15) {
      xLabels = Array.from({ length: daysInLastMonth }, (_, i) =>
        String(i + 1).padStart(2, "0")
      );
    } else {
      xLabels = [];
      for (let i = 1; i <= daysInLastMonth; i += 2) {
        xLabels.push(String(i).padStart(2, "0"));
      }
      const lastDayLabel = String(daysInLastMonth).padStart(2, "0");
      if (!xLabels.includes(lastDayLabel)) xLabels.push(lastDayLabel);
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

  // Compute a “half‐band” paddingOuter so the first tick sits half a band away
  const paddingOuter = xLabels.length > 0 ? 1 / (2 * xLabels.length) : 0;

  return (
    <InView triggerOnce threshold={0.2}>
      {({ ref, inView }) => (
        <div ref={ref} className="w-full">
          <Card
            title={
              <div className="flex justify-between gap-3 w-full py-1 px-2">
                <div className="flex items-center group-x-2">
                  <AbstractIconWrapper
                    className={cn(
                      "px-0 size-6 sm:size-7 opacity-0 translate-y-7 duration-500 transition-transform",
                      inView && "opacity-100 translate-y-0"
                    )}
                  >
                    <Icons.Tag2 className="relative size-4 sm:size-5 text-primary-50" />
                  </AbstractIconWrapper>
                  <H4
                    size="sm"
                    className="max-w-screen-sm text-center ml-2 transition-colors !text-[16px] sm:!text-[24px] text-grey-10"
                  >
                    <RevealTextLine rotate reveal={inView}>
                      Credit Usage
                    </RevealTextLine>
                  </H4>
                </div>
                <div className="flex items-center ml-4 justify-end">
                  <Select
                    options={timeRangeOptions}
                    value={timeRange}
                    onValueChange={(value) => {
                      setTimeRange(value);
                    }}
                  />
                </div>
              </div>
            }
            className={cn("flex-1 rounded", className)}
            contentClassName="relative h-[300px]"
          >
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
                    No Credits Data Available
                  </span>
                </div>
              ) : (
                <div className="w-full h-full pt-12">
                  {/* Total Credits Used Display - Added based on image */}
                  <div className="absolute top-1 left-14 border border-grey-80 rounded bg-white px-2 py-1 z-50">
                    <div className="text-grey-60 text-base mb-1 font-medium">
                      Total Credits Used
                    </div>
                    <div className="text-2xl font-medium text-grey-10">
                      {totalCreditsUsed}
                    </div>
                  </div>

                  <AreaLineChart
                    key={`chart-${timeRange}-${formattedChartData.length}`}
                    data={formattedChartData}
                    plots={[
                      {
                        dataKey: "balance",
                        xAccessor: (d: ChartPoint) =>
                          d.bandLabel ? d.bandLabel : d?.x,
                        yAccessor: (d: ChartPoint) => d?.balance || 0,
                        lineColor: COLORS.line,
                        areaColor: COLORS.area,
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
                    // Pass our computed "half‐band" paddingOuter here
                    bandScaleConfig={{
                      paddingInner: 0.3,
                      paddingOuter,
                      align: 0,
                    }}
                    renderTooltip={(tooltipData) => (
                      <CreditUsedTooltip tooltipData={tooltipData} />
                    )}
                  />
                </div>
              )}
            </div>
          </Card>
        </div>
      )}
    </InView>
  );
};

export default CreditUsageTrends;
