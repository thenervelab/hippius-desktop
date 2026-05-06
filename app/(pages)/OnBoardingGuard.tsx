"use client";
import { useRouter } from "next/navigation";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { useEffect, useRef, useState } from "react";
import { isOnboardingDone } from "@/app/lib/helpers/onboardingDb";
import OnBoardingPage from "@/components/auth/onboarding/OnBoardingPage";
import PageLoader from "../components/PageLoader";

export default function OnBoardingGuard({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isAuthenticated, isLoading } = useWalletAuth();
  const router = useRouter();
  const [done, setDone] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(true);
  // Prevents the dev-mode override from resetting onboarding after the user completes it.
  const completedInSessionRef = useRef(false);

  const handleSetDone = (completed: boolean) => {
    if (completed) completedInSessionRef.current = true;
    setDone(completed);
  };

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace("/login");
    }
  }, [isAuthenticated, isLoading, router]);

  useEffect(() => {
    if (isAuthenticated && !isLoading) {
      // Always show onboarding during development for easy iteration,
      // but don't reset once the user has completed it in this session.
      if (process.env.NODE_ENV === "development") {
        if (!completedInSessionRef.current) {
          setDone(false);
        }
        setChecking(false);
        return;
      }
      isOnboardingDone()
        .then((d) => setDone(d))
        .catch((err: unknown) => {
          console.error("[OnBoardingGuard] Failed to check onboarding status:", err);
          setDone(false);
        })
        .finally(() => setChecking(false));
    }
  }, [isAuthenticated, isLoading]);

  if (isLoading || (isAuthenticated && checking)) {
    return <PageLoader />;
  }
  if (!isAuthenticated) return null;
  if (done === false) {
    return (
      <OnBoardingPage
        onboardingCompleted={done}
        setOnboardingCompleted={handleSetDone}
      />
    );
  }
  return <>{children}</>;
}
