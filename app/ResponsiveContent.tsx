"use client";
import { useAtom } from "jotai";
import { sidebarCollapsedAtom } from "./components/sidebar/sideBarAtoms";
import SplashWrapper from "./components/splash-screen";
import RootFooter from "@/components/root-footer";
import cn from "@/app/lib/utils/cn";

export default function ResponsiveContent({
  children,
}: {
  children: React.ReactNode;
}) {
  const [collapsed] = useAtom(sidebarCollapsedAtom);

  return (
    <div className="flex flex-col flex-grow">
      <main
        className={cn(
          "flex-grow p-4 transition-all duration-300 ease-in-out",
          collapsed ? "ml-[60px]" : "ml-[161px]"
        )}
      >
        <SplashWrapper skipSplash={true}>{children}</SplashWrapper>
      </main>
      <div
        className={cn(
          "p-4 transition-all duration-300 ease-in-out",
          collapsed ? "ml-[60px]" : "ml-[161px]"
        )}
      >
        <RootFooter />
      </div>
    </div>
  );
}
