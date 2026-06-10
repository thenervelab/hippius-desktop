"use client";
import { useAtom } from "jotai";
import { sidebarCollapsedAtom } from "@/components/sidebar/sideBarAtoms";
import cn from "@/app/lib/utils/cn";
import ConflictsBanner from "@/components/ui/ConflictsBanner";
import MigrationBanner from "@/components/ui/MigrationBanner";
import CreditsExhaustedBanner from "@/components/billing/CreditsExhaustedBanner";
import { SyncReauthRequiredAlert } from "@/components/ui/SyncReauthRequiredAlert";
import FileDetailsPanel from "../components/page-sections/drive/FileDetailsPanel";

export default function ResponsiveContent({
  children,
}: {
  children: React.ReactNode;
}) {
  const [collapsed] = useAtom(sidebarCollapsedAtom);

  return (
    <div className="flex  w-full overflow-hidden">
      <main
        className={cn(
          "flex w-full flex-col h-[calc(100%-0.25rem)] transition-all duration-300 ease-in-out overflow-hidden bg-grey-light-200 rounded-[11px] dark:bg-black-900 mr-1 mb-1",
          collapsed ? "ml-[3.8125rem]" : "ml-[16.4375rem]",
        )}
      >
        {/* System alerts — sticky so they stay visible while scrolling */}
        <div className="sticky top-0 z-30 px-4">
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
        <div className="flex-1 overflow-y-auto @container flex flex-col">
          {/* Cap + center the content column on every page so cards and
              grids keep a sane aspect when the viewport is very wide in
              CSS px (zoomed out or large monitors). Below the cap this is
              a no-op. Note the @container above is the uncapped scroll
              area, so container-query breakpoints still see the full
              viewport width — fine, since 1800px fits every max layout. */}
          <div className="w-full max-w-[1800px] mx-auto flex-1 flex flex-col font-geist">
            {children}
          </div>
        </div>
      </main>
      <FileDetailsPanel />
    </div>
  );
}
