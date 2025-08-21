"use client";
import { useRouter } from "next/navigation";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { useEffect, useState } from "react";
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

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace("/login");
    }
  }, [isAuthenticated, isLoading, router]);

  useEffect(() => {
    if (isAuthenticated && !isLoading) {
      isOnboardingDone()
        .then((d) => setDone(d))
        .catch(() => setDone(false))
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
        setOnboardingCompleted={setDone}
      />
    );
  }
  return <>{children}</>;
}
