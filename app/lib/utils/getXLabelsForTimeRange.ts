import { ChartPoint } from "@/lib/types/chartTypes";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Generates X-axis labels based on the selected time range and chart data
 * @param formattedChartData Formatted data points for the chart
 * @param timeRange Selected time range (last7days, last30days, last60days, year, max)
 * @returns Array of tick values with labels for the X-axis
 */
export interface XAxisTick {
  value: Date;
  label: string;
}

export function getXLabelsForTimeRange(
  formattedChartData: ChartPoint[],
  timeRange: string,
): XAxisTick[] {
  const ticks: XAxisTick[] = [];
  const seen = new Set<number>();
  const formatDateLabel = (date: Date) =>
    `${MONTHS[date.getMonth()]} ${String(date.getDate()).padStart(2, "0")}`;
  const addTick = (date: Date, label: string) => {
    const time = date.getTime();
    if (seen.has(time)) return;
    seen.add(time);
    ticks.push({ value: date, label });
  };

  if (timeRange === "last7days") {
    // Use the day names for the last 7 days
    formattedChartData.forEach((point) => {
      const date = new Date(point.x);
      addTick(
        date,
        date.toLocaleDateString("en-US", { weekday: "short" }),
      );
    });
    return ticks;
  }

  if (!formattedChartData.length) {
    return ticks;
  }

  const sortedPoints = [...formattedChartData].sort(
    (a, b) => new Date(a.x).getTime() - new Date(b.x).getTime(),
  );

  let desiredTicks = 10;
  if (timeRange === "last30days") {
    desiredTicks = 10;
  } else if (timeRange === "last60days") {
    desiredTicks = 10;
  } else if (timeRange === "year") {
    desiredTicks = 10;
  } else if (timeRange === "max") {
    desiredTicks = 10;
  }

  const interval = Math.max(1, Math.ceil(sortedPoints.length / desiredTicks));
  for (let i = 0; i < sortedPoints.length; i += interval) {
    const point = sortedPoints[i];
    const date = new Date(point.x);
    addTick(date, formatDateLabel(date));
  }

  return ticks;
}
