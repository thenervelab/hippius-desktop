"use client";

import Sidebar from "@/components/sidebar";
import ResponsiveContent from "./ResponsiveContent";
import OnBoardingGuard from "./OnBoardingGuard";
import { LocalWalletProvider } from "@/app/contexts/LocalWalletContext";
// TODO: Re-enable once backend integration is stable and syncing is reliable
// import UnpinnedFilesHandler from "./UnpinnedFilesHandler";

export default function ProtectedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <OnBoardingGuard>
      <LocalWalletProvider>
        <div className="flex min-h-screen w-full">
          {/* TODO: Re-enable Pinning Queue once backend integration is stable */}
          {/* <UnpinnedFilesHandler /> */}
          <Sidebar />
          <ResponsiveContent>{children}</ResponsiveContent>
        </div>
      </LocalWalletProvider>
    </OnBoardingGuard>
  );
}
