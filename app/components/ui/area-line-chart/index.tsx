/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  AnimatedAxis,
  XYChart,
  AnimatedLineSeries,
  AnimatedAreaSeries,
  Margin,
  AxisScale,
  Tooltip,
  TooltipData,
} from "@visx/xychart";
import ParentSize from "@visx/responsive/lib/components/ParentSize";
import { ReactNode } from "react";
import { ScaleType } from "@visx/scale";
import { AnimatedAxisProps } from "@visx/xychart/lib/components/axis/AnimatedAxis";

type BandConfig = {
  paddingInner: number;
  paddingOuter: number;
  align: number;
};

type Props<T extends object> = {
  data: T[];
  renderTooltip?: (data?: TooltipData<T>) => ReactNode;
  margin?: Margin;
  yScaleType?: ScaleType;
  xScaleType?: ScaleType;
  xDomain?: [any, any];
  yDomain?: [any, any];
  // New prop for specifying band‐scale config from parent
  bandScaleConfig?: BandConfig;
  plots: {
    dataKey: string;
    xAccessor: (data: T) => any;
    yAccessor: (data: T) => any;
    lineColor?: string;
    lineType?: "solid" | "dashed";
    lineModifier?: "faded";
    areaColor?: string;
  }[];
  xAxisProps?: Partial<AnimatedAxisProps<AxisScale>>;
  yAxisProps?: Partial<AnimatedAxisProps<AxisScale>>;
  showVerticalCrosshair?: boolean;
  showHorizontalCrosshair?: boolean;
};

function AreaLineChart<T extends object>({
  data,
  xAxisProps,
  yAxisProps,
  plots,
  margin,
  yScaleType,
  xScaleType,
  xDomain,
  yDomain,
  showHorizontalCrosshair,
  showVerticalCrosshair,
  renderTooltip,
  bandScaleConfig, // <— we now accept this
}: Props<T>) {
  // Only one gradient is defined for all area series for now.
  const gradientId = "area-gradient";

  return (
    <ParentSize>
      {({ width, height }) => (
        <XYChart
          width={width}
          height={height}
          xScale={{
            type: xScaleType || "time",
            // If it’s a band scale, spread in bandScaleConfig
            ...(xScaleType === "band" && bandScaleConfig
              ? {
                  paddingInner: 1,
                  paddingOuter: bandScaleConfig.paddingOuter,
                  align: bandScaleConfig.align,
                }
              : {}),
            ...(xDomain ? { domain: xDomain } : {}),
          }}
          yScale={{
            type: yScaleType || "linear",
            ...(yDomain ? { domain: yDomain } : {}),
          }}
          margin={margin}
        >
          {/* SVG defs for linear gradient */}
          <defs>
            <linearGradient id="area-gradient" x1="0" x2="0" y1="0" y2="1">
              <stop
                offset="0%"
                stopColor="rgba(37, 99, 235, 0.15)"
                stopOpacity="1"
              />
              <stop
                offset="100%"
                stopColor="rgba(37, 99, 235, 0.01)"
                stopOpacity="0"
              />
            </linearGradient>
          </defs>

          {/* X Axis */}
          <AnimatedAxis
            key="x-axis"
            labelProps={{
              className: "fill-grey-10 animate-fade-in-0.3",
              fontSize: 12,
            }}
            tickLabelProps={{
              className: "fill-grey-60",
              fontWeight: 500,
            }}
            axisLineClassName="stroke-[#B4C8F3]"
            orientation="bottom"
            strokeWidth={2}
            {...xAxisProps}
          />

          {/* Y Axis */}
          <AnimatedAxis
            key="y-axis"
            labelProps={{
              className: "fill-grey-10 animate-fade-in-0.3",
              fontSize: 12,
            }}
            tickLabelProps={
              yAxisProps?.tickLabelProps || {
                className: "fill-grey-60",
                fontWeight: 500,
                textAnchor: "end",
                verticalAnchor: "middle",
                dx: -2,
                angle: -35, // Tilt labels to save horizontal space
                fontSize: 10,
              }
            }
            orientation="left"
            hideTicks={true}
            strokeWidth={2}
            axisLineClassName="stroke-[#B4C8F3]"
            rangePadding={{ start: 0, end: 0 }}
            {...yAxisProps}
          />

          {plots.map(
            ({
              dataKey,
              xAccessor,
              yAccessor,
              lineColor,
              lineType,
              lineModifier,
              areaColor,
            }) => (
              <g key={dataKey}>
                {/* Area Series with gradient fill */}
                <AnimatedAreaSeries
                  key={dataKey + "-area"}
                  dataKey={dataKey + "-area"}
                  data={data}
                  xAccessor={xAccessor}
                  yAccessor={yAccessor}
                  fill={areaColor || `url(#${gradientId})`}
                  stroke="none"
                  opacity={1}
                  className="duration-300"
                />
                {/* Line Series */}
                <AnimatedLineSeries
                  dataKey={dataKey}
                  key={dataKey + "-line"}
                  data={data}
                  xAccessor={xAccessor}
                  yAccessor={yAccessor}
                  stroke={lineColor || "#3167DD"}
                  strokeDasharray={lineType === "dashed" ? "4 4" : undefined}
                  opacity={lineModifier === "faded" ? 0.15 : 1}
                  className="duration-300"
                />
              </g>
            )
          )}

          {/* Tooltip (optional) */}
          {renderTooltip && (
            <Tooltip<T>
              showVerticalCrosshair={showVerticalCrosshair}
              showHorizontalCrosshair={showHorizontalCrosshair}
              snapTooltipToDatumX
              snapTooltipToDatumY
              showDatumGlyph
              horizontalCrosshairStyle={{
                stroke: "#04C870",
                strokeWidth: 1,
                strokeDasharray: "4 4",
              }}
              verticalCrosshairStyle={{
                stroke: "#04C870",
                strokeWidth: 1,
                strokeDasharray: "4 4",
              }}
              unstyled
              className="p-4 absolute bg-white border border-grey-80 rounded-lg text-grey-70 font-medium shadow-tooltip text-xs"
              renderTooltip={({ tooltipData }) => {
                return renderTooltip(tooltipData);
              }}
            />
          )}
        </XYChart>
      )}
    </ParentSize>
  );
}

export default AreaLineChart;
