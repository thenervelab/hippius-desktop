"use client";

// Settings › Devices: the phones and computers linked to the account, this
// computer first (with a "This device" pill and no Unlink: signing out is how
// this one is removed), then the most recently active. Rust lists, labels and
// orders them; this only draws the rows and runs one unlink at a time.

import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Laptop, Loader2, MonitorSmartphone, RotateCw, Smartphone, Unlink } from "lucide-react";

import ConfirmationDialog from "@/app/components/ConfirmationDialog";
import { Skeleton } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import {
  listAccountDevices,
  unlinkAccountDevice,
  type AccountDevice,
  type DeviceListing,
} from "@/app/lib/tauri/devices";
import { SettingsCard } from "../SettingsCard";
import { SettingIcon } from "../SettingIcon";
import {
  DEVICES_EMPTY,
  DEVICES_LOAD_ERROR,
  DEVICES_TITLE,
  DEVICES_UNAVAILABLE,
  THIS_DEVICE_PILL,
  UNLINK_BUTTON,
  deviceSubtitle,
  unlinkBody,
  unlinkFailedToast,
  unlinkTitle,
  unlinkedToast,
} from "./deviceCopy";

/** React-query key of the account's device list. */
export const ACCOUNT_DEVICES_QUERY_KEY = "accountDevices";

export function accountDevicesQueryKey(accountId: string | null | undefined) {
  return [ACCOUNT_DEVICES_QUERY_KEY, accountId ?? null] as const;
}

const SKELETON_ROWS = 3;

function DeviceIcon({ kind }: { kind: AccountDevice["kind"] }) {
  if (kind === "phone") return <Smartphone className="size-4" strokeWidth={2} />;
  if (kind === "computer") return <Laptop className="size-4" strokeWidth={2} />;
  return <MonitorSmartphone className="size-4" strokeWidth={2} />;
}

function DeviceRow({
  device,
  unlinking,
  unlinkDisabled,
  onUnlink,
}: {
  device: AccountDevice;
  unlinking: boolean;
  unlinkDisabled: boolean;
  onUnlink: (device: AccountDevice) => void;
}) {
  return (
    <li
      aria-label={device.label}
      data-testid="device-row"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5"
    >
      <div className="flex min-w-0 flex-1 basis-[220px] items-start gap-3">
        <SettingIcon tone={device.isThisDevice ? "brand" : "muted"}>
          <DeviceIcon kind={device.kind} />
        </SettingIcon>
        <div className="min-w-0 pt-[1px]">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-sm font-medium text-grey-10 dark:text-white">{device.label}</p>
            {device.isThisDevice && (
              <span className="flex-shrink-0 rounded-full bg-primary-50/10 px-2 py-[1px] text-[11px] font-medium leading-[18px] text-primary-50 dark:bg-primary-brand-dark/15 dark:text-primary-brand-dark">
                {THIS_DEVICE_PILL}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[13px] leading-snug text-[#7D7D7D] dark:text-grey-dark-600">
            {deviceSubtitle(device)}
          </p>
        </div>
      </div>
      {!device.isThisDevice && (
        <button
          type="button"
          onClick={() => onUnlink(device)}
          disabled={unlinkDisabled}
          aria-label={`${UNLINK_BUTTON} ${device.label}`}
          className={cn(
            "inline-flex flex-shrink-0 items-center gap-1.5 rounded-[6px] px-2 py-1 text-sm font-medium",
            "text-error-70 hover:bg-error-50/10 dark:text-error-50",
            "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
          )}
        >
          {unlinking && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          {UNLINK_BUTTON}
        </button>
      )}
    </li>
  );
}

function SkeletonRows() {
  return (
    <ul aria-busy="true" aria-label="Loading devices" className="divide-y divide-grey-dark-100 dark:divide-black-300">
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <li key={i} data-testid="device-row-skeleton" className="flex items-center gap-3 px-4 py-3.5">
          <Skeleton width={32} height={32} className="rounded-[8px]" />
          <div className="flex flex-col gap-1.5">
            <Skeleton width={160} height={14} />
            <Skeleton width={120} height={12} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Message({ children, role }: { children: React.ReactNode; role?: "alert" | "status" }) {
  return (
    <div role={role} className="px-4 py-4 text-sm font-medium text-[#7D7D7D] dark:text-grey-dark-600">
      {children}
    </div>
  );
}

export default function DevicesSettings() {
  const { polkadotAddress } = useWalletAuth();
  const queryClient = useQueryClient();
  const queryKey = accountDevicesQueryKey(polkadotAddress);
  const [confirming, setConfirming] = useState<AccountDevice | null>(null);
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);

  const query = useQuery({
    queryKey,
    queryFn: () => listAccountDevices(polkadotAddress as string),
    enabled: Boolean(polkadotAddress),
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const unlink = async (device: AccountDevice) => {
    if (!polkadotAddress) return;
    setUnlinkingId(device.deviceId);
    try {
      await unlinkAccountDevice(polkadotAddress, device.deviceId);
      // Dropped from what is on screen rather than listed again: the server
      // stops listing it at once, and a refetch would only flash the rows.
      queryClient.setQueryData<DeviceListing>(queryKey, (prev) =>
        prev ? { ...prev, devices: prev.devices.filter((d) => d.deviceId !== device.deviceId) } : prev,
      );
      toast.success(unlinkedToast(device.label));
    } catch (error) {
      console.error("Failed to unlink device:", error);
      toast.error(unlinkFailedToast(device.label));
    } finally {
      setUnlinkingId(null);
    }
  };

  let body: React.ReactNode;
  if (query.isPending && Boolean(polkadotAddress)) {
    body = <SkeletonRows />;
  } else if (query.isError) {
    body = (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
        <p className="text-sm font-medium text-grey-10 dark:text-white">{DEVICES_LOAD_ERROR}</p>
        <button
          type="button"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-[6px] border px-3 h-[30px] text-sm font-medium",
            "border-grey-dark-100 bg-[#FEFEFE] text-[#4F4F4F] hover:bg-[#F5F5F5]",
            "dark:border-black-300 dark:bg-black-600 dark:text-grey-dark-700 dark:hover:bg-black-500",
            "disabled:opacity-60",
          )}
        >
          <RotateCw className={cn("size-3.5", query.isFetching && "animate-spin")} aria-hidden />
          Try again
        </button>
      </div>
    );
  } else if (query.data && !query.data.available) {
    body = <Message role="status">{DEVICES_UNAVAILABLE}</Message>;
  } else if (!query.data || query.data.devices.length === 0) {
    body = <Message role="status">{DEVICES_EMPTY}</Message>;
  } else {
    body = (
      <ul className="divide-y divide-grey-dark-100 dark:divide-black-300">
        {query.data.devices.map((device) => (
          <DeviceRow
            key={device.deviceId}
            device={device}
            unlinking={unlinkingId === device.deviceId}
            unlinkDisabled={unlinkingId !== null}
            onUnlink={setConfirming}
          />
        ))}
      </ul>
    );
  }

  const confirmBody = confirming ? unlinkBody(confirming.kind) : null;

  return (
    <section aria-label={DEVICES_TITLE}>
      <SettingsCard label="Linked devices" icon={<MonitorSmartphone className="size-4" />}>
        {body}
      </SettingsCard>

      <ConfirmationDialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        onBack={() => setConfirming(null)}
        onConfirm={() => {
          const device = confirming;
          setConfirming(null);
          if (device) void unlink(device);
        }}
        heading={confirming ? unlinkTitle(confirming.label) : ""}
        // The dialog's text is a <p>, so the bullets are block spans, not a list.
        text={
          confirmBody && confirmBody.bullets.length > 0 ? (
            <span className="mx-auto flex w-fit flex-col gap-1 text-left">
              {confirmBody.bullets.map((line) => (
                <span key={line} className="flex gap-2">
                  <span aria-hidden>•</span>
                  <span>{line}</span>
                </span>
              ))}
            </span>
          ) : (
            (confirmBody?.closing ?? "")
          )
        }
        helperText={confirmBody && confirmBody.bullets.length > 0 ? confirmBody.closing : null}
        button={UNLINK_BUTTON}
        cancelLabel="Cancel"
        icon={<Unlink className="size-[18px] text-white" strokeWidth={2.5} />}
        iconBgColor="bg-[#fc7d73]"
        confirmVariant="destructive"
        disableButton={unlinkingId !== null}
      />
    </section>
  );
}
