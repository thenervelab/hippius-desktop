"use client";
import { useRouter } from "next/navigation";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { isOnboardingDone } from "@/app/lib/helpers/onboardingDb";
import OnBoardingPage from "@/components/auth/onboarding/OnBoardingPage";

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
    return (
      <div className="flex items-center justify-center min-h-screen w-full">
        <Loader2 className="animate-spin text-grey-50" />
      </div>
    );
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
