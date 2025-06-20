/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  AnimatedAxis,
  XYChart,
  Margin,
  AxisScale,
  Tooltip,
  TooltipData,
  GlyphSeries,
  TooltipProvider,
} from "@visx/xychart";

import { useCallback, useContext } from "react";
import { TooltipContext, TooltipContextType } from "@visx/xychart";
import ParentSize from "@visx/responsive/lib/components/ParentSize";
import { ReactNode, useEffect, useState } from "react";
import { ScaleType } from "@visx/scale";
import { AnimatedAxisProps } from "@visx/xychart/lib/components/axis/AnimatedAxis";
import { RenderTooltipParams } from "@visx/xychart/lib/components/Tooltip";
import { cn } from "@/app/lib/utils";

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
    size?: number;
    data?: T[];
  }[];
  xAxisProps?: Partial<AnimatedAxisProps<AxisScale>>;
  yAxisProps?: Partial<AnimatedAxisProps<AxisScale>>;
  showVerticalCrosshair?: boolean;
  showHorizontalCrosshair?: boolean;
  isMobile: boolean;
  getDatumIdentifier: (d: T) => string;
  defaultTooltipDatum?: {
    dataKey: string;
    datum: T;
  };
  focusedKey?: string;
  className?: string;
};

function ScatterPlot<T extends object>({
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
  isMobile,
  defaultTooltipDatum,
  getDatumIdentifier,
  className,
}: Props<T>) {
  const [hasAnimated, setHasAnimated] = useState(false);

  // Once data is loaded, mark that we've animated (only once)
  useEffect(() => {
    if (data.length > 0 && !hasAnimated) {
      const timer = setTimeout(() => {
        setHasAnimated(true);
      }, 1500);

      return () => clearTimeout(timer);
    }
  }, [data.length, hasAnimated]);

  return (
    <ParentSize className={className}>
      {({ width, height }) => {
        return (
          <TooltipProvider hideTooltipDebounceMs={500}>
            <ChartContent
              width={width}
              height={height}
              data={data}
              xAxisProps={xAxisProps}
              yAxisProps={yAxisProps}
              plots={plots}
              margin={margin}
              yScaleType={yScaleType}
              xScaleType={xScaleType}
              xDomain={xDomain}
              yDomain={yDomain}
              showHorizontalCrosshair={showHorizontalCrosshair}
              showVerticalCrosshair={showVerticalCrosshair}
              renderTooltip={renderTooltip}
              isMobile={isMobile}
              defaultTooltipDatum={defaultTooltipDatum}
              hasAnimated={hasAnimated}
              getDatumIdentifier={getDatumIdentifier}
            />
          </TooltipProvider>
        );
      }}
    </ParentSize>
  );
}

// Inner component with access to TooltipContext
function ChartContent<T extends object>({
  width,
  height,
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
  isMobile,
  defaultTooltipDatum,
  // hasAnimated,
  getDatumIdentifier,
}: Props<T> & {
  width: number;
  height: number;
  hasAnimated: boolean;
}) {
  const { showTooltip } = useContext(TooltipContext) as TooltipContextType<any>;

  const [selectedDatum] = useState<{
    datum: T;
    dataKey: string;
  } | null>(defaultTooltipDatum ?? null);

  const getDatumIndex = useCallback(
    (datum: T, dataKey: string) => {
      const series = plots.find((p) => p.dataKey === dataKey)?.data || data;
      const idx = series.findIndex(
        (d) => getDatumIdentifier(d) === getDatumIdentifier(datum)
      );

      return idx;
    },
    [data, getDatumIdentifier, plots]
  );

  const triggerTooltipFromDatum = useCallback(
    (datum: T, dataKey: string) => {
      const idx = getDatumIndex(datum, dataKey);
      if (idx < 0) return;

      showTooltip({
        key: dataKey,
        datum: datum,
        index: idx,
      });
    },
    [getDatumIndex, showTooltip]
  );

  useEffect(() => {
    if (selectedDatum) {
      triggerTooltipFromDatum(selectedDatum.datum, selectedDatum.dataKey);
    }
  }, [selectedDatum, triggerTooltipFromDatum]);

  const renderToolTipHandler = useCallback(
    ({ tooltipData }: RenderTooltipParams<T>) => {
      if (!tooltipData || !tooltipData.nearestDatum || !renderTooltip)
        return null;

      if (
        selectedDatum &&
        getDatumIdentifier(selectedDatum.datum) !==
          getDatumIdentifier(tooltipData.nearestDatum.datum)
      ) {
        return null;
      }

      const { key, datum, index } = tooltipData.nearestDatum;

      return (
        <div
          className="p-4"
          style={{ pointerEvents: "auto" }}
          onPointerMove={() => {}}
          onPointerEnter={() => {
            showTooltip({ key, datum, index });
          }}
        >
          {renderTooltip(tooltipData)}
        </div>
      );
    },
    [getDatumIdentifier, renderTooltip, selectedDatum, showTooltip]
  );

  return (
    <XYChart
      width={width}
      key={width}
      height={height}
      xScale={{
        type: xScaleType || "linear",
        padding: 0.2,
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
        ({ dataKey, xAccessor, yAccessor, size = 10, data: plotData }) => (
          <GlyphSeries
            key={dataKey}
            dataKey={dataKey}
            data={plotData || data}
            xAccessor={xAccessor}
            yAccessor={yAccessor}
            renderGlyph={({
              x,
              y,
              key,
              onPointerMove,
              onPointerOut,
              onPointerUp,
              datum,
            }) => {
              // Calculate position for the square (centered at x,y)
              const halfSize = size / 2;
              const isSelected =
                selectedDatum &&
                getDatumIdentifier(selectedDatum.datum) ===
                  getDatumIdentifier(datum) &&
                dataKey === selectedDatum.dataKey;

              return (
                <rect
                  key={key}
                  x={x - halfSize}
                  y={y - halfSize}
                  width={size}
                  height={size}
                  strokeWidth={isMobile ? 0.2 : 1}
                  onPointerMove={onPointerMove}
                  onPointerOut={onPointerOut}
                  onPointerUp={onPointerUp}
                  style={{ pointerEvents: "auto" }}
                  className={cn(
                    "duration-200 fill-primary-60 stroke-white",
                    isSelected && "fill-[#04C870]",
                    selectedDatum && !isSelected && "opacity-30"
                    // !hasAnimated && "animate-translate-from-bottom",
                  )}
                />
              );
            }}
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
          offsetLeft={2}
          offsetTop={4}
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
          showSeriesGlyphs={false}
          className="absolute visx-tooltip-glyph bg-white border border-grey-80 rounded-lg text-grey-70 font-medium shadow-tooltip text-xs"
          unstyled
          renderTooltip={renderToolTipHandler}
        />
      )}
    </XYChart>
  );
}

export default ScatterPlot;
