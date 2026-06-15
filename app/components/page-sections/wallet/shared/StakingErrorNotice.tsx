"use client";

import { FC } from "react";
import { AlertCircle } from "lucide-react";

interface StakingErrorNoticeProps {
  /** `useStaking().stakingInfo.error`; renders nothing when null. */
  message: string | null;
  /**
   * Optional manual retry. The `useStaking` query also re-attempts on its own
   * `refetchInterval`, so this is a convenience, not the only recovery path.
   */
  onRetry?: () => void;
  className?: string;
}

/**
 * Inline, non-blocking notice shown when the staking chain read fails.
 *
 * Staking screens display zeros on error, which is indistinguishable from a
 * genuinely empty stake. This disambiguates "couldn't load" from "you have 0",
 * so a transient RPC outage no longer looks like a wiped balance. The raw error
 * is exposed via `title` for support/debugging without cluttering the UI.
 */
const StakingErrorNotice: FC<StakingErrorNoticeProps> = ({
  message,
  onRetry,
  className,
}) => {
  if (!message) return null;

  return (
    <div
      role="alert"
      title={message}
      className={`flex items-center gap-2 text-error-70 text-sm font-medium ${className ?? ""}`}
    >
      <AlertCircle className="size-4 shrink-0" />
      <span className="flex-1">
        Couldn&apos;t load staking data. Retrying automatically.
      </span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="underline underline-offset-2 hover:opacity-80"
        >
          Retry
        </button>
      )}
    </div>
  );
};

export default StakingErrorNotice;
