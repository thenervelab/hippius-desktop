import React from "react";
import * as Menubar from "@radix-ui/react-menubar";
import { Icons } from "@/components/ui";

const currentYear = new Date().getFullYear();
const previousYear = currentYear - 1;

const dateOptions = [
  { value: "today", label: "Today" },
  { value: "last7days", label: "Last 7 days" },
  { value: "last30days", label: "Last 30 days" },
  { value: "thisyear", label: `This year (${currentYear})` },
  { value: "lastyear", label: `Last year (${previousYear})` },
];

interface DateSelectorProps {
  selectedDate?: string;
  onDateSelect?: (date: string) => void;
}

const DateSelector: React.FC<DateSelectorProps> = ({
  selectedDate,
  onDateSelect,
}) => {
  const getDisplayText = () => {
    if (!selectedDate) return "Select date";
    const selectedOption = dateOptions.find(
      (option) => option.value === selectedDate
    );
    return selectedOption?.label || "Select date";
  };

  return (
    <Menubar.Root>
      <Menubar.Menu>
        <Menubar.Trigger asChild>
          <button className="group flex justify-between p-2 bg-grey-90 w-full rounded border border-grey-80 hover:bg-grey-80 transition-colors">
            <div className="flex gap-2">
              <div className="flex justify-center items-center ">
                <Icons.Calendar className="size-[18px] text-grey-10" />
              </div>
              <div className="text-sm font-medium text-grey-10 leading-5">
                {getDisplayText()}
              </div>
            </div>
            <div className="rounded border border-prmary-80 bg-primary-100 flex justify-center items-center p-[3px]">
              <Icons.ChevronDown className="size-[14px] text-primary-50 transition-transform duration-200 group-data-[state=open]:rotate-180" />
            </div>
          </button>
        </Menubar.Trigger>
        <Menubar.Content className="mt-1 bg-white border border-grey-80 rounded-lg p-1 shadow-menu min-w-[326px] z-50">
          {dateOptions.map((option) => (
            <Menubar.Item
              key={option.value}
              className="flex items-center p-2 hover:bg-grey-80 cursor-pointer rounded text-grey-40 text-xs font-medium outline-none w-full"
              onClick={() => onDateSelect?.(option.value)}
            >
              <span className="flex-1">{option.label}</span>
            </Menubar.Item>
          ))}
        </Menubar.Content>
      </Menubar.Menu>
    </Menubar.Root>
  );
};

export default DateSelector;
