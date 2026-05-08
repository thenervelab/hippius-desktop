import { Loader2 } from "lucide-react";
import React, { FC } from "react";
import { cn } from "@/lib/utils";
import Button from ".";

interface CreateButtonProps {
  text: string;
  isLoading: boolean;
  onClick: () => void;
  className?: string;
}

const CreateButton: FC<CreateButtonProps> = ({
  text,
  isLoading,
  onClick,
  className = "w-fit",
}) => {
  return (
    <Button
      variant="primary"
      size="auto"
      onClick={onClick}
      className={cn(
        "h-[33px] sm:h-[37px] rounded-[6px] px-[18px] text-[13px] sm:text-[16px] font-normal tracking-[-0.26px] sm:tracking-[-0.32px]",
        className,
      )}
    >
      {isLoading ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <span className="flex items-center gap-2">
          <span>{text}</span>
        </span>
      )}
    </Button>
  );
};

export default CreateButton;
