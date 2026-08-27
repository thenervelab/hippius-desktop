"use client";

import React, { useEffect, useState } from "react";
import { InView } from "react-intersection-observer";

import { cn } from "@/lib/utils";
import { Icons } from "@/components/ui";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import {
  releaseChannelStatus,
  type ChannelStatus,
  type ReleaseChannel,
} from "@/lib/tauri/updates";
import { channelLabel } from "@/app/components/updater/releaseChannelCopy";
import { openChannelDialog } from "@/app/components/updater/releaseChannelStore";

/**
 * Release-channel picker for the Updates settings section.
 *
 * Styled like `AppearanceSettings`: the same flat row (icon + title/description
 * left, action right) with the shared `SegmentedControl` in the action slot.
 *
 * The control does NOT switch on change — it opens the explainer dialog, which
 * is the only place a switch is confirmed. Two surfaces offering the same
 * action must agree on the warning; letting this one act directly would give a
 * user a one-click path onto unreleased builds that the address menu
 * deliberately gates.
 */
const CHANNEL_OPTIONS: ReadonlyArray<{ value: ReleaseChannel; label: string }> =
  [
    { value: "production", label: channelLabel("production") },
    { value: "beta", label: channelLabel("beta") },
  ];

export default function ReleaseChannelSettings() {
  const [status, setStatus] = useState<ChannelStatus | null>(null);

  // Re-read when the section mounts. The running channel is compiled into the
  // binary and cannot change without a restart, but the TARGET's published
  // version can, and the row names it.
  useEffect(() => {
    let cancelled = false;
    releaseChannelStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const current = status?.current ?? null;
  // The internal lane publishes no manifest, so there is nothing to install in
  // either direction — the control would be a button that cannot work.
  const switchable = current !== null && current !== "staging";

  const description = (() => {
    if (!status) return "Choose which builds this computer receives.";
    if (status.blockedReason) return status.blockedReason;
    if (current === "staging") {
      return "This is an internal build. It does not update automatically — install a new one by hand.";
    }
    if (status.targetVersion) {
      return `The beta channel gets new features first, before they are fully stabilized. Currently publishing ${status.targetVersion}.`;
    }
    // Rust leaves the version empty rather than erroring when the manifest
    // cannot be read, so say that plainly instead of hiding the control.
    return "The beta channel gets new features first, before they are fully stabilized. Could not reach it just now.";
  })();

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className={cn(
            "transition-all duration-500 ease-out",
            inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3",
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3 rounded-[8px] border border-grey-dark-100 bg-white dark:bg-black-600 dark:border-black-300">
            <div className="flex items-start gap-3 min-w-0">
              <Icons.Star className="size-[18px] text-primary-50 dark:text-primary-brand-dark flex-shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-grey-10 dark:text-white">
                  Release channel
                </p>
                <p className="text-sm text-[#7D7D7D] dark:text-grey-dark-600 mt-1">
                  {description}
                </p>
              </div>
            </div>
            <SegmentedControl<ReleaseChannel>
              ariaLabel="Release channel"
              disabled={!switchable || status?.blockedReason !== null}
              // Selecting the lane already running is a no-op; selecting the
              // other one opens the dialog rather than switching here.
              onChange={(next) => {
                if (next !== current) openChannelDialog();
              }}
              options={CHANNEL_OPTIONS}
              value={switchable ? current : null}
            />
          </div>
        </div>
      )}
    </InView>
  );
}
