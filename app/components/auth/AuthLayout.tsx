"use client";

import React, { ReactNode, Suspense, useState, useEffect } from "react";
import { RevealTextLine } from "../ui";
import LeftCarouselPanel from "./LeftCarouselPanel";
import { LucideLoader2 } from "lucide-react";
import BaseAuthLayout from "./BaseAuthLayout";
import HippiusHeader from "./HippiusHeader";
import { isOnboardingDone } from "@/app/lib/helpers/onboardingDb";
import Onboarding from "./onboarding";

interface AuthLayoutProps {
  children: ReactNode;
  isVerify?: boolean;
}

const AuthLayout = ({ children, isVerify = false }: AuthLayoutProps) => {
  const [onboardingCompleted, setOnboardingCompleted] = useState<
    boolean | null
  >(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkOnboarding = async () => {
      try {
        const isDone = await isOnboardingDone();
        setOnboardingCompleted(isDone);
      } catch (error) {
        console.error("Error checking onboarding status:", error);
        setOnboardingCompleted(false);
      } finally {
        setLoading(false);
      }
    };

    checkOnboarding();
  }, []);

  if (loading) {
    return (
      <BaseAuthLayout>
        <div className="flex h-full w-full items-center justify-center">
          <LucideLoader2 className="animate-spin text-primary-50" />
        </div>
      </BaseAuthLayout>
    );
  }

  return (
    <BaseAuthLayout onboardingCompleted={onboardingCompleted}>
      {onboardingCompleted ? (
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
      ) : (
        <Onboarding setOnboardingCompleted={setOnboardingCompleted} />
      )}
    </BaseAuthLayout>
  );
};
export default AuthLayout;
