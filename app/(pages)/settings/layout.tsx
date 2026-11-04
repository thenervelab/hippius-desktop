"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSetAtom } from "jotai";
import { RESET } from "jotai/utils";
import { dashboardPageHeaderAtom } from "@/components/dashboard-title-wrapper/dashboardAtoms";
import SettingsSidebar from "@/components/sidebar/SettingsSidebar";
import { movedSettingsSectionRoute } from "@/components/sidebar/settingsNavGating";

/**
 * The settings chrome, or nothing while a moved section is sent on.
 *
 * The redirect is decided here rather than in the page so that an old
 * `/settings?section=billing` link never paints the Settings sidebar and
 * its "Settings" title on its way to Plans & Billing.
 */
function SettingsShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const movedTo = movedSettingsSectionRoute(searchParams.get("section"));
  const setTitle = useSetAtom(dashboardPageHeaderAtom);

  useEffect(() => {
    if (movedTo) router.replace(movedTo);
  }, [movedTo, router]);

  useEffect(() => {
    if (movedTo) return;
    setTitle({ mainText: "Settings" });
    return () => {
      setTitle(RESET);
    };
  }, [movedTo, setTitle]);

  if (movedTo) return null;

  return (
    <>
      <SettingsSidebar />
      {children}
    </>
  );
}

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense>
      <SettingsShell>{children}</SettingsShell>
    </Suspense>
  );
}
