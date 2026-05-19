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
        "h-[30px] px-3 py-[10px] gap-[10px] rounded-[6px]",
        "font-geist text-[14px] tracking-[-0.28px] leading-[1.109]",
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
