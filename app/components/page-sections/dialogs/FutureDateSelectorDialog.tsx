"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { CalendarNew } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

interface FutureDateSelectorProps {
    selectedDate?: Date;
    onDateSelect?: (date: Date) => void;
    placeholder?: string;
}

const formatDate = (date: Date): string => {
    const months = [
        'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
    ];
    return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
};

const formatMonthYear = (date: Date): string => {
    const months = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];
    return `${months[date.getMonth()]} ${date.getFullYear()}`;
};

const FutureDateSelector: React.FC<FutureDateSelectorProps> = ({
    selectedDate,
    onDateSelect,
    placeholder = "Pick a date",
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const [viewDate, setViewDate] = useState(() => new Date());
    const [showYearPicker, setShowYearPicker] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const [position, setPosition] = useState<{ top: number; left: number; showAbove: boolean }>({ top: 0, left: 0, showAbove: false });

    // Calculate position when opening
    const calculatePosition = useCallback(() => {
        if (!triggerRef.current) return;

        const rect = triggerRef.current.getBoundingClientRect();
        const calendarHeight = 380; // Approximate height of calendar
        const viewportHeight = window.innerHeight;
        const spaceBelow = viewportHeight - rect.bottom;
        const spaceAbove = rect.top;

        // Show above if not enough space below and more space above
        const showAbove = spaceBelow < calendarHeight && spaceAbove > spaceBelow;

        setPosition({
            top: showAbove ? rect.top - 8 : rect.bottom + 8,
            left: rect.left,
            showAbove,
        });
    }, []);

    // Update viewDate when selectedDate changes
    useEffect(() => {
        if (selectedDate) {
            setViewDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
        }
    }, [selectedDate]);

    // Recalculate position on scroll/resize
    useEffect(() => {
        if (!isOpen) return;

        calculatePosition();

        const handleUpdate = () => calculatePosition();
        window.addEventListener('scroll', handleUpdate, true);
        window.addEventListener('resize', handleUpdate);

        return () => {
            window.removeEventListener('scroll', handleUpdate, true);
            window.removeEventListener('resize', handleUpdate);
        };
    }, [isOpen, calculatePosition]);

    const handleOpen = () => {
        calculatePosition();
        setIsOpen(true);
    };

    const getDisplayText = () => {
        if (!selectedDate) return placeholder;
        return formatDate(selectedDate);
    };

    const handleDateSelect = (date: Date) => {
        onDateSelect?.(date);
        setIsOpen(false);
    };

    const navigateToPreviousMonth = () => {
        const today = new Date();
        const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
        const prevMonth = new Date(viewDate);
        prevMonth.setMonth(prevMonth.getMonth() - 1);

        // Don't go before current month
        if (prevMonth >= currentMonthStart) {
            setViewDate(prevMonth);
        }
    };

    const navigateToNextMonth = () => {
        setViewDate(prev => {
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
                currentDate.setDate(startDate.getDate() + (week * 7) + day);
                currentDate.setHours(0, 0, 0, 0);

                const isCurrentMonth = currentDate.getMonth() === currentMonth;
                const isToday = currentDate.getTime() === today.getTime();
                const isSelected = selectedDate &&
                    currentDate.getTime() === new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate()).getTime();
                const isPast = currentDate <= today; // Past dates are disabled for future selection

                weekDays.push({
                    date: currentDate,
                    isCurrentMonth,
                    isToday,
                    isSelected,
                    isPast,
                });
            }
            calendar.push(weekDays);

            if (weekDays[6].date > lastDay) break;
        }

        return calendar;
    };

    const calendar = generateCalendar();
    const today = new Date();

    // Check if we can go to previous month (can't go before current month)
    const canGoPrevious = viewDate.getFullYear() > today.getFullYear() ||
        (viewDate.getFullYear() === today.getFullYear() && viewDate.getMonth() > today.getMonth());

    return (
        <div className="relative">
            {/* Trigger Button */}
            <button
                ref={triggerRef}
                type="button"
                onClick={() => isOpen ? setIsOpen(false) : handleOpen()}
                className={cn(
                    "w-full flex items-center justify-between",
                    "bg-grey-100 border border-grey-80 rounded-[8px]",
                    "px-4 py-3 text-base font-medium",
                    "h-[56px] focus:outline-none focus:border-grey-70 hover:border-grey-70 transition-colors",
                    selectedDate ? "text-grey-10" : "text-grey-60"
                )}
            >
                <span>{getDisplayText()}</span>
                <CalendarNew className="size-5 text-grey-60" />
            </button>

            {/* Calendar Dropdown - Rendered via Portal */}
            {isOpen && createPortal(
                <>
                    {/* Backdrop */}
                    <div
                        className="fixed inset-0"
                        style={{ zIndex: 9998 }}
                        onClick={() => setIsOpen(false)}
                    />

                    {/* Calendar Content */}
                    <div
                        className="fixed bg-white border border-grey-80 rounded-lg p-4 shadow-lg min-w-[320px] max-w-[360px]"
                        style={{
                            zIndex: 9999,
                            pointerEvents: 'auto',
                            top: position.showAbove ? 'auto' : position.top,
                            bottom: position.showAbove ? `${window.innerHeight - position.top}px` : 'auto',
                            left: Math.min(position.left, window.innerWidth - 370), // Prevent overflow on right
                        }}
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between mb-4">
                            <div className="flex items-center gap-2">
                                {!showYearPicker && (
                                    <button
                                        type="button"
                                        onClick={navigateToPreviousMonth}
                                        disabled={!canGoPrevious}
                                        className="p-1 hover:bg-grey-90 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                        aria-label="Previous month"
                                    >
                                        <ChevronLeft className="h-4 w-4 text-grey-50" />
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={() => setShowYearPicker(!showYearPicker)}
                                    className="text-sm font-medium text-grey-10 min-w-[140px] text-center hover:text-primary-50 transition-colors"
                                >
                                    {showYearPicker ? `${viewDate.getFullYear()}` : formatMonthYear(viewDate)}
                                </button>
                                {!showYearPicker && (
                                    <button
                                        type="button"
                                        onClick={navigateToNextMonth}
                                        className="p-1 hover:bg-grey-90 rounded transition-colors"
                                        aria-label="Next month"
                                    >
                                        <ChevronRight className="h-4 w-4 text-grey-50" />
                                    </button>
                                )}
                            </div>
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    onClick={() => setViewDate(new Date())}
                                    className="text-xs text-primary-50 hover:text-primary-40 px-2 py-1 rounded"
                                >
                                    This Month
                                </button>
                                {selectedDate && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            onDateSelect?.(undefined as unknown as Date);
                                            setIsOpen(false);
                                        }}
                                        className="text-xs text-error-50 hover:text-error-40 px-2 py-1 rounded"
                                    >
                                        Clear
                                    </button>
                                )}
                            </div>
                        </div>

                        <div className="space-y-1">
                            {showYearPicker ? (
                                <div className="space-y-2">
                                    <div className="text-center text-sm text-grey-50 mb-3">Select Year</div>
                                    <div className="grid grid-cols-3 gap-2 max-h-48 overflow-y-auto">
                                        {/* Show current year + next 10 years for future date selection */}
                                        {Array.from({ length: 11 }, (_, i) => {
                                            const year = new Date().getFullYear() + i;
                                            const isCurrentYear = year === new Date().getFullYear();
                                            const isSelectedYear = year === viewDate.getFullYear();

                                            return (
                                                <button
                                                    type="button"
                                                    key={year}
                                                    onClick={() => {
                                                        setViewDate(new Date(year, viewDate.getMonth(), 1));
                                                        setShowYearPicker(false);
                                                    }}
                                                    className={cn(
                                                        "p-2 text-sm rounded transition-colors",
                                                        isSelectedYear
                                                            ? "bg-primary-50 text-white font-medium"
                                                            : isCurrentYear
                                                                ? "bg-primary-100 text-primary-40 font-medium hover:bg-primary-50 hover:text-white"
                                                                : "text-grey-30 hover:bg-grey-90"
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
                                            className="text-sm text-primary-50 hover:text-primary-40 px-3 py-1 rounded"
                                        >
                                            Back to Calendar
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <div className="grid grid-cols-7 gap-1 mb-2">
                                        {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((day) => (
                                            <div key={day} className="text-center text-xs text-grey-50 py-1 font-medium">
                                                {day}
                                            </div>
                                        ))}
                                    </div>

                                    {calendar.map((week, weekIndex) => (
                                        <div key={weekIndex} className="grid grid-cols-7 gap-1">
                                            {week.map((dayObj, dayIndex) => (
                                                <button
                                                    type="button"
                                                    key={dayIndex}
                                                    onClick={() => {
                                                        if (dayObj.isPast) return;

                                                        if (!dayObj.isCurrentMonth) {
                                                            setViewDate(new Date(dayObj.date.getFullYear(), dayObj.date.getMonth(), 1));
                                                        }

                                                        handleDateSelect(dayObj.date);
                                                    }}
                                                    disabled={dayObj.isPast}
                                                    className={cn(
                                                        "text-xs py-2 px-1 rounded transition-colors min-h-[28px]",
                                                        !dayObj.isCurrentMonth
                                                            ? dayObj.isPast
                                                                ? "text-grey-80 cursor-not-allowed"
                                                                : "text-grey-60 hover:bg-grey-90 cursor-pointer"
                                                            : dayObj.isPast
                                                                ? "text-grey-80 cursor-not-allowed"
                                                                : "text-grey-30 hover:bg-grey-90 cursor-pointer",
                                                        dayObj.isToday && "bg-grey-90 text-grey-40 font-medium",
                                                        dayObj.isSelected && "bg-primary-50 text-white font-medium hover:bg-primary-50 hover:text-white"
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
                    </div>
                </>,
                document.body
            )}
        </div>
    );
};

export default FutureDateSelector;
