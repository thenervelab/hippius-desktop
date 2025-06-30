/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  AnimatedAxis,
  XYChart,
  AnimatedLineSeries,
  Margin,
  AxisScale,
  Tooltip,
  TooltipData,
} from "@visx/xychart";
import ParentSize from "@visx/responsive/lib/components/ParentSize";
import { ReactNode } from "react";
import { ScaleType } from "@visx/scale";
import { AnimatedAxisProps } from "@visx/xychart/lib/components/axis/AnimatedAxis";

type Props<T extends object> = {
  data: T[];
  renderTooltip?: (data?: TooltipData<T>) => ReactNode;
  margin?: Margin;
  yScaleType?: ScaleType;
  xScaleType?: ScaleType;
  xDomain?: [any, any];
  yDomain?: [any, any];
  plots: {
    dataKey: string;
    xAccessor: (data: T) => any;
    yAccessor: (data: T) => any;
    lineColor?: string;
    lineType?: "solid" | "dashed";
    lineModifier?: "faded";
  }[];
  xAxisProps?: Partial<AnimatedAxisProps<AxisScale>>;
  yAxisProps?: Partial<AnimatedAxisProps<AxisScale>>;
  showVerticalCrosshair?: boolean;
  showHorizontalCrosshair?: boolean;
  className?: string;
};

function LineChart<T extends object>({
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
  className,
}: Props<T>) {
  return (
    <ParentSize className={className}>
      {({ width, height }) => (
        <XYChart
          width={width}
          height={height}
          xScale={{
            type: xScaleType || "time",
            padding: 0.0,
            ...(xDomain ? { domain: xDomain } : {}),
          }}
          yScale={{
            type: yScaleType || "linear",
            ...(yDomain ? { domain: yDomain } : {}),
          }}
          margin={
            margin || {
              top: 0,
              bottom: 0,
              left: 0,
              right: 0,
            }
          }
        >
          <AnimatedAxis
            key={xAxisProps?.label}
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
          <AnimatedAxis
            key={yAxisProps?.label}
            labelProps={{
              className: "fill-grey-10 animate-fade-in-0.3",
              fontSize: 12,
            }}
            tickLabelProps={{
              className: "fill-grey-60",
              fontWeight: 500,
            }}
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
            }) => (
              <AnimatedLineSeries
                key={dataKey}
                dataKey={dataKey}
                data={data}
                xAccessor={xAccessor}
                yAccessor={yAccessor}
                stroke={lineColor || "#3167DD"}
                strokeDasharray={lineType === "dashed" ? "4 4" : undefined}
                opacity={lineModifier === "faded" ? 0.15 : 1}
                className="duration-300"
              />
            )
          )}

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
              className="p-2 absolute bg-white border border-grey-80 rounded-lg text-grey-70 font-medium shadow-tooltip text-xs"
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

export default LineChart;
