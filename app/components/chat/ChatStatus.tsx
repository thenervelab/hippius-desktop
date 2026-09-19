"use client";

import { MessagesSquare } from "lucide-react";

import { type ChatEncryption, useChat } from "@/components/chat/ChatProvider";
import { Button } from "@/components/ui/button";

/**
 * The connected state while the room UI is not yet ported: who is signed
 * in, whether this device's encryption is set up, and the sign-out. The
 * room list and timeline replace this in the next lot; the provider
 * contract they consume (`useChat`) is what this lot ships.
 */
export default function ChatStatus() {
  const { connection, encryption, signOut, unlockEncryption, repairEncryption } = useChat();
  if (connection.kind !== "ready") return null;
  const { session } = connection;

  return (
    <div className="flex h-full min-h-[480px] w-full items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center text-center">
        <div className="mb-5 flex size-14 items-center justify-center rounded-full bg-primary-50/10 text-primary-50 dark:bg-primary-50/20 dark:text-primary-40">
          <MessagesSquare className="size-7" aria-hidden />
        </div>
        <h2 className="text-xl font-medium text-grey-10 dark:text-grey-light-100">
          Connected to team chat
        </h2>
        <p className="mt-2 break-all font-mono text-xs text-grey-60 dark:text-grey-dark-700">
          {session.userId}
        </p>
        <p className="mt-4 text-sm text-grey-60 dark:text-grey-dark-700" role="status">
          {describeEncryption(encryption)}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          {encryption.kind === "error" ? (
            <Button variant="primary" size="sm" onClick={unlockEncryption}>
              Retry encryption setup
            </Button>
          ) : null}
          {encryption.kind === "device-unsigned" && encryption.selfSigningKeyAvailable ? (
            <Button variant="primary" size="sm" onClick={unlockEncryption}>
              Verify this device
            </Button>
          ) : null}
          {encryption.kind === "foreign-key" && encryption.canAdopt ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => repairEncryption("adopt-derived-key")}
            >
              Use the Hippius key
            </Button>
          ) : null}
          <Button variant="defaultStable" size="sm" onClick={() => void signOut()}>
            Sign out of chat
          </Button>
        </div>
      </div>
    </div>
  );
}

/** One sentence per encryption state, for the status line. */
export function describeEncryption(encryption: ChatEncryption): string {
  switch (encryption.kind) {
    case "unknown":
    case "checking":
      return "Checking encryption on this device…";
    case "bootstrapping":
      return "Setting up encryption on this device…";
    case "ready":
      return encryption.warnings.length
        ? `Encryption is ready. ${encryption.warnings.join(" ")}`
        : "Encryption is ready on this device.";
    case "device-unsigned":
      return encryption.selfSigningKeyAvailable
        ? "This device is not yet verified. Verify it to receive message keys from your other devices."
        : "This device is not verified. Verify it from another of your devices to receive message keys.";
    case "foreign-key":
      return encryption.canAdopt
        ? `Another client set up encryption with its own key (${encryption.keyName ?? encryption.keyId}). Switch to the Hippius key to unlock it here.`
        : `Encryption was set up by another client with a key this app cannot read (${encryption.keyName ?? encryption.keyId}).`;
    case "cross-signing-blocked":
      return `Encryption setup needs your approval on the account page. ${encryption.detail}`;
    case "error":
      return `Encryption setup failed: ${encryption.message}`;
  }
}
