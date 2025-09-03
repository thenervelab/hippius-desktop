import { useMemo, useState } from "react";
import {
  AbstractIconWrapper,
  Icons,
  Card,
  Select,
  H4,
  RevealTextLine,
  BarChart,
  ChartGridOverlay,
} from "@/components/ui";
import { cn } from "@/app/lib/utils";
import { Option } from "@/components/ui/select";
import { Account } from "@/app/lib/types/accounts";
import { ChartPoint } from "@/app/lib/utils/getFormatDataForCreditsUsageChart";
import { formatStorageForChartByRange } from "@/app/lib/utils/getFormatDataForStorageUsageChart";
import { InView } from "react-intersection-observer";
import StorageUsedTooltip from "./StorageUsedTooltip";
import { formatBytes } from "@/app/lib/utils/formatBytes";
import { getNiceTicksAlways } from "@/app/lib/utils/getNiceTicksAlways";
import { getXLabelsForTimeRange } from "@/app/lib/utils/getXLabelsForTimeRange";

// === Time‐Range Options ===
const timeRangeOptions: Option[] = [
  { value: "last7days", label: "Last 7 Days" },
  { value: "last30days", label: "Last 30 Days" },
  { value: "last60days", label: "Last 60 Days" },
  { value: "year", label: "This Year" },
];

// === Bar Colors ===
const COLORS = {
  bar: "#3B82F6", // primary-50 color
};

const StorageUsageTrends: React.FC<{
  chartData?: Account[];
  isLoading?: boolean;
  className?: string;
  onRetry?: () => void;
}> = ({ chartData, isLoading, className }) => {
  const [timeRange, setTimeRange] = useState<string>("last7days");

  // Format raw account‐data into ChartPoint[] according to the selected range
  // Now using our storage-specific formatter
  const formattedChartData: ChartPoint[] = useMemo(() => {
    if (!chartData || chartData.length === 0) {
      return [];
    }
    return formatStorageForChartByRange(
      chartData,
      timeRange as "last7days" | "last30days" | "last60days" | "year"
    );
  }, [chartData, timeRange]);

  // Compute Y‐ticks
  const yTicks = useMemo(() => {
    if (!formattedChartData.length) return [0, 1];
    const sizes = formattedChartData.map((d) => d.balance);
    const max = Math.max(...sizes, 0);
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
                    <Icons.Chart className="relative size-4 sm:size-5 text-primary-50" />
                  </AbstractIconWrapper>
                  <H4
                    size="sm"
                    className="max-w-screen-sm text-center ml-2 transition-colors !text-[16px] sm:!text-[24px] text-grey-10"
                  >
                    <RevealTextLine rotate reveal={inView}>
                      Storage Usage
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
                    No Storage Usage Data Available
                  </span>
                </div>
              ) : (
                <div className="relative w-full h-full  pr-4">
                  <ChartGridOverlay marginClasses="mt-[0px] ml-[60px] mb-[30px] mr-[21px]" />

                  <BarChart
                    key={`chart-${timeRange}-${formattedChartData.length}`}
                    data={formattedChartData}
                    plots={[
                      {
                        dataKey: "balance",
                        xAccessor: (d: ChartPoint) =>
                          d.bandLabel ? d.bandLabel : d?.x,
                        yAccessor: (d: ChartPoint) => d?.balance || 0,
                        barColor: COLORS.bar,
                        barOpacity: 1,
                      },
                    ]}
                    xScaleType="band"
                    yDomain={[yTicks[0], yTicks[yTicks.length - 1]]}
                    margin={{ top: 0, left: 60, bottom: 30, right: 5 }}
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
                        // Format y-axis tick labels as file sizes
                        const num = Number(v);
                        if (num === 0) return "0 B";
                        return num > 1 ? formatBytes(num, 1) : num.toString();
                      },
                      tickLabelProps: () => ({
                        fontSize: 10,
                        fill: "#6B7280",
                        textAnchor: "end",
                        verticalAnchor: "middle",
                        width: 150,
                        angle: -35,
                        dx: -3,
                      }),
                    }}
                    renderTooltip={(tooltipData) => (
                      <StorageUsedTooltip tooltipData={tooltipData} />
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

export default StorageUsageTrends;
