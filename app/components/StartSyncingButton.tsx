"use client";

import React from "react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

interface StartSyncingButtonProps {
  className?: string;
  onClick?: () => void;
  disabled?: boolean;
}

const StartSyncingButton: React.FC<StartSyncingButtonProps> = ({
  className,
  onClick,
  disabled = false,
}) => {
  return (
    <Button
      variant="primary"
      size="auto"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "h-[30px] px-3 py-[10px] gap-[10px] rounded-[6px]",
        "font-geist text-[14px] tracking-[-0.28px] leading-[1.109]",
        className,
      )}
    >
      Start Syncing
    </Button>
  );
};

export default StartSyncingButton;
