"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { LoginForm } from "@/app/components/auth/LoginForm";
import AuthLayout from "@/components/auth/AuthLayout";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

export default function LoginPage() {
  const [hideHeader, setHideHeader] = useState(false);
  const { isAuthenticated } = useWalletAuth();
  const router = useRouter();

  // Redirect to home if already authenticated
  useEffect(() => {
    if (isAuthenticated) {
      router.replace("/");
    }
  }, [isAuthenticated, router]);

  // Don't render login form if authenticated (prevents flash)
  if (isAuthenticated) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 bg-cover bg-center bg-no-repeat"
      style={{ backgroundImage: "url('/app-background.png')" }}
    >
      <AuthLayout hideHeader={hideHeader}>
        <LoginForm onHideHeaderChange={setHideHeader} />
      </AuthLayout>
    </div>
  );
}
