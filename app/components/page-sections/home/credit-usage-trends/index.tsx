import { useMemo, useState } from "react";
import {
  AbstractIconWrapper,
  Icons,
  Card,
  Select,
  H4,
  RevealTextLine,
  AreaLineChart,
  ChartGridOverlay,
} from "@/components/ui";
import { cn } from "@/app/lib/utils";
import { Option } from "@/components/ui/select";
import { Account } from "@/app/lib/types/accounts";
import {
  formatAccountsForChartByRange,
  ChartPoint,
} from "@/app/lib/utils/getFormatDataForCreditsUsageChart";
import { InView } from "react-intersection-observer";
import CreditUsedTooltip from "./CreditsUsedTooltip";
import { getNiceTicksAlways } from "@/app/lib/utils/getNiceTicksAlways";
import { getXLabelsForTimeRange } from "@/app/lib/utils/getXLabelsForTimeRange";

// === Time‐Range Options ===
const timeRangeOptions: Option[] = [
  { value: "last7days", label: "Last 7 Days" },
  { value: "last30days", label: "Last 30 Days" },
  { value: "last60days", label: "Last 60 Days" },
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
  const [timeRange, setTimeRange] = useState<string>("last7days");

  // Format raw account‐data into ChartPoint[] according to the selected range
  const formattedChartData: ChartPoint[] = useMemo(() => {
    if (!chartData || chartData.length === 0) {
      return [];
    }

    return formatAccountsForChartByRange(
      chartData,
      timeRange as "last7days" | "last30days" | "last60days" | "year"
    );
  }, [chartData, timeRange]);

  // Calculate total credits used based on the selected time range
  const totalCreditsUsed = useMemo(() => {
    if (!formattedChartData || formattedChartData.length === 0) return "0";
    // Sum up the balance values from the formatted data (already filtered by time range)
    const total = formattedChartData.reduce((sum, point) => {
      return sum + +(point.balance || 0);
    }, 0);
    // Format to a readable number with commas
    return total.toFixed(6);
  }, [formattedChartData]);
  // Compute Y‐ticks
  const yTicks = useMemo(() => {
    if (!formattedChartData.length) return [0, 1];
    const balances = formattedChartData.map((d) => d.balance);
    const max = Math.max(...balances, 0);
    return getNiceTicksAlways(0, max, 5);
  }, [formattedChartData]);

  // Build X‐labels (strings) depending on selected range
  const xLabels: string[] = useMemo(() => {
    return getXLabelsForTimeRange(formattedChartData, chartData, timeRange);
  }, [formattedChartData, chartData, timeRange]);

  return (
    <InView triggerOnce threshold={0.2}>
      {({ ref, inView }) => (
        <div ref={ref} className="w-full">
          <Card
            title={
              <div className="flex justify-between gap-3 w-full py-1 mb-1.5 px-2">
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
            contentClassName="relative h-[246px]"
          >
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
                <div className="w-full h-full  relative pr-4">
                  {/* Total Credits Used Display - Added based on image */}
                  <div className="absolute top-4 left-14 border border-grey-80 rounded bg-white px-2 py-1 z-10">
                    <div className="text-grey-60 text-base mb-1 font-medium">
                      Total Credits Used
                    </div>
                    <div className="text-2xl font-medium text-grey-10">
                      {totalCreditsUsed}
                    </div>
                  </div>
                  <ChartGridOverlay marginClasses="mt-[0px] ml-[45px] mb-[30px] mr-[21px]" />
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
                    margin={{ top: 0, left: 45, bottom: 30, right: 5 }}
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
