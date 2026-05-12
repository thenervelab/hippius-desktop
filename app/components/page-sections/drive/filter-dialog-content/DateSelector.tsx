import React, { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Icons } from "@/components/ui";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

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

interface DateSelectorProps {
  selectedDate?: string;
  onDateSelect?: (date: string) => void;
}

// Helper function to format date
const formatDate = (date: Date): string => {
  const months = [
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
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
};

// Helper function to format month year
const formatMonthYear = (date: Date): string => {
  const months = [
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
  return `${months[date.getMonth()]} ${date.getFullYear()}`;
};

const DateSelector: React.FC<DateSelectorProps> = ({
  selectedDate,
  onDateSelect,
}) => {
  const [viewDate, setViewDate] = useState(() => new Date()); // Current month/year being viewed
  const [showYearPicker, setShowYearPicker] = useState(false);
  const [selectedDateObj, setSelectedDateObj] = useState<Date | null>(() => {
    if (!selectedDate || selectedDate === "") return null;
    // Parse YYYY-MM-DD format properly to avoid timezone issues
    const parts = selectedDate.split("-");
    if (parts.length === 3) {
      const year = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1; // Month is 0-based
      const day = parseInt(parts[2], 10);
      return new Date(year, month, day);
    }
    return new Date(selectedDate);
  });

  const getDisplayText = () => {
    if (!selectedDate || selectedDate === "") return "Date";
    try {
      // Parse YYYY-MM-DD format properly to avoid timezone issues
      const parts = selectedDate.split("-");
      if (parts.length === 3) {
        const year = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1; // Month is 0-based
        const day = parseInt(parts[2], 10);
        const date = new Date(year, month, day);
        return formatDate(date);
      }
      const date = new Date(selectedDate);
      return formatDate(date);
    } catch {
      return "Date";
    }
  };

  const handleDateSelect = (date: Date) => {
    setSelectedDateObj(date);
    // Create YYYY-MM-DD format using local timezone (not UTC)
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const dateString = `${year}-${month}-${day}`;
    onDateSelect?.(dateString);
  };

  const handleClear = () => {
    setSelectedDateObj(null);
    onDateSelect?.("");
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

        const isCurrentMonth = currentDate.getMonth() === currentMonth;
        const isToday = currentDate.getTime() === today.getTime();
        const isSelected =
          selectedDateObj &&
          currentDate.getTime() ===
            new Date(selectedDateObj.toDateString()).getTime();
        const isFuture = currentDate > today;

        weekDays.push({
          date: currentDate,
          isCurrentMonth,
          isToday,
          isSelected,
          isFuture,
        });
      }
      calendar.push(weekDays);

      // Break if we've filled the month
      if (weekDays[6].date > lastDay) break;
    }

    return calendar;
  };

  const calendar = generateCalendar();
  const today = new Date();

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className={FILTER_PILL_TRIGGER_CLASSES}>
          <div className="text-black-700 dark:text-grey-light-100">
            {getDisplayText()}
          </div>
          <Icons.CalendarNew className="size-4 text-black-700 dark:text-grey-light-100" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="mt-1 bg-white border border-grey-80 rounded-lg p-4 shadow-menu min-w-[20rem] max-w-[22.5rem] z-50"
          align="start"
          sideOffset={4}
        >
          {/* Calendar Header */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              {!showYearPicker && (
                <button
                  onClick={navigateToPreviousMonth}
                  className="p-1 hover:bg-grey-90 rounded transition-colors"
                  aria-label="Previous month"
                >
                  <ChevronLeft className="h-4 w-4 text-grey-50" />
                </button>
              )}
              <button
                onClick={() => setShowYearPicker(!showYearPicker)}
                className="text-sm font-medium text-grey-10 min-w-[7.5rem] text-center hover:text-primary-50 transition-colors"
              >
                {showYearPicker
                  ? `${viewDate.getFullYear()}`
                  : formatMonthYear(viewDate)}
              </button>
              {!showYearPicker && (
                <button
                  onClick={navigateToNextMonth}
                  disabled={
                    viewDate.getMonth() === today.getMonth() &&
                    viewDate.getFullYear() === today.getFullYear()
                  }
                  className="p-1 hover:bg-grey-90 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Next month"
                >
                  <ChevronRight className="h-4 w-4 text-grey-50" />
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setViewDate(new Date())}
                className="text-xs text-primary-50 hover:text-primary-40 px-2 py-1 rounded"
              >
                Today
              </button>
              {selectedDate && (
                <button
                  onClick={handleClear}
                  className="text-xs text-primary-50 hover:text-primary-40 px-2 py-1 rounded"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Content Area */}
          <div className="space-y-1">
            {showYearPicker ? (
              /* Year Picker */
              <div className="space-y-2">
                <div className="text-center text-sm text-grey-50 mb-3">
                  Select Year
                </div>
                <div className="grid grid-cols-3 gap-2 max-h-48 overflow-y-auto">
                  {Array.from({ length: 30 }, (_, i) => {
                    const year = new Date().getFullYear() - i;
                    const isCurrentYear = year === new Date().getFullYear();
                    const isSelectedYear = year === viewDate.getFullYear();

                    return (
                      <button
                        key={year}
                        onClick={() => {
                          setViewDate(new Date(year, viewDate.getMonth(), 1));
                          setShowYearPicker(false);
                        }}
                        className={cn(
                          "p-2 text-sm rounded transition-colors",
                          isSelectedYear &&
                            "bg-primary-50 text-white font-medium",
                          !isSelectedYear &&
                            isCurrentYear &&
                            "bg-primary-100 text-primary-40 font-medium hover:bg-primary-50 hover:text-white",
                          !isSelectedYear &&
                            !isCurrentYear &&
                            "text-grey-30 hover:bg-grey-90",
                        )}
                      >
                        {year}
                      </button>
                    );
                  })}
                </div>
                <div className="flex justify-center pt-3">
                  <button
                    onClick={() => setShowYearPicker(false)}
                    className="text-sm text-primary-50 hover:text-primary-40 px-3 py-1 rounded"
                  >
                    Back to Calendar
                  </button>
                </div>
              </div>
            ) : (
              /* Calendar Grid */
              <>
                {/* Week day headers */}
                <div className="grid grid-cols-7 gap-1 mb-2">
                  {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
                    <div
                      key={day}
                      className="text-center text-xs text-grey-50 py-1 font-medium"
                    >
                      {day}
                    </div>
                  ))}
                </div>

                {/* Calendar days */}
                {calendar.map((week, weekIndex) => (
                  <div key={weekIndex} className="grid grid-cols-7 gap-1">
                    {week.map((dayObj, dayIndex) => (
                      <button
                        key={dayIndex}
                        onClick={() => {
                          if (dayObj.isFuture) return;

                          // If clicking on a date from prev/next month, navigate there first
                          if (!dayObj.isCurrentMonth) {
                            if (
                              dayObj.date <
                              new Date(
                                viewDate.getFullYear(),
                                viewDate.getMonth(),
                                1,
                              )
                            ) {
                              // Previous month date
                              setViewDate(
                                new Date(
                                  dayObj.date.getFullYear(),
                                  dayObj.date.getMonth(),
                                  1,
                                ),
                              );
                            } else {
                              // Next month date
                              setViewDate(
                                new Date(
                                  dayObj.date.getFullYear(),
                                  dayObj.date.getMonth(),
                                  1,
                                ),
                              );
                            }
                          }

                          handleDateSelect(dayObj.date);
                        }}
                        disabled={dayObj.isFuture}
                        className={cn(
                          "text-xs py-2 px-1 rounded transition-colors min-h-[1.75rem]",
                          !dayObj.isCurrentMonth &&
                            "text-grey-80 hover:bg-grey-90 cursor-pointer",
                          dayObj.isCurrentMonth &&
                            dayObj.isFuture &&
                            "text-grey-80 cursor-not-allowed",
                          dayObj.isCurrentMonth &&
                            !dayObj.isFuture &&
                            "text-grey-30 hover:bg-grey-90 cursor-pointer",
                          dayObj.isToday &&
                            "bg-primary-100 text-primary-40 font-medium",
                          dayObj.isSelected &&
                            "bg-primary-50 text-white font-medium hover:bg-primary-50 hover:text-white",
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

export default DateSelector;
