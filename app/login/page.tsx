"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAtomValue } from "jotai";
import { LoginForm } from "@/app/components/auth/LoginForm";
import AuthLayout from "@/components/auth/AuthLayout";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { syncRequiresReauthAtom } from "@/app/lib/global-atoms/unpinAtoms";

export default function LoginPage() {
  const [hideHeader, setHideHeader] = useState(false);
  const { isAuthenticated } = useWalletAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const needsReauth = useAtomValue(syncRequiresReauthAtom);

  // Re-auth mode: an authenticated user whose OS keychain lost the seed phrase
  // arrives here via `/login?reauth=1` (the sync re-auth banner) to re-enter
  // it. We must NOT bounce them home while they still need to re-cache the
  // seed — that bounce is exactly what made the banner's CTA a dead end
  // (audit R-13). Once `login()` re-caches the seed and clears
  // `syncRequiresReauthAtom`, `reauthMode` flips false and the redirect below
  // carries them home.
  const reauthMode = searchParams.get("reauth") === "1" && needsReauth;

  // Redirect to home if already authenticated (unless we're in re-auth mode).
  useEffect(() => {
    if (isAuthenticated && !reauthMode) {
      router.replace("/");
    }
  }, [isAuthenticated, reauthMode, router]);

  // Don't render login form if authenticated (prevents flash) — but keep it
  // mounted in re-auth mode so the seed-phrase form is reachable.
  if (isAuthenticated && !reauthMode) {
    return null;
  }

  return (
    <div className="fixed inset-0 bg-cover bg-center bg-no-repeat bg-[url('/logged-out-app-background.png')] dark:bg-[url('/logged-out-app-background-dark.png')]">
      <AuthLayout hideHeader={hideHeader}>
        <LoginForm onHideHeaderChange={setHideHeader} />
      </AuthLayout>
    </div>
  );
}
