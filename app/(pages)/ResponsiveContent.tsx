"use client";
import { useAtom } from "jotai";
import { sidebarCollapsedAtom } from "@/components/sidebar/sideBarAtoms";
import cn from "@/app/lib/utils/cn";
import ConflictsBanner from "@/components/ui/ConflictsBanner";
import MigrationBanner from "@/components/ui/MigrationBanner";
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
          "flex flex-col h-full transition-all duration-300 ease-in-out overflow-hidden bg-grey-light-200 rounded-[11px] dark:bg-black-900",
          collapsed ? "ml-[3.8125rem]" : "ml-[16.4375rem]",
        )}
      >
        {/* System alerts — sticky so they stay visible while scrolling */}
        <div className="sticky top-0 z-30 px-4">
          <ConflictsBanner />
          <MigrationBanner />
          <SyncReauthRequiredAlert className="mt-2" />
        </div>

        {/* Scrollable content area — serves as container query context */}
        <div className="flex-1 overflow-y-auto pl-3 pr-1 pb-1 @container flex flex-col">
          <div className="w-full flex-1 flex flex-col">{children}</div>
        </div>
      </main>
    </div>
  );
}
