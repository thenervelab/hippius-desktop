"use client";

import * as Switch from "@radix-ui/react-switch";
import cn from "@/app/lib/utils/cn";
import { Loader2 } from "lucide-react";

type VPNSwitchProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  loading?: boolean;
};

const VPNSwitch = ({
  checked,
  onCheckedChange,
  loading = false,
}: VPNSwitchProps) => {
  return loading ? (
    <div className="flex items-center gap-2">
      <span className="text-grey-50 font-semibold text-sm leading-5 tracking-[-0.28px]">Loading</span>
      <Loader2 className="size-4 animate-spin text-primary-50" />
    </div>
  ) :
    (<div className="flex items-center gap-2">
      <span
        className="font-semibold text-sm leading-5 tracking-[-0.28px] text-grey-50"
      >
        OFF
      </span>
      <Switch.Root
        className={cn(
          "w-[2.5rem] h-[1.5rem] rounded-full relative shadow-none outline-none transition-colors duration-200 ease-in-out cursor-pointer",
          checked ? "bg-primary-50 border border-primary-80" : "bg-grey-90"
        )}
        checked={checked}
        onCheckedChange={onCheckedChange}
      >
        <Switch.Thumb
          className={cn(
            "block w-[0.875rem] h-[0.875rem]  rounded-full shadow-[0_2px_4px_0_rgba(0,0,0,0.2)] transition-transform duration-200 ease-in-out translate-x-0.5 will-change-transform",
            checked
              ? "translate-x-[1.3125rem] bg-white"
              : "translate-x-[0.375rem] bg-grey-70"
          )}
        />
      </Switch.Root>
      <span
        className={cn(
          "font-semibold text-sm leading-5 tracking-[-0.28px]",
          checked ? "text-primary-50" : "text-grey-50"
        )}
      >
        ON
      </span>
    </div>)
};

export default VPNSwitch;
