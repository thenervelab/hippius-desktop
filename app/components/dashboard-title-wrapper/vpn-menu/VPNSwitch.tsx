"use client";

import * as Switch from "@radix-ui/react-switch";
import cn from "@/app/lib/utils/cn";

type VPNSwitchProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
};

const VPNSwitch = ({ checked, onCheckedChange }: VPNSwitchProps) => {
  return (
    <div className="flex items-center gap-2">
      <span className="font-semibold text-sm leading-5 text-grey-50 tracking-[-0.28px]">
        OFF
      </span>
      <Switch.Root
        className={cn(
          "w-[40px] h-[24px] rounded-full relative shadow-none outline-none cursor-pointer transition-colors duration-200 ease-in-out",
          checked ? "bg-primary-50 border border-primary-80" : "bg-grey-90"
        )}
        checked={checked}
        onCheckedChange={onCheckedChange}
      >
        <Switch.Thumb
          className={cn(
            "block w-[20px] h-[20px] bg-white rounded-full shadow-[0_2px_4px_0_rgba(0,0,0,0.2)] transition-transform duration-200 ease-in-out translate-x-0.5 will-change-transform",
            checked ? "translate-x-[17.5px]" : "translate-x-0.5"
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
    </div>
  );
};

export default VPNSwitch;
