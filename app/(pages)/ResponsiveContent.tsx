"use client";
import { useAtom } from "jotai";
import { sidebarCollapsedAtom } from "@/components/sidebar/sideBarAtoms";
import cn from "@/app/lib/utils/cn";
import HeaderText from "@/components/dashboard-title-wrapper/HeaderText";
import ProfileCard from "@/components/dashboard-title-wrapper/ProfileCard";
import BlockChainStats from "@/components/dashboard-title-wrapper/BlockChainStats";
import ConflictsBanner from "@/components/ui/ConflictsBanner";
import MigrationBanner from "@/components/ui/MigrationBanner";
import CreditsExhaustedBanner from "@/components/billing/CreditsExhaustedBanner";
import { SyncReauthRequiredAlert } from "@/components/ui/SyncReauthRequiredAlert";

export default function ResponsiveContent({
  children,
}: {
  children: React.ReactNode;
}) {
  const [collapsed] = useAtom(sidebarCollapsedAtom);

  return (
    <div className="grid w-full overflow-hidden">
      <main
        className={cn(
          "flex flex-col h-screen transition-all duration-300 ease-in-out overflow-hidden",
          collapsed ? "ml-[3.75rem]" : "ml-[11.625rem]"
        )}
      >
        {/* Sticky toolbar — always visible at the top */}
        <div className="sticky top-0 z-30 bg-white px-4 pt-4 pb-2">
          <div className="justify-between flex flex-wrap relative gap-x-4 gap-y-1 min-w-0">
            <HeaderText />
            <div className="flex -mt-2 gap-2 items-center justify-center shrink-0">
              <BlockChainStats />
              <ProfileCard />
            </div>
          </div>
          <ConflictsBanner />
          <MigrationBanner />
          <CreditsExhaustedBanner />
          {/* `SyncReauthRequiredAlert` auto-renders null unless Rust's
              `restore_session` flagged `sync_requires_reauth = true`
              (keychain-miss for a mnemonic user). Mounting it here in
              the sticky toolbar makes it visible on every authenticated
              route — the previous FilesContainer-only mount missed
              users whose last-visited page was /wallet, /billing, etc. */}
          <SyncReauthRequiredAlert className="mt-2" />
        </div>

        {/* Scrollable content area — serves as container query context */}
        <div className="flex-1 overflow-y-auto px-4 pb-4 @container">
          <div className="w-full">{children}</div>
        </div>
      </main>
    </div>
  );
}
