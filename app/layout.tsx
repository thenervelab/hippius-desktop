"use client";
import { Geist } from "next/font/google";
import localFont from "next/font/local";
import "@/app/globals.css";
import Providers from "@/components/providers";
import { Toaster } from "sonner";
import "react-circular-progressbar/dist/styles.css";
import NextTopLoader from "nextjs-toploader";
import { WalletAuthProvider } from "./lib/wallet-auth-context";
import PreAuthProvider from "@/app/components/auth/PreAuthProvider";
import { Suspense } from "react";
import PageLoader from "@/app/components/PageLoader";
import SplashWrapper from "./components/splash-screen";
import UpdateDialogWrapper from "./components/updater/UpdateDialogWrapper";
import { NavigationLoaderProvider } from "./lib/hooks/useNavigationLoader";


const digitalFonts = localFont({
  src: "./fonts/DigitalNumbers-Regular.ttf",
  display: "swap",
});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="scroll-smooth">
      <body
        className={`${digitalFonts.className} ${geistSans.className} ${geistSans.variable} bg-grey-100 text-grey-10 antialiased font-sans`}
      >
        <Providers>
          <WalletAuthProvider>
            <PreAuthProvider>
              <NextTopLoader color="#3167DD" showSpinner={false} />
              <NavigationLoaderProvider>
                <Suspense fallback={<PageLoader />}>
                  <SplashWrapper skipSplash={false}>
                    <div className="flex min-h-screen h-screen">{children}</div>
                  </SplashWrapper>
                </Suspense>
                <UpdateDialogWrapper />
                <Toaster
                  toastOptions={{
                    style: { fontFamily: "var(--font-geist-sans)" },
                  }}
                />
              </NavigationLoaderProvider>
            </PreAuthProvider>
          </WalletAuthProvider>
        </Providers>
      </body>
    </html>
  );
}
