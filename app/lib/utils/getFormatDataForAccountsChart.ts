// src/app/lib/utils/getFormatDataForAccountsChart.ts

import { formatBalance } from ".";
import type { Account } from "../types/accounts";

export interface ChartPoint {
  x: Date;
  balance: number;
  formattedBalance: string;
  timestamp: string;
  dayLabel?: string;
  bandLabel?: string;
}

// Helpers to format dates
const formatDayName = (d: Date) =>
  d.toLocaleDateString("en-US", { weekday: "long" }).toUpperCase();
const formatDateForMonth = (d: Date) =>
  d
    .toLocaleDateString("en-US", { day: "2-digit", month: "short" })
    .toUpperCase();
const formatDateForYear = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "short" }).toUpperCase();

// Generate placeholder days for week view
const generateWeekDays = (): { [key: string]: string } => {
  const days = {
    MONDAY: "MONDAY",
    TUESDAY: "TUESDAY",
    WEDNESDAY: "WEDNESDAY",
    THURSDAY: "THURSDAY",
    FRIDAY: "FRIDAY",
    SATURDAY: "SATURDAY",
    SUNDAY: "SUNDAY",
  };
  return days;
};

// Main function to format accounts data for chart display
export function formatAccountsForChartByRange(
  accounts: Account[],
  range: "week" | "month" | "quarter" | "year"
): ChartPoint[] {
  if (!accounts || accounts.length === 0) {
    return [];
  }

  // Sort accounts by timestamp (oldest to newest)
  const sortedAccounts = [...accounts].sort(
    (a, b) =>
      new Date(a.processed_timestamp).getTime() -
      new Date(b.processed_timestamp).getTime()
  );

  // For week view, ensure all days are represented
  if (range === "week") {
    const weekDays = generateWeekDays();
    const result: ChartPoint[] = [];
    const daysData: { [key: string]: Account } = {};

    // Group account data by day of week
    sortedAccounts.forEach((account) => {
      const date = new Date(account.processed_timestamp);
      const day = formatDayName(date);

      // Keep the newest data for each day
      if (
        !daysData[day] ||
        new Date(account.processed_timestamp) >
          new Date(daysData[day].processed_timestamp)
      ) {
        daysData[day] = account;
      }
    });

    // Create chart points for each day of the week
    let lastValidBalance = 0;
    let lastValidTimestamp = "";

    // Use ordered weekdays to ensure correct display
    // Helper to get the date for a given weekday name in the current week
    const getDateForWeekday = (weekday: string): Date => {
      const weekdays = [
        "SUNDAY",
        "MONDAY",
        "TUESDAY",
        "WEDNESDAY",
        "THURSDAY",
        "FRIDAY",
        "SATURDAY",
      ];
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const currentDay = today.getDay();
      const targetDay = weekdays.indexOf(weekday);
      // Calculate the date for the target weekday in the current week (Sunday to Saturday)
      const diff = targetDay - currentDay;
      const date = new Date(today);
      date.setDate(today.getDate() + diff);
      return date;
    };

    Object.keys(weekDays).forEach((day) => {
      const dateForDay = getDateForWeekday(day);
      if (daysData[day]) {
        // We have data for this day
        const account = daysData[day];
        const balanceVal = Number(account.total_balance) / Math.pow(10, 18);

        result.push({
          x: dateForDay,
          balance: balanceVal,
          formattedBalance: formatBalance(account.total_balance, 6),
          timestamp: account.processed_timestamp,
          dayLabel: day,
        });

        // Update last valid values
        lastValidBalance = balanceVal;
        lastValidTimestamp = account.processed_timestamp;
      } else {
        // No data for this day, use last valid data
        result.push({
          x: dateForDay,
          balance: lastValidBalance,
          formattedBalance: formatBalance(
            (lastValidBalance * Math.pow(10, 18)).toString(),
            6
          ),
          timestamp: lastValidTimestamp || new Date().toISOString(),
          dayLabel: day,
        });
      }
    });

    return result;
  } else {
    // For month, quarter, year: Group by appropriate date format
    const dateFormat =
      range === "year" ? formatDateForYear : formatDateForMonth;
    const groupedData: { [key: string]: Account } = {};

    sortedAccounts.forEach((account) => {
      const date = new Date(account.processed_timestamp);
      const key = dateFormat(date);

      // Keep the newest data for each date format
      if (
        !groupedData[key] ||
        new Date(account.processed_timestamp) >
          new Date(groupedData[key].processed_timestamp)
      ) {
        groupedData[key] = account;
      }
    });

    // Create chart points from grouped data
    const result: ChartPoint[] = Object.entries(groupedData).map(
      ([, account]) => {
        const balanceVal = Number(account.total_balance) / Math.pow(10, 18);
        const date = new Date(account.processed_timestamp);
        return {
          x: date,
          balance: balanceVal,
          formattedBalance: formatBalance(account.total_balance, 6),
          timestamp: account.processed_timestamp,
        };
      }
    );

    // Sort points by timestamp
    return result.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }
}
