import { Check } from "lucide-react";
import { AbstractIconWrapper, Icons } from "@/components/ui";
import { IconComponent } from "@/app/lib/types";
import { cn } from "@/app/lib/utils";
import { useState } from "react";
import { toast } from "sonner";
import InfoTooltip from "@/components/ui/InfoTooltip";

interface DetailsCardProps {
  icon: IconComponent;
  title: string;
  value: string | number;
  subtitle?: string;
  showStatus?: boolean;
  isOnline?: boolean;
  peerId?: string;
  info?: string;
  speed?: string;
  isIncrease?: boolean;
  showRefresh?: boolean;
  onRefresh?: () => void;
  isLoading?: boolean;
}

export default function DetailsCard({
  icon: Icon,
  title,
  value,
  subtitle,
  showStatus = false,
  isOnline = false,
  peerId,
  info = "",
  speed,
  isIncrease = false,
  showRefresh = false,
  onRefresh,
  isLoading = false,
}: DetailsCardProps) {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = async (peerId: string) => {
    try {
      await navigator.clipboard
        .writeText(peerId)
        .then(() => toast.success("Copied to clipboard successfully!"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <div className="bg-white p-3 rounded-lg border border-grey-80 shadow-sm">
      <div className="flex justify-between items-start">
        <AbstractIconWrapper className="size-8 sm:size-10 text-primary-40">
          <Icon className="absolute text-primary-40 size-4 sm:size-5" />
        </AbstractIconWrapper>
        {showRefresh ? (
          <button
            onClick={onRefresh}
            disabled={isLoading}
            className={cn(
              "size-6 rounded border border-grey-80 bg-grey-90 flex items-center justify-center transition-all duration-200",
              isLoading
                ? "cursor-not-allowed opacity-50"
                : "hover:bg-grey-80 hover:border-grey-70"
            )}
            title="Refresh Credits"
          >
            <Icons.Refresh
              className={cn(
                "size-4 text-grey-60",
                isLoading && "animate-spin-reverse-really-fast"
              )}
            />
          </button>
        ) : info ? (
          <div className="size-6 rounded border border-grey-80 bg-grey-90 flex items-center justify-center">
            <InfoTooltip iconColor="text-grey-60">{info}</InfoTooltip>
          </div>
        ) : null}
      </div>
      <div className="mt-4">
        <p className="text-base font-medium text-grey-60 mb-2">{title}</p>
        <div className="flex gap-2 items-baseline ">
          {showStatus && (
            <>
              {/* Outer circle ring */}
              <span
                className={cn(
                  "p-1 rounded-full",
                  isOnline ? "bg-success-70" : "bg-grey-80"
                )}
              >
                {/* Inner dot */}
                <span
                  className={cn(
                    "block w-2 h-2 rounded-full",
                    isOnline ? "bg-success-50" : "bg-grey-70"
                  )}
                />
              </span>
            </>
          )}
          <span className="text-2xl text-grey-10 font-medium">{value}</span>
          {subtitle && (
            <span className={` text-xs font-medium text-grey-60 leading-5 `}>
              {subtitle}
            </span>
          )}

          {peerId && (
            <div
              className={` text-xs font-medium text-grey-60 flex gap-1 items-center leading-5 ml-auto p-1 bg-grey-90 rounded`}
            >
              Peer ID: {peerId}
              <button
                type="button"
                onClick={() => copyToClipboard(peerId)}
                className={cn(
                  "h-auto flex-shrink-0 hover:bg-transparent ",
                  copied ? "text-green-600" : "text-grey-60 hover:text-grey-70"
                )}
              >
                {copied ? (
                  <Check className={"!text-green-600 size-4"} />
                ) : (
                  <Icons.Copy className="size-4" />
                )}
              </button>
            </div>
          )}

          {speed && (
            <div className="flex gap-2 item-center">
              {isIncrease && (
                <Icons.TrendUp className="text-success-50 size-4 " />
              )}
              {!isIncrease && <Icons.TrendDown className=" size-4 " />}
              <span className={` text-xs font-medium text-grey-60 leading-5 `}>
                {speed} {isIncrease ? "increase" : "decrease"} in 24 hours
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
