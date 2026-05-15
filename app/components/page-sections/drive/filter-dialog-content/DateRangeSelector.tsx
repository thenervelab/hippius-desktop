"use client";

import React, { useState, useEffect } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Icons } from "@/components/ui";
import type { DateRange } from "@/app/lib/types/dateRange";

/**
 * Console-equivalent Date Range picker for the desktop drive filters.
 *
 * Two-tap interaction: the first click picks the start date, the
 * second the end date (auto-swapping if the user picks an earlier
 * end). Selected ranges are emitted as `{from, to}` `YYYY-MM-DD`
 * strings — same shape as `hippius-console`'s `DateRangeSelector` so
 * the filter chain on either client interprets the payload identically.
 *
 * Rendered through Radix's DropdownMenu (the rest of the desktop's
 * filter pills already use it) instead of Menubar so the dropdown
 * closes consistently and doesn't conflict with the other selectors.
 */
const FILTER_PILL_TRIGGER_CLASSES = cn(
  "group inline-flex h-8 items-center gap-2 whitespace-nowrap",
  "rounded-[7px] border px-[8px] pr-[10px]",
  "bg-[#fefefe] border-[#e0e0e0]",
  "shadow-[0px_5px_2.3px_0px_rgba(0,0,0,0.03),0px_1px_1.9px_0px_rgba(0,0,0,0.14),0px_0px_1px_0px_rgba(0,0,0,0.16)]",
  "text-[12px] font-medium font-mono uppercase tracking-[-0.24px] leading-[20px]",
  "text-black-700 transition-colors hover:bg-grey-light-700",
  "dark:bg-[rgba(255,255,255,0.02)] dark:border-black-300 dark:text-grey-light-100",
  "dark:shadow-[0px_0px_0px_1px_rgba(0,0,0,1)] dark:hover:bg-black-500",
);

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const formatDate = (date: Date): string =>
  `${MONTHS_SHORT[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;

const formatMonthYear = (date: Date): string =>
  `${MONTHS_LONG[date.getMonth()]} ${date.getFullYear()}`;

const dateToString = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const stringToDate = (dateStr: string): Date => {
  const parts = dateStr.split("-");
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  return new Date(year, month, day);
};

interface DateRangeSelectorProps {
  selectedRange?: DateRange;
  onRangeSelect?: (range: DateRange | undefined) => void;
}

const DateRangeSelector: React.FC<DateRangeSelectorProps> = ({
  selectedRange,
  onRangeSelect,
}) => {
  const [viewDate, setViewDate] = useState(() => new Date());
  const [showYearPicker, setShowYearPicker] = useState(false);
  // First click picks the start, second the end. Once a range is
  // committed, the next click resets to picking a new start.
  const [selectingFrom, setSelectingFrom] = useState(true);
  const [tempFrom, setTempFrom] = useState<Date | null>(
    selectedRange?.from ? stringToDate(selectedRange.from) : null,
  );
  const [tempTo, setTempTo] = useState<Date | null>(
    selectedRange?.to ? stringToDate(selectedRange.to) : null,
  );

  // Re-hydrate when the external range changes (e.g. cleared via the
  // chip "x" button). Without this the calendar would still highlight
  // the old range on the next open.
  useEffect(() => {
    if (!selectedRange) {
      setTempFrom(null);
      setTempTo(null);
      setSelectingFrom(true);
    } else {
      setTempFrom(selectedRange.from ? stringToDate(selectedRange.from) : null);
      setTempTo(selectedRange.to ? stringToDate(selectedRange.to) : null);
    }
  }, [selectedRange]);

  const getDisplayText = () => {
    if (!selectedRange || !selectedRange.from) return "Date Range";
    const fromDate = stringToDate(selectedRange.from);
    const toDate = selectedRange.to ? stringToDate(selectedRange.to) : fromDate;
    if (selectedRange.from === selectedRange.to) {
      return formatDate(fromDate);
    }
    return `${formatDate(fromDate)} - ${formatDate(toDate)}`;
  };

  const handleDateClick = (date: Date) => {
    if (selectingFrom) {
      setTempFrom(date);
      setTempTo(null);
      setSelectingFrom(false);
      return;
    }
    // Second click — commit the range. If the user picked an earlier
    // end date than start, swap them so {from <= to} stays invariant.
    if (tempFrom) {
      const from = date < tempFrom ? date : tempFrom;
      const to = date < tempFrom ? tempFrom : date;
      setTempFrom(from);
      setTempTo(to);
      onRangeSelect?.({
        from: dateToString(from),
        to: dateToString(to),
      });
    }
    setSelectingFrom(true);
  };

  const handleClear = () => {
    setTempFrom(null);
    setTempTo(null);
    setSelectingFrom(true);
    onRangeSelect?.(undefined);
  };

  const navigateToPreviousMonth = () => {
    setViewDate((prev) => {
      const newDate = new Date(prev);
      newDate.setMonth(newDate.getMonth() - 1);
      return newDate;
    });
  };

  const navigateToNextMonth = () => {
    setViewDate((prev) => {
      const newDate = new Date(prev);
      newDate.setMonth(newDate.getMonth() + 1);
      return newDate;
    });
  };

  const generateCalendar = () => {
    const currentMonth = viewDate.getMonth();
    const currentYear = viewDate.getFullYear();

    const firstDay = new Date(currentYear, currentMonth, 1);
    const lastDay = new Date(currentYear, currentMonth + 1, 0);
    const startDate = new Date(firstDay);
    startDate.setDate(startDate.getDate() - firstDay.getDay());

    const calendar = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let week = 0; week < 6; week++) {
      const weekDays = [];
      for (let day = 0; day < 7; day++) {
        const currentDate = new Date(startDate);
        currentDate.setDate(startDate.getDate() + week * 7 + day);
        currentDate.setHours(0, 0, 0, 0);

        const isCurrentMonth = currentDate.getMonth() === currentMonth;
        const isToday = currentDate.getTime() === today.getTime();
        const isFuture = currentDate > today;

        const isInRange = Boolean(
          tempFrom &&
            tempTo &&
            currentDate >= tempFrom &&
            currentDate <= tempTo,
        );
        const isFromDate = Boolean(
          tempFrom && currentDate.getTime() === tempFrom.getTime(),
        );
        const isToDate = Boolean(
          tempTo && currentDate.getTime() === tempTo.getTime(),
        );

        weekDays.push({
          date: currentDate,
          isCurrentMonth,
          isToday,
          isInRange,
          isFromDate,
          isToDate,
          isFuture,
        });
      }
      calendar.push(weekDays);
      if (weekDays[6].date > lastDay) break;
    }
    return calendar;
  };

  const calendar = generateCalendar();
  const today = new Date();

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className={FILTER_PILL_TRIGGER_CLASSES} type="button">
          <div className="text-black-700 dark:text-grey-light-100">
            {getDisplayText()}
          </div>
          <Icons.CalendarNew className="size-4 text-black-700 dark:text-grey-light-100" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="z-50 mt-1 min-w-[20rem] max-w-[22.5rem] rounded-lg border border-grey-80 bg-white p-4 shadow-menu dark:border-black-300 dark:bg-black-primary-bg"
        >
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              {!showYearPicker && (
                <button
                  type="button"
                  onClick={navigateToPreviousMonth}
                  className="rounded p-1 transition-colors hover:bg-grey-90 dark:hover:bg-black-300/40"
                  aria-label="Previous month"
                >
                  <ChevronLeft className="size-4 text-grey-50 dark:text-grey-dark-700" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowYearPicker((v) => !v)}
                className="min-w-[7.5rem] text-center text-sm font-medium text-grey-10 transition-colors hover:text-primary-50 dark:text-grey-dark-200 dark:hover:text-grey-light-100"
              >
                {showYearPicker
                  ? `${viewDate.getFullYear()}`
                  : formatMonthYear(viewDate)}
              </button>
              {!showYearPicker && (
                <button
                  type="button"
                  onClick={navigateToNextMonth}
                  disabled={
                    viewDate.getMonth() === today.getMonth() &&
                    viewDate.getFullYear() === today.getFullYear()
                  }
                  className="rounded p-1 transition-colors hover:bg-grey-90 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-black-300/40"
                  aria-label="Next month"
                >
                  <ChevronRight className="size-4 text-grey-50 dark:text-grey-dark-700" />
                </button>
              )}
            </div>
            <div className="flex gap-2">
              {selectedRange && (
                <button
                  type="button"
                  onClick={handleClear}
                  className="rounded px-2 py-1 text-xs text-primary-50 hover:text-primary-40 dark:text-[#82a3f0]"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          <div className="mb-2 text-center text-xs text-grey-50 dark:text-grey-dark-800">
            {selectingFrom ? "Select start date" : "Select end date"}
          </div>

          <div className="space-y-1">
            {showYearPicker ? (
              <div className="space-y-2">
                <div className="mb-3 text-center text-sm text-grey-50 dark:text-grey-dark-700">
                  Select Year
                </div>
                <div className="grid max-h-48 grid-cols-3 gap-2 overflow-y-auto">
                  {Array.from({ length: 30 }, (_, i) => {
                    const year = new Date().getFullYear() - i;
                    const isCurrentYear = year === new Date().getFullYear();
                    const isSelectedYear = year === viewDate.getFullYear();
                    return (
                      <button
                        key={year}
                        type="button"
                        onClick={() => {
                          setViewDate(new Date(year, viewDate.getMonth(), 1));
                          setShowYearPicker(false);
                        }}
                        className={cn(
                          "rounded p-2 text-sm transition-colors",
                          isSelectedYear
                            ? "bg-primary-50 font-medium text-white"
                            : isCurrentYear
                              ? "bg-primary-100 font-medium text-primary-40 hover:bg-primary-50 hover:text-white dark:bg-black-300/50 dark:text-grey-light-100"
                              : "text-grey-30 hover:bg-grey-90 dark:text-grey-dark-800 dark:hover:bg-black-300/40",
                        )}
                      >
                        {year}
                      </button>
                    );
                  })}
                </div>
                <div className="flex justify-center pt-3">
                  <button
                    type="button"
                    onClick={() => setShowYearPicker(false)}
                    className="rounded px-3 py-1 text-sm text-primary-50 hover:text-primary-40 dark:text-[#82a3f0]"
                  >
                    Back to Calendar
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="mb-2 grid grid-cols-7 gap-1">
                  {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
                    <div
                      key={day}
                      className="py-1 text-center text-xs font-medium text-grey-50 dark:text-grey-dark-700"
                    >
                      {day}
                    </div>
                  ))}
                </div>

                {calendar.map((week, weekIndex) => (
                  <div key={weekIndex} className="grid grid-cols-7 gap-1">
                    {week.map((dayObj, dayIndex) => (
                      <button
                        key={dayIndex}
                        type="button"
                        onClick={() => {
                          if (dayObj.isFuture) return;
                          if (!dayObj.isCurrentMonth) {
                            setViewDate(
                              new Date(
                                dayObj.date.getFullYear(),
                                dayObj.date.getMonth(),
                                1,
                              ),
                            );
                          }
                          handleDateClick(dayObj.date);
                        }}
                        disabled={dayObj.isFuture}
                        className={cn(
                          "relative min-h-[1.75rem] rounded py-2 px-1 text-xs transition-colors",
                          !dayObj.isCurrentMonth
                            ? "cursor-pointer text-grey-80 hover:bg-grey-90 dark:text-black-300 dark:hover:bg-black-300/30"
                            : dayObj.isFuture
                              ? "cursor-not-allowed text-grey-80 dark:text-black-300"
                              : "cursor-pointer text-grey-30 hover:bg-grey-90 dark:text-grey-dark-800 dark:hover:bg-black-300/40",
                          dayObj.isToday &&
                            !dayObj.isFromDate &&
                            !dayObj.isToDate &&
                            "bg-primary-100 font-medium text-primary-40 dark:bg-black-300/50 dark:text-grey-light-100",
                          dayObj.isInRange &&
                            !dayObj.isFromDate &&
                            !dayObj.isToDate &&
                            "bg-primary-80 text-white dark:bg-transparent dark:text-grey-light-100",
                          (dayObj.isFromDate || dayObj.isToDate) &&
                            "bg-primary-50 font-medium text-white hover:bg-primary-50 hover:text-white dark:bg-grey-light-100 dark:text-primary-50",
                        )}
                      >
                        {dayObj.date.getDate()}
                      </button>
                    ))}
                  </div>
                ))}
              </>
            )}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
};

export default DateRangeSelector;
