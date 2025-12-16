import React, { useState } from "react";
import { Button } from "@/components/ui/button/NewButton";
import { toast } from "sonner";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Icons } from ".";

export interface CopyableTextProps {
  value: string;
  displayMode?: "slice" | "truncate" | "full";
  textClassName?: string;
  iconClassName?: string;
  maxWidth?: string;
  sliceLength?: number;
}

const CopyableText: React.FC<CopyableTextProps> = ({
  value,
  displayMode = "slice",
  textClassName = "text-grey-20",
  iconClassName = "w-4 h-4",
  maxWidth = "w-40",
  sliceLength = 4,
}) => {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard
        .writeText(value)
        .then(() => toast.success("Copied to clipboard successfully!"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const renderText = () => {
    if (displayMode === "slice" && value.length > sliceLength * 2) {
      return (
        <span className={textClassName}>
          {`${value.slice(0, sliceLength)}...${value.slice(-sliceLength)}`}
        </span>
      );
    } else if (displayMode === "truncate") {
      return (
        <span className={cn("truncate block", maxWidth, textClassName)}>
          {value}
        </span>
      );
    } else {
      // Full display mode
      return <span className={textClassName}>{value}</span>;
    }
  };

  return (
    <div className="flex items-center gap-2">
      {renderText()}
      <Button
        type="button"
        size={"noStyle"}
        onClick={copyToClipboard}
        className={cn(
          "h-auto flex-shrink-0 hover:bg-transparent",
          copied ? "text-green-600" : "text-grey-60 hover:text-grey-70"
        )}
        variant="ghost"
      >
        {copied ? (
          <Check className={cn(iconClassName, "!text-green-600")} />
        ) : (
          <Icons.Copy className={cn(iconClassName)} />
        )}
      </Button>
    </div>
  );
};

export default CopyableText;
