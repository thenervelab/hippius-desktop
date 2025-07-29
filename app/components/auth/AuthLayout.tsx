"use client";

import React, { ReactNode, Suspense } from "react";
import { RevealTextLine } from "../ui";
import LeftCarouselPanel from "./LeftCarouselPanel";
import { LucideLoader2 } from "lucide-react";
import BaseAuthLayout from "./BaseAuthLayout";
import HippiusHeader from "./HippiusHeader";

interface AuthLayoutProps {
  children: ReactNode;
  isVerify?: boolean;
}

const AuthLayout = ({ children, isVerify = false }: AuthLayoutProps) => {
  return (
    <BaseAuthLayout>
      <>
        <RevealTextLine
          rotate
          reveal={true}
          parentClassName="w-full h-full min-h-full max-h-full"
          className="w-full h-full min-h-full max-h-full"
        >
          <LeftCarouselPanel />
        </RevealTextLine>
        <div className="flex flex-col items-start justify-center h-full ">
          <HippiusHeader isVerify={isVerify} />
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
      </>
    </BaseAuthLayout>
  );
};
export default AuthLayout;
