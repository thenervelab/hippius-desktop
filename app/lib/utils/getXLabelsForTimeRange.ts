import { MONTHS } from "./getXlablesForAccounts";
import { ChartPoint } from "./getFormatDataForCreditsUsageChart";
import { Account } from "../types/accounts";

/**
 * Generates X-axis labels based on the selected time range and chart data
 * @param formattedChartData Formatted data points for the chart
 * @param chartData Raw account data (needed for year calculation)
 * @param timeRange Selected time range (last7days, last30days, last60days, year)
 * @returns Array of string labels for the X-axis
 */
export function getXLabelsForTimeRange(
  formattedChartData: ChartPoint[],
  chartData: Account[] | undefined,
  timeRange: string
): string[] {
  let xLabels: string[] = [];

  if (timeRange === "last7days") {
    // Use the day names for the last 7 days
    xLabels = formattedChartData.map((point) =>
      new Date(point.x).toLocaleDateString("en-US", { weekday: "short" })
    );
  } else if (timeRange === "last30days" || timeRange === "last60days") {
    // For 30/60 days, create 8 evenly distributed date labels
    if (formattedChartData.length > 0) {
      // Create a sorted array of dates first to ensure chronological order
      const sortedDates = formattedChartData
        .map((point) => new Date(point.x))
        .sort((a, b) => a.getTime() - b.getTime());

      // Calculate interval to get 8 labels evenly distributed
      const interval = Math.max(1, Math.floor(sortedDates.length / 8));

      // Generate labels from sorted dates at regular intervals
      for (let i = 0; i < sortedDates.length; i += interval) {
        if (xLabels.length < 11) {
          // Keep space for the last date
          const date = sortedDates[i];
          xLabels.push(`${date.getDate()} ${MONTHS[date.getMonth()]}`);
        }
      }
      let lastDate;
      // Always include the most recent date (last date)
      if (timeRange === "last30days") {
        lastDate = sortedDates[sortedDates.length - 2];
      } else {
        lastDate = sortedDates[sortedDates.length - 4];
      }
      const lastLabel = `${lastDate.getDate()} ${MONTHS[lastDate.getMonth()]}`;
      if (!xLabels.includes(lastLabel)) {
        xLabels.push(lastLabel);
      }
    }
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

  return xLabels;
}
