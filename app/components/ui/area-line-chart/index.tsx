/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  XYChart,
  AnimatedAxis,
  Tooltip,
  TooltipData,
  AnimatedLineSeries,
} from "@visx/xychart";
import ParentSize from "@visx/responsive/lib/components/ParentSize";
import type { Margin, AxisScale } from "@visx/xychart";
import { AnimatedAxisProps } from "@visx/xychart/lib/components/axis/AnimatedAxis";
import { ScaleType } from "@visx/scale";
import { scaleBand, scaleLinear, scaleTime } from "@visx/scale";
import { ReactNode, useEffect, useMemo, useRef } from "react";
import { line as d3Line, area as d3Area, curveLinear } from "d3-shape";
import { interpolatePath } from "d3-interpolate-path";
import * as flubber from "flubber";
import { animated, useSpring } from "@react-spring/web";
import { InView } from "react-intersection-observer";

type BandConfig = {
  paddingInner: number;
  paddingOuter: number;
  align: number;
};

type Plot<T> = {
  dataKey: string;
  xAccessor: (data: T) => any; // band or time/linear value
  yAccessor: (data: T) => number;
  lineColor?: string;
  lineType?: "solid" | "dashed";
  lineModifier?: "faded";
  areaColor?: string;
  strokeWidth?: number;
  customDashArray?: string;
};

type Props<T extends object> = {
  data: T[];
  plots: Plot<T>[];

  // Band domain (ordered labels) or [min, max] for time/linear
  xDomain?: any[];

  yDomain?: [any, any];

  renderTooltip?: (data?: TooltipData<T>) => ReactNode;
  margin?: Margin;
  yScaleType?: ScaleType;
  xScaleType?: ScaleType;
  bandScaleConfig?: BandConfig;
  xAxisProps?: Partial<AnimatedAxisProps<AxisScale>>;
  yAxisProps?: Partial<AnimatedAxisProps<AxisScale>>;
  showVerticalCrosshair?: boolean;
  showHorizontalCrosshair?: boolean;
  showOnlyNearestGlyph?: boolean;
};

function usePrevious<T>(v: T) {
  const ref = useRef<T>(v);
  useEffect(() => {
    ref.current = v;
  }, [v]);
  return ref.current;
}

type AnyXScale =
  | ReturnType<typeof scaleBand<string>>
  | ReturnType<typeof scaleLinear<number>>
  | ReturnType<typeof scaleTime>;

function getBandDomain<T>(
  data: T[],
  xAccessor: (d: T) => any,
  explicitDomain?: any[],
): string[] {
  if (explicitDomain && explicitDomain.length) {
    return explicitDomain as string[];
  }

  const domain: string[] = [];
  const seen = new Set<string>();

  for (const datum of data) {
    const raw = xAccessor(datum);
    const value = typeof raw === "string" ? raw : String(raw);
    if (!seen.has(value)) {
      seen.add(value);
      domain.push(value);
    }
  }

  return domain;
}

function getContinuousDomain<T>(
  data: T[],
  xAccessor: (d: T) => any,
  explicitDomain?: any[],
): [any, any] | undefined {
  if (explicitDomain && explicitDomain.length >= 2) {
    return [explicitDomain[0], explicitDomain[1]];
  }

  if (!data.length) {
    return undefined;
  }

  let min = Infinity;
  let max = -Infinity;
  let isDate = false;

  for (const datum of data) {
    const raw = xAccessor(datum);
    if (raw instanceof Date) {
      isDate = true;
    }
    const num =
      raw instanceof Date
        ? raw.getTime()
        : typeof raw === "number"
          ? raw
          : Number(raw);
    if (!Number.isFinite(num)) {
      continue;
    }
    if (num < min) min = num;
    if (num > max) max = num;
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return undefined;
  }

  return isDate ? [new Date(min), new Date(max)] : [min, max];
}

/** Build x + y scales locally (mirror XYChart config) */
function buildLocalScales(
  width: number,
  height: number,
  margin: Margin | undefined,
  xScaleType: ScaleType | undefined,
  xDomain: any[] | undefined,
  yDomain: [number, number] | undefined,
  bandCfg: BandConfig | undefined,
) {
  const m = {
    top: margin?.top ?? 0,
    right: margin?.right ?? 0,
    bottom: margin?.bottom ?? 0,
    left: margin?.left ?? 0,
  };

  const resolvedXScaleType = (xScaleType || "band") as ScaleType;
  let x: AnyXScale;

  if (resolvedXScaleType === "band") {
    x = scaleBand<string>({
      domain: (xDomain as string[]) || [],
      range: [m.left, width - m.right],
      paddingInner: 1,
      paddingOuter: bandCfg?.paddingOuter ?? 0.5,
      align: bandCfg?.align ?? 0.5,
    });
  } else if (resolvedXScaleType === "time") {
    x = scaleTime({
      domain: (xDomain as [any, any]) || [0, 1],
      range: [m.left, width - m.right],
    });
  } else {
    x = scaleLinear({
      domain: (xDomain as [number, number]) || [0, 1],
      range: [m.left, width - m.right],
    });
  }

  const y = scaleLinear<number>({
    domain: yDomain ? [Number(yDomain[0]), Number(yDomain[1])] : [0, 1],
    range: [height - m.bottom, m.top],
    nice: false,
  });

  return { x, y, margin: m };
}

/** Create current area + line path strings from data + local scales */
function makePaths<T>(
  data: T[],
  xAcc: (d: T) => any,
  yAcc: (d: T) => number,
  x: AnyXScale,
  y: ReturnType<typeof scaleLinear<number>>,
  m: Required<Margin>,
  height: number,
  xScaleType: ScaleType | undefined,
) {
  if (!data?.length) {
    return {
      areaD: "",
      lineD: "",
      baselineAreaD: "",
      baselineLineD: "",
    };
  }

  const resolvedXScaleType = (xScaleType || "band") as ScaleType;
  const xCenter = (d: T) => {
    if (resolvedXScaleType === "band") {
      const bandScale = x as ReturnType<typeof scaleBand<string>>;
      const x0 = bandScale(xAcc(d));
      return (x0 ?? 0) + bandScale.bandwidth() / 2;
    }
    const continuousScale = x as (value: any) => number | undefined;
    const x0 = continuousScale(xAcc(d));
    return x0 ?? 0;
  };
  const y1 = (d: T) => y(yAcc(d));

  const y0px = height - m.bottom;

  const lineGen = d3Line<T>().x(xCenter).y(y1).curve(curveLinear);
  const areaGen = d3Area<T>().x(xCenter).y1(y1).y0(y0px).curve(curveLinear);

  const baselineLineGen = d3Line<T>()
    .x(xCenter)
    .y(() => y0px)
    .curve(curveLinear);
  const baselineAreaGen = d3Area<T>()
    .x(xCenter)
    .y1(() => y0px)
    .y0(() => y0px)
    .curve(curveLinear);

  return {
    lineD: lineGen(data) || "",
    areaD: areaGen(data) || "",
    baselineLineD: baselineLineGen(data) || "",
    baselineAreaD: baselineAreaGen(data) || "",
  };
}

/** Morph AREA with flubber (closed shapes) */
function MorphingAreaPath({
  d,
  fill,
  opacity = 1,
  duration = 300,
  t,
  initialD,
}: {
  d: string;
  fill: string;
  opacity?: number;
  duration?: number;
  t?: any;
  initialD?: string;
}) {
  const prevD = usePrevious(d);
  const hasAnimatedFromInitial = useRef(false);

  useEffect(() => {
    if (!d?.length) {
      hasAnimatedFromInitial.current = false;
      return;
    }
    if (!hasAnimatedFromInitial.current) {
      hasAnimatedFromInitial.current = true;
    }
  }, [d]);

  const interp = useMemo(() => {
    const shouldUseInitial =
      !hasAnimatedFromInitial.current && Boolean(initialD?.length);
    const from = shouldUseInitial
      ? (initialD as string)
      : prevD && prevD.length
        ? prevD
        : d;
    const to = d;
    try {
      return flubber.interpolate(from, to, { maxSegmentLength: 4 });
    } catch {
      return (t: number) => (t < 1 ? from : to);
    }
  }, [d, prevD, initialD]);

  // If t is provided (shared animation), use it; otherwise create local animation
  const { t: localT } = useSpring({
    from: { t: 0 },
    to: { t: 1 },
    reset: prevD !== d,
    config: { duration },
  });

  const animation = t || localT;

  return (
    <animated.path
      d={animation.to(interp)}
      fill={fill}
      opacity={opacity}
      stroke="none"
      pointerEvents="none"
    />
  );
}

/** Morph LINE with d3-interpolate-path (open paths) */
function MorphingLinePath({
  d,
  stroke,
  strokeDasharray,
  strokeWidth = 2,
  opacity = 1,
  duration = 300,
  t,
  initialD,
}: {
  d: string;
  stroke: string;
  strokeDasharray?: string;
  strokeWidth?: number;
  opacity?: number;
  duration?: number;
  t?: any;
  initialD?: string;
}) {
  const prevD = usePrevious(d);
  const hasAnimatedFromInitial = useRef(false);

  useEffect(() => {
    if (!d?.length) {
      hasAnimatedFromInitial.current = false;
      return;
    }
    if (!hasAnimatedFromInitial.current) {
      hasAnimatedFromInitial.current = true;
    }
  }, [d]);

  const interp = useMemo(() => {
    const shouldUseInitial =
      !hasAnimatedFromInitial.current && Boolean(initialD?.length);
    const from = shouldUseInitial
      ? (initialD as string)
      : prevD && prevD.length
        ? prevD
        : d;
    const to = d;
    try {
      return interpolatePath(from, to);
    } catch {
      return (t: number) => (t < 1 ? from : to);
    }
  }, [d, prevD, initialD]);

  // If t is provided (shared animation), use it; otherwise create local animation
  const { t: localT } = useSpring({
    from: { t: 0 },
    to: { t: 1 },
    reset: prevD !== d,
    config: { duration },
  });

  const animation = t || localT;

  return (
    <animated.path
      d={animation.to(interp)}
      fill="none"
      stroke={stroke}
      strokeWidth={strokeWidth}
      strokeDasharray={strokeDasharray}
      opacity={opacity}
      pointerEvents="none"
    />
  );
}

/** One band series that morphs between datasets */
function MorphingBandSeries<T>({
  dataKey,
  data,
  xAccessor,
  yAccessor,
  lineColor = "#3167DD",
  lineType,
  lineModifier,
  areaColor = "url(#area-gradient)",
  strokeWidth = 2,
  customDashArray,
  x,
  y,
  m,
  height,
  xScaleType,
  shouldAnimate = true,
}: {
  dataKey: string;
  data: T[];
  xAccessor: (d: T) => any;
  yAccessor: (d: T) => number;
  lineColor?: string;
  lineType?: "solid" | "dashed";
  lineModifier?: "faded";
  areaColor?: string;
  strokeWidth?: number;
  customDashArray?: string;
  x: AnyXScale;
  y: ReturnType<typeof scaleLinear<number>>;
  m: Required<Margin>;
  height: number;
  xScaleType?: ScaleType;
  shouldAnimate?: boolean;
}) {
  const { lineD, areaD, baselineLineD, baselineAreaD } = useMemo(
    () => makePaths(data, xAccessor, yAccessor, x, y, m, height, xScaleType),
    [data, xAccessor, yAccessor, x, y, m, height, xScaleType],
  );

  // Create shared animation for both line and area
  const prevLineD = usePrevious(lineD);
  const prevAreaD = usePrevious(areaD);
  const prevShouldAnimate = usePrevious(shouldAnimate);
  const hasAnimatedOnceRef = useRef(false);

  useEffect(() => {
    if (shouldAnimate && !hasAnimatedOnceRef.current && lineD) {
      hasAnimatedOnceRef.current = true;
    }
  }, [shouldAnimate, lineD]);

  const animationDuration = hasAnimatedOnceRef.current ? 300 : 550;

  const { t } = useSpring({
    from: { t: 0 },
    to: { t: shouldAnimate ? 1 : 0 },
    pause: !shouldAnimate,
    reset:
      prevLineD !== lineD ||
      prevAreaD !== areaD ||
      (!prevShouldAnimate && shouldAnimate),
    config: { duration: animationDuration },
  });

  const opacity = lineModifier === "faded" ? 0.15 : 1;
  const dash = customDashArray || (lineType === "dashed" ? "6 6" : undefined);

  // Invisible hit series for tooltip/crosshair
  return (
    <>
      <AnimatedLineSeries
        dataKey={`${dataKey}-hit`}
        data={data as any[]}
        xAccessor={xAccessor as any}
        yAccessor={yAccessor as any}
        stroke="transparent"
      />
      <MorphingAreaPath
        d={areaD}
        initialD={baselineAreaD}
        fill={areaColor!}
        opacity={opacity}
        duration={animationDuration}
        t={t}
      />
      <MorphingLinePath
        d={lineD}
        initialD={baselineLineD}
        stroke={lineColor!}
        strokeWidth={strokeWidth}
        strokeDasharray={dash}
        opacity={opacity}
        duration={animationDuration}
        t={t}
      />
    </>
  );
}

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
  bandScaleConfig,
  showOnlyNearestGlyph = false,
}: Props<T>) {
  const nearestDatumKeyRef = useRef<string | null>(null);

  const yScaleCfg = useMemo(
    () => ({
      type: (yScaleType || "linear") as "linear",
      zero: false,
      ...(yDomain ? { domain: yDomain } : {}),
    }),
    [yScaleType, yDomain],
  );

  return (
    <InView triggerOnce threshold={0.15}>
      {({ ref, inView }) => (
        <div ref={ref} className="h-full w-full">
          <ParentSize className="h-full w-full">
            {({ width, height }) => {
              const shouldAnimate = inView;
              const primaryXAccessor = plots[0]?.xAccessor;
              const resolvedXScaleType = (xScaleType || "band") as ScaleType;
              const derivedXDomain = primaryXAccessor
                ? resolvedXScaleType === "band"
                  ? getBandDomain(
                      data,
                      primaryXAccessor as (d: T) => any,
                      xDomain as any[],
                    )
                  : getContinuousDomain(
                      data,
                      primaryXAccessor as (d: T) => any,
                      xDomain as any[],
                    )
                : resolvedXScaleType === "band"
                  ? (xDomain as string[]) || []
                  : getContinuousDomain(
                      data,
                      (d: T) => (d as any)?.x,
                      xDomain as any[],
                    );

              const xScaleCfg =
                resolvedXScaleType === "band"
                  ? {
                      type: "band" as const,
                      domain: (derivedXDomain as string[]) || [],
                      paddingInner: 1,
                      paddingOuter: bandScaleConfig?.paddingOuter ?? 0.5,
                      align: bandScaleConfig?.align ?? 0.5,
                    }
                  : {
                      type: resolvedXScaleType as "time" | "linear",
                      ...(derivedXDomain ? { domain: derivedXDomain } : {}),
                    };

              // local scales for path building (no visx context needed)
              const {
                x,
                y,
                margin: m,
              } = buildLocalScales(
                width,
                height,
                margin,
                resolvedXScaleType,
                derivedXDomain as any[],
                (yDomain as [number, number]) || undefined,
                bandScaleConfig,
              );

              return (
                <XYChart
                  width={width}
                  height={height}
                  xScale={xScaleCfg as any}
                  yScale={yScaleCfg as any}
                  margin={margin}
                >
                  {/* gradients */}
                  <defs>
                    <linearGradient
                      id="area-gradient"
                      x1="0"
                      x2="0"
                      y1="0"
                      y2="1"
                    >
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
                  <defs>
                    <linearGradient
                      id="area-gradient2"
                      x1="0"
                      x2="0"
                      y1="0"
                      y2="1"
                    >
                      <stop stopColor="#3167DD" stopOpacity="0.2" />
                      <stop offset="1" stopColor="#3167DD" stopOpacity="0.1" />
                    </linearGradient>
                  </defs>

                  {/* X Axis */}
                  <AnimatedAxis
                    key="x-axis"
                    labelProps={{
                      className: "fill-grey-10 animate-fade-in-0.3",
                      fontSize: 12,
                    }}
                    axisLineClassName="stroke-[#B4C8F3]"
                    orientation="bottom"
                    strokeWidth={3}
                    {...xAxisProps}
                    tickLabelProps={
                      xAxisProps?.tickLabelProps
                        ? typeof xAxisProps.tickLabelProps === "function"
                          ? (...args: any[]) => ({
                              ...(xAxisProps.tickLabelProps as any)(...args),
                              fontWeight: 500,
                              fontFamily: "Geist",
                              className: "fill-grey-60",
                            })
                          : {
                              ...xAxisProps.tickLabelProps,
                              fontWeight: 500,
                              fontFamily: "Geist",
                              className: "fill-grey-60",
                            }
                        : {
                            className: "fill-grey-60",
                            fontWeight: 500,
                          }
                    }
                  />

                  {/* Y Axis */}
                  <AnimatedAxis
                    key="y-axis"
                    labelProps={{
                      className: "fill-grey-10 animate-fade-in-0.3",
                      fontSize: 12,
                    }}
                    orientation="left"
                    hideTicks={true}
                    strokeWidth={3}
                    axisLineClassName="stroke-[#B4C8F3]"
                    rangePadding={{ start: 0, end: 0 }}
                    tickFormat={yAxisProps?.tickFormat}
                    {...yAxisProps}
                    tickLabelProps={
                      yAxisProps?.tickLabelProps
                        ? typeof yAxisProps.tickLabelProps === "function"
                          ? (...args: any[]) => ({
                              ...(yAxisProps.tickLabelProps as any)(...args),
                              fontWeight: 500,
                              fontFamily: "Geist",
                            })
                          : {
                              ...yAxisProps.tickLabelProps,
                              fontWeight: 500,
                              fontFamily: "Geist",
                            }
                        : {
                            className: "fill-grey-60",
                            fontWeight: 500,
                            fontFamily: "Geist",
                            textAnchor: "end",
                            verticalAnchor: "middle",
                            dx: -2,
                            angle: -35,
                            fontSize: 10,
                          }
                    }
                  />

                  {/* series (morphed) */}
                  {plots.map(
                    ({
                      dataKey,
                      xAccessor,
                      yAccessor,
                      lineColor,
                      lineType,
                      lineModifier,
                      areaColor,
                      strokeWidth,
                      customDashArray,
                    }) => (
                      <g key={dataKey}>
                        <MorphingBandSeries
                          dataKey={dataKey}
                          data={data}
                          xAccessor={xAccessor as any}
                          yAccessor={yAccessor as any}
                          lineColor={lineColor}
                          lineType={lineType}
                          lineModifier={lineModifier}
                          areaColor={areaColor ?? "url(#area-gradient2)"}
                          strokeWidth={strokeWidth}
                          customDashArray={customDashArray}
                          x={x}
                          y={y}
                          m={m as Required<Margin>}
                          height={height}
                          xScaleType={resolvedXScaleType}
                          shouldAnimate={shouldAnimate}
                        />
                      </g>
                    ),
                  )}

                  {/* tooltip */}
                  {renderTooltip && (
                    <Tooltip<T>
                      showVerticalCrosshair={showVerticalCrosshair}
                      showHorizontalCrosshair={showHorizontalCrosshair}
                      snapTooltipToDatumX
                      snapTooltipToDatumY
                      showSeriesGlyphs
                      horizontalCrosshairStyle={{
                        stroke: "#868e96",
                        strokeWidth: 1,
                        strokeDasharray: "4 4",
                      }}
                      verticalCrosshairStyle={{
                        stroke: "#868e96",
                        strokeWidth: 1,
                        strokeDasharray: "4 4",
                      }}
                      renderGlyph={({ x, y, key }) => {
                        // Only show glyph for the nearest/hovered series if prop is enabled
                        if (
                          showOnlyNearestGlyph &&
                          nearestDatumKeyRef.current !== key
                        ) {
                          return null;
                        }

                        const isFirstPlot = key === `${plots[0]?.dataKey}-hit`;
                        const glyphColor = isFirstPlot ? "#1e40af" : "#2563eb";
                        return (
                          <circle
                            cx={x}
                            cy={y}
                            r={4}
                            fill={glyphColor}
                            stroke={"#FFFFFF"}
                            strokeWidth={1}
                          />
                        );
                      }}
                      unstyled
                      className="p-4 absolute bg-white border border-grey-80 rounded-lg text-grey-70 font-medium shadow-tooltip text-xs"
                      renderTooltip={({ tooltipData }) => {
                        // Update the nearest datum key
                        nearestDatumKeyRef.current =
                          tooltipData?.nearestDatum?.key || null;
                        return renderTooltip(tooltipData);
                      }}
                    />
                  )}
                </XYChart>
              );
            }}
          </ParentSize>
        </div>
      )}
    </InView>
  );
}

export default AreaLineChart;
