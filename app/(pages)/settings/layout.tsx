"use client";

import { Suspense, useEffect } from "react";
import { useSetAtom } from "jotai";
import { RESET } from "jotai/utils";
import { dashboardPageHeaderAtom } from "@/components/dashboard-title-wrapper/dashboardAtoms";
import SettingsSidebar from "@/components/sidebar/SettingsSidebar";

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const setTitle = useSetAtom(dashboardPageHeaderAtom);

  useEffect(() => {
    setTitle({ mainText: "Settings" });
    return () => {
      setTitle(RESET);
    };
  }, [setTitle]);

  return (
    <>
      <Suspense>
        <SettingsSidebar />
      </Suspense>
      {children}
    </>
  );
}
