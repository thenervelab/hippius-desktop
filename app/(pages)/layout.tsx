"use client";

import "@/app/globals.css";
import Sidebar from "@/components/sidebar";
import "react-circular-progressbar/dist/styles.css";
import ResponsiveContent from "./ResponsiveContent";
import { useRouter } from "next/navigation";
import { useWalletAuth } from "../lib/wallet-auth-context";
import { useEffect } from "react";
import { Loader2 } from "lucide-react";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { isAuthenticated, isLoading } = useWalletAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace("/login");
    }
  }, [isAuthenticated, isLoading, router]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen w-full">
        <Loader2 className="size-20 animate-spin text-grey-50" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }
  return (
    <div className="flex min-h-screen w-full">
      <Sidebar />
      <ResponsiveContent>{children}</ResponsiveContent>
    </div>
  );
}
