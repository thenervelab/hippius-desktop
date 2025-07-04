"use client";
import { useAtom } from "jotai";
import { sidebarCollapsedAtom } from "@/components/sidebar/sideBarAtoms";
import cn from "@/app/lib/utils/cn";
import HeaderText from "@/app/components/dashboard-title-wrapper/HeaderText";
import ProfileCard from "@/app/components/dashboard-title-wrapper/ProfileCard";

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
          <ProfileCard />
        </div>
        {children}
      </main>
    </div>
  );
}
