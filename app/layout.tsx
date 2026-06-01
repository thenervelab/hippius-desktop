"use client";
import { Inter as InterFont, Geist, Geist_Mono } from "next/font/google";
import localFont from "next/font/local";
import "@/app/globals.css";
import Providers from "@/components/providers";
import { Toaster } from "sonner";
import "sonner/dist/styles.css";
import "react-circular-progressbar/dist/styles.css";
import NextTopLoader from "nextjs-toploader";
import { WalletAuthProvider } from "./lib/wallet-auth-context";
import PreAuthProvider from "@/app/components/auth/PreAuthProvider";
import { Suspense } from "react";
import PageLoader from "@/app/components/PageLoader";
// import SplashWrapper from "./components/splash-screen";
import { NavigationLoaderProvider } from "./lib/hooks/useNavigationLoader";
import UpdateChecker from "@/components/updater/UpdateChecker";
import TrayNavigationListener from "@/app/components/tray/TrayNavigationListener";
import ZoomController from "@/app/components/ZoomController";
import { cn } from "./lib/utils";
const inter = InterFont({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const digitalFonts = localFont({
  src: "./fonts/DigitalNumbers-Regular.ttf",
  variable: "--font-digital",
  display: "swap",
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="scroll-smooth">
      <body
        className={cn(
          inter.variable,
          geistSans.variable,
          geistMono.variable,
          digitalFonts.variable,
          geistSans.className,
          "bg-grey-100 text-grey-10 antialiased font-geist dark",
        )}
      >
        <Providers>
          <WalletAuthProvider>
            <UpdateChecker>
              <PreAuthProvider>
                <NextTopLoader color="#3167DD" showSpinner={false} />
                <NavigationLoaderProvider>
                  <TrayNavigationListener />
                  <ZoomController />
                  {/* <SplashWrapper preventClose={false}> */}
                  <Suspense fallback={<PageLoader />}>
                    <div className="flex min-h-screen h-screen">{children}</div>
                  </Suspense>
                  {/* </SplashWrapper> */}

                  {/* Toast styling mirrors hippius-web's SonnerToaster
                   *  setup: explicit dark-mode classNames so the toast
                   *  doesn't stay light-themed when the app is in dark
                   *  mode. Tailwind's `darkMode: "class"` strategy
                   *  means the `dark:*` classes fire based on the
                   *  `.dark` class the theme controller puts on
                   *  <html>; sonner's `theme="system"` is left in
                   *  place mostly for the default icon colours, but
                   *  the explicit `dark:` overrides are what
                   *  guarantee the colour flip. */}
                  <Toaster
                    position="top-center"
                    theme="system"
                    className="toaster-auth-aware"
                    toastOptions={{
                      style: { fontFamily: "var(--font-geist-sans)" },
                      classNames: {
                        toast:
                          "border-[#e3e3e3] bg-white text-[#0a0a0a] dark:border-[#494949] dark:bg-[#1e1e1e] dark:text-white",
                        title: "text-[#0a0a0a] dark:text-white",
                        description: "text-[#6c6c6c] dark:text-[#a0a0a0]",
                        icon: "text-[#0a0a0a] dark:text-white",
                      },
                    }}
                  />
                </NavigationLoaderProvider>
              </PreAuthProvider>
            </UpdateChecker>
          </WalletAuthProvider>
        </Providers>
      </body>
    </html>
  );
}
