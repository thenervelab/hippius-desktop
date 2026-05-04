"use client";

import React, { ReactNode, Suspense } from "react";
import { RevealTextLine } from "@/components/ui";
import LeftCarouselPanel from "./LeftCarouselPanel";
import { LucideLoader2 } from "lucide-react";

interface AuthLayoutProps {
  children: ReactNode;
  isVerify?: boolean;
  hideHeader?: boolean;
}

const AuthLayout = ({ children }: AuthLayoutProps) => {
  return (
    <main
      className="relative h-full w-full flex items-stretch p-[min(0.25rem,4px)] overflow-y-auto no-scrollbar"
    >
      <div className="w-[42%] shrink-0 grow-0 h-full">
        <RevealTextLine
          rotate
          reveal={true}
          parentClassName="w-full h-full"
          className="w-full h-full"
        >
          <LeftCarouselPanel />
        </RevealTextLine>
      </div>

      <div className="w-[58%] shrink-0 grow-0 h-full flex items-center justify-center px-[min(2rem,32px)]">
        <Suspense
          fallback={
            <div className="flex h-full w-full items-center justify-center opacity-0 grow animate-fade-in-0.5">
              <LucideLoader2 className="animate-spin text-primary-50" />
            </div>
          }
        >
          {children}
        </Suspense>
      </div>
    </main>
  );
};
export default AuthLayout;
