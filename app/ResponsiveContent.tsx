"use client";
import { useAtom } from "jotai";
import { sidebarCollapsedAtom } from "./components/sidebar/sideBarAtoms";
// import SplashWrapper from "./components/splash-screen";
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
          {children}
        {/* <SplashWrapper skipSplash={false}>
          </SplashWrapper> */}
      </main>
    </div>
  );
}
