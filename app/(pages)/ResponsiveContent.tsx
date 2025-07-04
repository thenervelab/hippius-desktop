"use client";
import { useAtom } from "jotai";
import { sidebarCollapsedAtom } from "@/components/sidebar/sideBarAtoms";
import cn from "@/app/lib/utils/cn";
import HeaderText from "@/components/dashboard-title-wrapper/HeaderText";
import ProfileCard from "@/components/dashboard-title-wrapper/ProfileCard";
import BlockChainStats from "@/components/dashboard-title-wrapper/BlockChainStats";

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
        <div className=" bg-white z-10 justify-between flex ">
          <HeaderText />
          <div className="flex gap-5 items-center justify-center">
            <BlockChainStats />
            <ProfileCard />
          </div>
        </div>
        {children}
      </main>
    </div>
  );
}
