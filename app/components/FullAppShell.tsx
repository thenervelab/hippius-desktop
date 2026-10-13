"use client";

import { Suspense } from "react";
import { Toaster } from "sonner";
import NextTopLoader from "nextjs-toploader";
import Providers from "@/components/providers";
import { AppThemeProvider, useAppTheme } from "@/app/lib/theme-context";
import { WalletAuthProvider } from "@/app/lib/wallet-auth-context";
import PreAuthProvider from "@/app/components/auth/PreAuthProvider";
import PageLoader from "@/app/components/PageLoader";
import { NavigationLoaderProvider } from "@/app/lib/hooks/useNavigationLoader";
import UpdateChecker from "@/components/updater/UpdateChecker";
import TrayNavigationListener from "@/app/components/tray/TrayNavigationListener";
import DeepLinkListener from "@/app/components/auth/DeepLinkListener";
import TranslocationGuard from "@/app/components/TranslocationGuard";
import FinderExtensionGuard from "@/app/components/FinderExtensionGuard";
import ZoomController from "@/app/components/ZoomController";
import SettingsShortcut from "@/app/components/SettingsShortcut";
import SplashWrapper from "./splash-screen-v2";

/**
 * Toaster that follows the user's resolved theme rather than the OS
 * (`theme="system"` reads prefers-color-scheme directly, which diverges
 * when the user forces Light/Dark in settings). The Tailwind `dark:`
 * classNames below already track the `.dark` class; passing the resolved
 * theme keeps sonner's own data-theme defaults (borders, close button)
 * in agreement. Must render inside the Jotai provider tree.
 */
function ThemedToaster() {
  const { resolvedTheme } = useAppTheme();

  return (
    <Toaster
      position="top-center"
      theme={resolvedTheme}
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
  );
}

/**
 * The main window's provider tree: auth, the updater, the splash, the tray
 * navigation listener and the toaster. Loaded by `AppShell` through
 * `next/dynamic` so the popover and capture windows, which never render it,
 * do not download or parse polkadot, react-query or framer-motion.
 */
export default function FullAppShell({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <AppThemeProvider>
        <WalletAuthProvider>
          <UpdateChecker>
            <PreAuthProvider>
              <NextTopLoader color="#3167DD" showSpinner={false} />
              <NavigationLoaderProvider>
                <TrayNavigationListener />
                {/* Global so an OAuth callback is handled on ANY route,
                 *  not only while the login page is mounted (audit M-3). */}
                <DeepLinkListener />
                <TranslocationGuard />
                <FinderExtensionGuard />
                <ZoomController />
                <SettingsShortcut />
                <SplashWrapper preventClose={false}>
                  <Suspense fallback={<PageLoader ringFill="once" />}>
                    <div className="flex min-h-screen h-screen">{children}</div>
                  </Suspense>
                </SplashWrapper>

                {/* Toast styling mirrors hippius-web's SonnerToaster setup:
                 *  explicit dark-mode classNames so the toast doesn't stay
                 *  light-themed when the app is in dark mode. */}
                <ThemedToaster />
              </NavigationLoaderProvider>
            </PreAuthProvider>
          </UpdateChecker>
        </WalletAuthProvider>
      </AppThemeProvider>
    </Providers>
  );
}
