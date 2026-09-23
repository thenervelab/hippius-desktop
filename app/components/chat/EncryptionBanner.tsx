"use client";

import type { ReactNode } from "react";
import { LockKeyhole, ShieldAlert } from "lucide-react";

import type { ChatEncryption, EncryptionRepair } from "@/components/chat/ChatProvider";
import { Button } from "@/components/ui/button";

interface EncryptionBannerProps {
  encryption: ChatEncryption;
  onUnlock: () => void;
  onRepair: (repair: EncryptionRepair) => void;
}

/**
 * Strip above the timeline that explains the encryption state when it is
 * not simply "ready". Silent when everything is fine.
 */
export default function EncryptionBanner({ encryption, onUnlock, onRepair }: EncryptionBannerProps) {
  switch (encryption.kind) {
    case "unknown":
    case "checking":
    case "ready":
      return null;

    case "bootstrapping":
      return (
        <Banner tone="info" icon={<LockKeyhole className="size-4" aria-hidden />}>
          Setting up encryption for this device…
        </Banner>
      );

    case "device-unsigned":
      // Other devices withhold room keys from an unsigned device. With the
      // self-signing key here, a re-run signs it; without it, only another
      // signed device can (or its keys reaching secret storage).
      return (
        <Banner
          tone="warning"
          icon={<ShieldAlert className="size-4" aria-hidden />}
          action={
            <Button
              variant={encryption.selfSigningKeyAvailable ? "primary" : "defaultStable"}
              size="sm"
              onClick={onUnlock}
            >
              {encryption.selfSigningKeyAvailable ? "Verify this device" : "Try again"}
            </Button>
          }
        >
          This device is not verified yet, so your other devices will not share encrypted messages with it.{" "}
          {encryption.selfSigningKeyAvailable
            ? "Verify it now with your mnemonic."
            : "Verify it from one of your other devices, or unlock chat there with your mnemonic so this device can pick up the signing keys, then try again."}
        </Banner>
      );

    case "foreign-key":
      // Adopting is safe (the other key and its copies stay); a reset is
      // not, so it lives behind a confirmation in Preferences > Encryption.
      return (
        <Banner
          tone="warning"
          icon={<ShieldAlert className="size-4" aria-hidden />}
          action={
            encryption.canAdopt ? (
              <Button variant="primary" size="sm" onClick={() => onRepair("adopt-derived-key")}>
                Use my Hippius key
              </Button>
            ) : undefined
          }
        >
          This account&apos;s encryption was set up in another app
          {encryption.keyName ? ` (${encryption.keyName})` : ""}.{" "}
          {encryption.canAdopt
            ? "Switch it to your Hippius key so this device can back up and restore messages."
            : "Open Preferences › Encryption to reset it for this account."}
        </Banner>
      );

    case "cross-signing-blocked":
      return (
        <Banner
          tone="warning"
          icon={<ShieldAlert className="size-4" aria-hidden />}
          action={
            encryption.accountManagementUrl ? (
              <Button
                asLink
                href={encryption.accountManagementUrl}
                target="_blank"
                rel="noreferrer"
                variant="defaultStable"
                size="sm"
              >
                Open account settings
              </Button>
            ) : undefined
          }
        >
          The chat server needs you to approve this device before it can be
          verified.
        </Banner>
      );

    case "error":
      // Every failure here is retried by re-running the (idempotent)
      // bootstrap; it picks up from what the server holds.
      return (
        <Banner
          tone="error"
          icon={<ShieldAlert className="size-4" aria-hidden />}
          action={
            <Button variant="defaultStable" size="sm" onClick={onUnlock}>
              Try again
            </Button>
          }
        >
          Encryption setup failed: {encryption.message}
        </Banner>
      );
  }
}

function Banner({
  tone,
  icon,
  action,
  children,
}: {
  tone: "info" | "warning" | "error";
  icon: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const toneClasses = {
    info: "border-primary-50/30 bg-primary-50/10 text-grey-10 dark:border-primary-50/40 dark:bg-primary-50/20 dark:text-grey-light-100",
    warning:
      "border-warning-50/40 bg-warning-50/10 text-grey-10 dark:border-warning-50/50 dark:bg-warning-50/20 dark:text-grey-light-100",
    error:
      "border-error-50/40 bg-error-50/10 text-grey-10 dark:border-error-50/50 dark:bg-error-50/20 dark:text-grey-light-100",
  }[tone];

  return (
    <div
      role="status"
      className={`flex items-center gap-3 border-b px-4 py-2 text-sm ${toneClasses}`}
    >
      <span className="shrink-0 text-grey-60 dark:text-grey-dark-700">{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
      {action ? <span className="shrink-0">{action}</span> : null}
    </div>
  );
}
