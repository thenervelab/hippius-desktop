"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import AppearanceSettings from "@/components/page-sections/settings/AppearanceSettings";
import ReleaseChannelSettings from "@/components/page-sections/settings/ReleaseChannelSettings";
import MultiFolderSyncManager from "@/components/page-sections/settings/MultiFolderSyncManager";
import DeviceNameSetting from "@/components/page-sections/settings/DeviceNameSetting";
import FinderExtensionSetting from "@/components/page-sections/settings/FinderExtensionSetting";
import { isMacPlatform } from "@/app/lib/utils/isMacPlatform";
import RecoveryPhraseSettings from "@/components/page-sections/settings/RecoveryPhraseSettings";
import WalletSettings from "@/components/page-sections/settings/WalletSettings";
import ApiTokenSection from "@/components/page-sections/settings/ApiTokenSection";
import VPNSettings from "@/components/page-sections/settings/VPNSettings";
import CustomizeRPC from "@/components/page-sections/settings/CustomizeRPC";
import InfoTooltip from "@/components/ui/info-tooltip";
import NotificationSection from "@/components/page-sections/settings/NotificationSection";
import BillingSections from "@/components/page-sections/billing/BillingSections";
import {
  VPN_FEATURE_ENABLED,
  WALLET_FEATURE_ENABLED,
  API_TOKEN_FEATURE_ENABLED,
} from "@/app/lib/featureFlags";
import {
  DEFAULT_SETTINGS_SECTION,
  resolveSettingsSection,
} from "@/app/components/sidebar/settingsNavGating";

const SECTION_META: Record<
  string,
  {
    title: string;
    description: string;
    /**
     * What the tooltip says. `ReactNode` rather than `string` because a
     * section whose tooltip is a short guide needs structure — a run-on
     * sentence of numbered steps is not a guide.
     *
     * Falls back to `description` when absent, so a section with nothing
     * extra to say is not forced to repeat itself deliberately. Billing
     * DID repeat itself: it had no tooltip, so the hint under the title
     * and the hint behind the icon were the same sentence.
     */
    tooltip?: React.ReactNode;
    /** Widens the tooltip for a section whose hint is more than a line. */
    tooltipClassName?: string;
    /** Opened externally through Tauri, never in the app webview. */
    learnMoreUrl?: string;
    showDescription?: boolean;
  }
> = {
  billing: {
    title: "Billing",
    description:
      "Your plan, your credits, and everything you have been charged for.",
    // The subtitle says what the page IS; the tooltip says how to use it.
    // Both routes are laid out because the choice is not obvious from the
    // page: the plan cards show a price, and nothing on them explains
    // that credits are an alternative to a card, or that a credit is a
    // dollar.
    tooltip: (
      <>
        <span className="mb-1 block font-semibold text-grey-10 dark:text-white">
          Two ways to pay for a storage plan
        </span>
        <span className="mb-1 block">
          <span className="font-semibold">By card:</span> pick a plan, choose
          Card, and Stripe opens in your browser. Your card then funds each
          renewal.
        </span>
        <span className="block">
          <span className="font-semibold">From credits:</span> add credits
          first (1 credit = $1), then pick a plan and choose Credits. Renewals
          come out of your balance, so keep it topped up.
        </span>
      </>
    ),
    // The default 260px is sized for one sentence; three short blocks
    // need the extra room or every line wraps twice.
    tooltipClassName: "max-w-[320px]",
    learnMoreUrl: "https://docs.hippius.com/use/desktop/billing",
    showDescription: true,
  },
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
  // Resolved against the feature gates, not just read: the section comes
  // from the query string, so a hidden sidebar entry does not make it
  // unreachable. See `resolveSettingsSection`.
  const section = resolveSettingsSection(searchParams.get("section"), {
    vpnEnabled: VPN_FEATURE_ENABLED,
    walletEnabled: WALLET_FEATURE_ENABLED,
    apiTokenEnabled: API_TOKEN_FEATURE_ENABLED,
  });
  const meta = SECTION_META[section] ?? SECTION_META[DEFAULT_SETTINGS_SECTION];

  return (
    <div className="px-4 py-3">
      {/* Page heading */}
      <div className="mb-3">
        <div className="flex items-center gap-2 mb-1">
          <h1 className="font-geist text-[24px] leading-[32px] font-medium text-[#0A0A0A] dark:text-white">
            {meta.title}
          </h1>
          <InfoTooltip
            learnMoreUrl={meta.learnMoreUrl}
            contentClassName={meta.tooltipClassName}
          >
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
        {section === "billing" && <BillingSections />}

        {section === "sync" && (
          <>
            <DeviceNameSetting />
            <MultiFolderSyncManager />
            {/* Finder Sync exists only on macOS; the row also hides itself
                when this build carries no extension (Rust answers
                `unsupported`), so a dev binary shows nothing here. */}
            {isMacPlatform() && <FinderExtensionSetting />}
          </>
        )}

        {section === "appearance" && <AppearanceSettings />}

        {/* Wallets is hidden behind the same release gate as the Wallet
            sidebar entry (code kept). See featureFlags.ts. */}
        {WALLET_FEATURE_ENABLED && section === "wallets" && <WalletSettings />}

        {section === "security" && <RecoveryPhraseSettings />}

        {section === "notifications" && <NotificationSection />}

        {/* API Token is hidden behind the same release gate as its sidebar
            entry (code kept). Gated at the render too, not just in the nav:
            the section is addressable directly, and a hidden link is not a
            gate. See featureFlags.ts. */}
        {API_TOKEN_FEATURE_ENABLED && section === "api-key" && <ApiTokenSection />}

        {section === "updates" && <ReleaseChannelSettings />}

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
