/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  AnimatedAxis,
  XYChart,
  AnimatedBarSeries,
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
  bandScaleConfig?: BandConfig;
  plots: {
    dataKey: string;
    xAccessor: (data: T) => any;
    yAccessor: (data: T) => any;
    barColor?: string;
    barOpacity?: number;
  }[];
  xAxisProps?: Partial<AnimatedAxisProps<AxisScale>>;
  yAxisProps?: Partial<AnimatedAxisProps<AxisScale>>;
  showVerticalCrosshair?: boolean;
  showHorizontalCrosshair?: boolean;
  className?: string;
};

function BarChart<T extends object>({
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
  bandScaleConfig,
  className,
}: Props<T>) {
  return (
    <ParentSize className={className}>
      {({ width, height }) => (
        <XYChart
          width={width}
          height={height}
          xScale={{
            type: xScaleType || "band",
            ...(xScaleType === "band" && bandScaleConfig
              ? {
                  paddingInner: bandScaleConfig.paddingInner,
                  paddingOuter: bandScaleConfig.paddingOuter,
                  align: bandScaleConfig.align,
                }
              : {
                  paddingInner: 0.4,
                  paddingOuter: 0.2,
                  align: 0.5,
                }),
            ...(xDomain ? { domain: xDomain } : {}),
          }}
          yScale={{
            type: yScaleType || "linear",
            ...(yDomain ? { domain: yDomain } : {}),
          }}
          margin={
            margin || {
              top: 20,
              bottom: 40,
              left: 40,
              right: 20,
            }
          }
        >
          {/* X Axis */}
          <AnimatedAxis
            key={"x-axis"}
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
            key={"y-axis"}
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

          {plots.map(({ dataKey, xAccessor, yAccessor, barColor }) => (
            <AnimatedBarSeries
              key={dataKey}
              dataKey={dataKey}
              data={data}
              xAccessor={xAccessor}
              yAccessor={yAccessor}
              colorAccessor={() => barColor || "#3B82F6"} // primary-50 color#$
            />
          ))}

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

export default BarChart;
