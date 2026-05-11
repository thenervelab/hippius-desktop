"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import MultiFolderSyncManager from "@/components/page-sections/settings/MultiFolderSyncManager";
import DeviceNameSetting from "@/components/page-sections/settings/DeviceNameSetting";
import RecoveryPhraseSettings from "@/components/page-sections/settings/RecoveryPhraseSettings";
import NotificationSettings from "@/components/page-sections/settings/NotificationSettings";
import EmailNotificationSection from "@/components/page-sections/settings/EmailNotificationSection";
import {
  ApiTokenCard,
  ApiTokenUsageCard,
} from "@/components/page-sections/settings/OAuthTokenSection";
import VPNSettings from "@/components/page-sections/settings/VPNSettings";
import CustomizeRPC from "@/components/page-sections/settings/CustomizeRPC";
import InfoTooltip from "@/components/page-sections/settings/InfoTooltip";

const SECTION_META: Record<
  string,
  { title: string; description: string }
> = {
  sync: {
    title: "Sync & Storage",
    description:
      "Configure your sync folders and storage options.",
  },
  security: {
    title: "Security",
    description: "Manage your recovery phrase and security settings.",
  },
  notifications: {
    title: "Notification",
    description:
      "Choose which updates you'd like to receive in your inbox. You're in control—check only the notifications that matter to you.",
  },
  "api-keys": {
    title: "API Keys",
    description: "Manage your API tokens and access credentials.",
  },
  vpn: {
    title: "VPN",
    description: "Configure your Nebula VPN settings.",
  },
  "customize-rpc": {
    title: "Customize RPC",
    description: "Set a custom RPC endpoint for blockchain queries.",
  },
};

function SettingsContent() {
  const searchParams = useSearchParams();
  const section = searchParams.get("section") ?? "sync";
  const meta = SECTION_META[section] ?? SECTION_META["sync"];

  return (
    <div className="px-8 pt-3 pb-8 max-w-3xl">
      {/* Section header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <h1 className="text-2xl font-medium text-grey-10 dark:text-white">
            {meta.title}
          </h1>
          <InfoTooltip>{meta.description}</InfoTooltip>
        </div>
        <p className="text-sm text-[#606060] dark:text-grey-dark-600">
          {meta.description}
        </p>
      </div>

      {/* Section content */}
      <div className="flex flex-col gap-4 w-full">
        {section === "sync" && (
          <>
            <div className="shadow-menu rounded-lg bg-white dark:bg-[#1A1A1A] p-4">
              <DeviceNameSetting />
            </div>
            <MultiFolderSyncManager />
          </>
        )}

        {section === "security" && <RecoveryPhraseSettings />}

        {section === "notifications" && (
          <>
            <div className="shadow-menu rounded-lg bg-white dark:bg-[#1A1A1A] p-4">
              <NotificationSettings />
            </div>
            <div className="shadow-menu rounded-lg bg-white dark:bg-[#1A1A1A] p-4">
              <EmailNotificationSection />
            </div>
          </>
        )}

        {section === "api-keys" && (
          <>
            <div className="shadow-menu rounded-lg bg-white dark:bg-[#1A1A1A] p-4">
              <ApiTokenCard />
            </div>
            <div className="shadow-menu rounded-lg bg-white dark:bg-[#1A1A1A] p-4">
              <ApiTokenUsageCard />
            </div>
          </>
        )}

        {section === "vpn" && (
          <div className="shadow-menu rounded-lg bg-white dark:bg-[#1A1A1A] p-4">
            <VPNSettings />
          </div>
        )}

        {section === "customize-rpc" && (
          <div className="shadow-menu rounded-lg bg-white dark:bg-[#1A1A1A] p-4">
            <CustomizeRPC />
          </div>
        )}


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
