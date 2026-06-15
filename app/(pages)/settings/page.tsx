"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import AppearanceSettings from "@/components/page-sections/settings/AppearanceSettings";
import MultiFolderSyncManager from "@/components/page-sections/settings/MultiFolderSyncManager";
import DeviceNameSetting from "@/components/page-sections/settings/DeviceNameSetting";
import RecoveryPhraseSettings from "@/components/page-sections/settings/RecoveryPhraseSettings";
import WalletSettings from "@/components/page-sections/settings/WalletSettings";
import ApiTokenSection from "@/components/page-sections/settings/ApiTokenSection";
import VPNSettings from "@/components/page-sections/settings/VPNSettings";
import CustomizeRPC from "@/components/page-sections/settings/CustomizeRPC";
import InfoTooltip from "@/components/page-sections/settings/InfoTooltip";
import NotificationSection from "@/components/page-sections/settings/NotificationSection";
import {
  VPN_FEATURE_ENABLED,
  WALLET_FEATURE_ENABLED,
} from "@/app/lib/featureFlags";

const SECTION_META: Record<
  string,
  {
    title: string;
    description: string;
    tooltip?: string;
    learnMoreUrl?: string;
    showDescription?: boolean;
  }
> = {
  sync: {
    title: "Sync & Storage",
    description: "Configure your sync folders and storage options.",
  },
  appearance: {
    title: "Appearance",
    description: "Personalize how Hippius looks on this device.",
    tooltip:
      "Your theme choice is stored locally and applies right away. It only affects this device, so other devices and the web console keep their own setting.",
    showDescription: true,
  },
  wallets: {
    title: "Wallets",
    description:
      "Manage the local wallets stored on this device. Switch between them, rename, export a backup, or remove ones you no longer use.",
    tooltip:
      "Each local wallet is an encrypted copy of an access key on this device. Renaming and deleting only affects what's stored here — the underlying account on Hippius is unchanged. Always export a backup before deleting.",
    showDescription: true,
  },
  security: {
    title: "Security",
    description:
      "Backup your mnemonic seed and set an unlock password to access your encrypted files on other devices.",
    tooltip:
      "Two separate keys protect your account: the mnemonic seed restores wallet access and decrypts files on a new device, while the unlock password gates previewing and downloading files in the Hippius Console. Lose the seed and the files are unrecoverable, so back it up before anything else.",
    showDescription: true,
  },
  notifications: {
    title: "Notification",
    description:
      "Choose which updates you'd like to receive in your inbox. You're in control—check only the notifications that matter to you.",
    tooltip:
      "Two independent channels: in app notifications appear inside Hippius for activity like file syncs and account credits, while email notifications are sent to the inbox of your linked email account for things like low-balance alerts and marketing updates. Toggle each one separately.",
    showDescription: true,
  },
  "api-key": {
    title: "API Token",
    description:
      "Manage your API token for secure file operations and delegated access.",
    tooltip:
      "Your API token allows you to authenticate requests to the Hippius platform. Keep it secure and never share it with anyone.",
    learnMoreUrl: "https://docs.hippius.com/use/desktop/settings#api-token",
    showDescription: true,
  },
  vpn: {
    title: "VPN",
    description: "Configure VPN behavior when the application starts.",
    tooltip:
      "When autoconnect is enabled, the VPN will automatically connect when you start the application. This ensures your connection is always protected. When disabled, you'll need to manually turn on the VPN each time you start the app.",
    learnMoreUrl: "https://docs.hippius.com/use/desktop/settings#vpn-settings",
    showDescription: true,
  },
  "customize-rpc": {
    title: "RPC Setting",
    description:
      "Customize your connection by updating the blockchain RPC endpoint.",
    tooltip:
      "The WebSocket URL your client uses to talk to the blockchain. Only change the default if you're running your own node or pointing at a trusted provider — the app restarts after every change.",
    showDescription: true,
  },
};

function SettingsContent() {
  const searchParams = useSearchParams();
  const section = searchParams.get("section") ?? "sync";
  const meta = SECTION_META[section] ?? SECTION_META["sync"];

  return (
    <div className="px-4 py-3">
      {/* Page heading */}
      <div className="mb-3">
        <div className="flex items-center gap-2 mb-1">
          <h1 className="font-geist text-[24px] leading-[32px] font-medium text-[#0A0A0A] dark:text-white">
            {meta.title}
          </h1>
          <InfoTooltip learnMoreUrl={meta.learnMoreUrl}>
            {meta.tooltip ?? meta.description}
          </InfoTooltip>
        </div>
        {meta.showDescription && (
          <p className="self-stretch font-geist text-[16px] leading-[22px] font-medium tracking-[-0.32px] text-[#7D7D7D] dark:text-grey-dark-600">
            {meta.description}
          </p>
        )}
      </div>

      {/* Section content */}
      <div className="flex flex-col gap-4 w-full">
        {section === "sync" && (
          <>
            <DeviceNameSetting />
            <MultiFolderSyncManager />
          </>
        )}

        {section === "appearance" && <AppearanceSettings />}

        {/* Wallets is hidden behind the same release gate as the Wallet
            sidebar entry (code kept). See featureFlags.ts. */}
        {WALLET_FEATURE_ENABLED && section === "wallets" && <WalletSettings />}

        {section === "security" && <RecoveryPhraseSettings />}

        {section === "notifications" && <NotificationSection />}

        {section === "api-key" && <ApiTokenSection />}

        {/* VPN is hidden behind a feature flag (code kept). See featureFlags.ts. */}
        {VPN_FEATURE_ENABLED && section === "vpn" && <VPNSettings />}

        {section === "customize-rpc" && <CustomizeRPC />}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsContent />
    </Suspense>
  );
}
