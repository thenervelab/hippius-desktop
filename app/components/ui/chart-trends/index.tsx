import { useCallback, useEffect, useMemo, useState, ReactNode } from "react";
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
import { TooltipData } from "@visx/xychart";
import { cn } from "@/app/lib/utils";
import { Option } from "@/components/ui/select";
import { Account } from "@/app/lib/types/accounts";
import { ChartPoint } from "@/lib/types/chartTypes";
import { invoke } from "@tauri-apps/api/core";
import { InView } from "react-intersection-observer";
import { getNiceTicksAlways } from "@/app/lib/utils/getNiceTicksAlways";
import { getXLabelsForTimeRange } from "@/app/lib/utils/getXLabelsForTimeRange";
import { calculatePaddingOuter } from "@/app/lib/utils/calculatePaddingOuter";

// === Time-Range Options ===
const timeRangeOptions: Option[] = [
  { value: "last7days", label: "Last 7 Days" },
  { value: "last30days", label: "Last 30 Days" },
  { value: "last60days", label: "Last 60 Days" },
  { value: "year", label: "1 Year" },
  { value: "max", label: "MAX" },
];

/** Visual layout variant */
export type ChartTrendsVariant = "card" | "panel";

export interface ChartTrendsConfig {
  /** Rust invoke command name (e.g. "format_credits_chart") */
  invokeCommand: string;
  /** Chart title text */
  title: string;
  /** Icon rendered beside the title */
  icon: ReactNode;
  /** Text shown when no data is available */
  emptyText: string;
  /** Line color hex */
  lineColor: string;
  /** Area color (typically "url(#area-gradient)") */
  areaColor?: string;
  /** Which field on ChartPoint to use for the y-axis value */
  dataKey: string;
  /** Accessor for the y value from a ChartPoint */
  yAccessor: (d: ChartPoint) => number;
  /** Accessor for the y-tick source values from formatted data */
  yTickAccessor?: (d: ChartPoint) => number;
  /** Optional multiplier for y-axis max padding (e.g. 1.02 for 2% padding). Default: 1 (no padding) */
  yMaxPadding?: number;
  /** Y-axis tick format function */
  yTickFormat: (v: number | { valueOf(): number }) => string;
  /** Y-axis tick label props */
  yTickLabelProps?: () => Record<string, unknown>;
  /** Chart margin */
  margin: { top: number; left: number; bottom: number; right: number };
  /** ChartGridOverlay margin classes */
  gridMarginClasses: string;
  /** ChartGridOverlay background class (optional) */
  gridBgClass?: string;
  /** Render the tooltip given tooltip data and the current time range */
  renderTooltip: (
    tooltipData: TooltipData<ChartPoint> | undefined,
    timeRange: string,
  ) => ReactNode;
  /** Visual layout: "card" uses Card+RevealTextLine, "panel" uses plain div with border */
  variant?: ChartTrendsVariant;
}

export interface ChartTrendsProps {
  config: ChartTrendsConfig;
  chartData?: Account[];
  isLoading?: boolean;
  className?: string;
  onRetry?: () => void;
}

// Default y-axis tick label props
const defaultYTickLabelProps = () => ({
  fontSize: 10,
  fill: "#6B7280",
  textAnchor: "end" as const,
  verticalAnchor: "middle" as const,
  angle: -35,
  dx: -2,
});

const ChartTrends: React.FC<ChartTrendsProps> = ({
  config,
  chartData,
  isLoading,
  className,
}) => {
  const {
    invokeCommand,
    title,
    icon,
    emptyText,
    lineColor,
    areaColor = "url(#area-gradient)",
    dataKey,
    yAccessor,
    yTickAccessor,
    yMaxPadding = 1,
    yTickFormat,
    yTickLabelProps = defaultYTickLabelProps,
    margin,
    gridMarginClasses,
    gridBgClass,
    renderTooltip,
    variant = "card",
  } = config;

  const [timeRange, setTimeRange] = useState<string>("last7days");
  const [formattedChartData, setFormattedChartData] = useState<ChartPoint[]>(
    [],
  );

  useEffect(() => {
    if (!chartData?.length) {
      setFormattedChartData([]);
      return;
    }
    invoke<ChartPoint[]>(invokeCommand, {
      accounts: chartData,
      range: timeRange,
    })
      .then(setFormattedChartData)
      .catch((err: unknown) => {
        console.error("[ChartTrends] Failed to format chart data via", invokeCommand, ":", err);
        setFormattedChartData([]);
      });
  }, [chartData, timeRange, invokeCommand]);

  // Compute Y-ticks
  const yTicks = useMemo(() => {
    if (!formattedChartData.length) return [0, 1];
    const accessor = yTickAccessor ?? yAccessor;
    const values = formattedChartData.map(accessor);
    const max = Math.max(...values, 0);
    const paddedMax = max > 0 ? max * yMaxPadding : 1;
    return getNiceTicksAlways(0, paddedMax, 5);
  }, [formattedChartData, yAccessor, yTickAccessor, yMaxPadding]);

  // Build X-labels depending on selected range
  const xTicks = useMemo(() => {
    return getXLabelsForTimeRange(formattedChartData, timeRange);
  }, [formattedChartData, timeRange]);

  const xTickLabelMap = useMemo(() => {
    return new Map(xTicks.map((tick) => [tick.value.getTime(), tick.label]));
  }, [xTicks]);

  const xTickValues = useMemo(() => {
    return xTicks.map((tick) => tick.value);
  }, [xTicks]);

  const paddingOuter = useMemo(
    () => calculatePaddingOuter(formattedChartData.length),
    [formattedChartData.length],
  );

  const xTickFormat = useCallback(
    (value: Date | number | string) => {
      const date = value instanceof Date ? value : new Date(value);
      return xTickLabelMap.get(date.getTime()) || "";
    },
    [xTickLabelMap],
  );

  const plots = useMemo(
    () => [
      {
        dataKey,
        xAccessor: (d: ChartPoint) => new Date(d.x),
        yAccessor,
        lineColor,
        areaColor,
      },
    ],
    [dataKey, yAccessor, lineColor, areaColor],
  );

  const xDomain = useMemo(
    () => formattedChartData.map((d) => new Date(d.x)),
    [formattedChartData],
  );

  const yDomain = useMemo(
    () => [yTicks[0], yTicks[yTicks.length - 1]] as [number, number],
    [yTicks],
  );

  const xTickLabelProps = useCallback(
    () => ({
      fontSize: 10,
      fill: "#6B7280",
      textAnchor: "middle" as const,
      dy: "0.5em",
    }),
    [],
  );

  const xAxisProps = useMemo(
    () => ({
      tickValues: xTickValues,
      tickFormat: xTickFormat,
      label: "",
      hideTicks: false,
      hideAxisLine: false,
      tickLabelProps: xTickLabelProps,
    }),
    [xTickValues, xTickFormat, xTickLabelProps],
  );

  const bandScaleConfig = useMemo(
    () => ({
      paddingInner: 0.3,
      paddingOuter,
      align: 0.5,
    }),
    [paddingOuter],
  );

  const yAxisProps = useMemo(
    () => ({
      numTicks: yTicks.length,
      tickValues: yTicks,
      label: "",
      tickFormat: yTickFormat,
      tickLabelProps: yTickLabelProps,
    }),
    [yTicks, yTickFormat, yTickLabelProps],
  );

  const tooltipRenderer = useCallback(
    (tooltipData: TooltipData<ChartPoint> | undefined) =>
      renderTooltip(tooltipData, timeRange),
    [renderTooltip, timeRange],
  );

  const chartContent = (
    <div className="relative w-full h-full flex">
      {isLoading ? (
        <div className="flex items-center justify-center w-full h-full">
          <Icons.Loader className="size-8 animate-spin text-primary-60" />
        </div>
      ) : formattedChartData.length === 0 ? (
        <div className="flex font-medium flex-col items-center justify-center w-full h-full">
          <Icons.Search className="size-8 text-primary-60" />
          <span className="max-w-40 text-center text-grey-40 mt-4">
            {emptyText}
          </span>
        </div>
      ) : (
        <div
          className={cn(
            "w-full h-full relative pr-4",
            variant === "panel" && "pt-4",
          )}
        >
          <ChartGridOverlay
            bgClass={gridBgClass}
            marginClasses={gridMarginClasses}
          />
          <AreaLineChart
            key={`chart-${timeRange}-${formattedChartData.length}`}
            data={formattedChartData}
            xScaleType="band"
            yScaleType="linear"
            plots={plots}
            xDomain={xDomain}
            yDomain={yDomain}
            margin={margin}
            showVerticalCrosshair={true}
            showHorizontalCrosshair={true}
            xAxisProps={xAxisProps}
            bandScaleConfig={bandScaleConfig}
            yAxisProps={yAxisProps}
            renderTooltip={tooltipRenderer}
          />
        </div>
      )}
    </div>
  );

  if (variant === "panel") {
    return (
      <InView triggerOnce threshold={0.2}>
        {({ ref }) => (
          <div
            ref={ref}
            className={`p-4 border border-grey-80 rounded-lg w-full h-[19.375rem] ${
              className || ""
            }`}
          >
            <div className="flex justify-between mb-3.5">
              <div className="flex gap-4 items-center">
                <AbstractIconWrapper className="size-8 sm:size-10 text-primary-40">
                  {icon}
                </AbstractIconWrapper>
                <span className="text-base font-medium  text-grey-60">
                  {title}
                </span>
              </div>
              <Select
                options={timeRangeOptions}
                value={timeRange}
                onValueChange={setTimeRange}
              />
            </div>
            <div className="border border-grey-80 rounded-lg h-[14.0625rem] relative">
              {chartContent}
            </div>
          </div>
        )}
      </InView>
    );
  }

  // "card" variant (default)
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
                      inView && "opacity-100 translate-y-0",
                    )}
                  >
                    {icon}
                  </AbstractIconWrapper>
                  <H4
                    size="sm"
                    className="max-w-screen-sm text-center ml-2 transition-colors !text-[1rem] sm:!text-[1.5rem] text-grey-10"
                  >
                    <RevealTextLine rotate reveal={inView}>
                      {title}
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
            contentClassName="relative h-[15.375rem]"
          >
            {chartContent}
          </Card>
        </div>
      )}
    </InView>
  );
};

export default ChartTrends;
