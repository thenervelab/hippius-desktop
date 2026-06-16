"use client";

import { usePathname } from "next/navigation";
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
import TranslocationGuard from "@/app/components/TranslocationGuard";
import ZoomController from "@/app/components/ZoomController";
import SplashWrapper from "./splash-screen-v2";

/**
 * Route prefix served inside the borderless system-tray popover window.
 * The tray panel is a separate Tauri webview that only ever loads this route,
 * while the main app window never navigates to it — so the pathname is a
 * reliable, hydration-safe discriminator between the two windows.
 */
const TRAY_PANEL_ROUTE = "/tray-panel";

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
 * Top-level shell that decides which provider tree to mount based on the
 * window we are running in.
 *
 * The tray popover must NOT boot the full app (auth/session restore, the
 * system-tray initializer, the updater, block subscriptions) — doing so would
 * create a second tray icon and duplicate background work in a throwaway
 * popover. It is a self-contained UI that talks to the backend over `invoke`,
 * so for that window we render just the children with no app providers.
 *
 * Branching on `usePathname()` (rather than a post-mount window-label check)
 * keeps the decision identical between static-export prerender and client
 * hydration, avoiding both a hydration mismatch and a one-frame mount of the
 * full provider tree inside the popover window.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (pathname?.startsWith(TRAY_PANEL_ROUTE)) {
    // The popover skips the app providers but still mounts the theme
    // provider so it follows the System/Light/Dark preference (shared
    // via localStorage) and tracks live OS theme changes. It uses the
    // default Jotai store — fine, since each window applies the theme
    // independently from the same stored preference.
    return <AppThemeProvider>{children}</AppThemeProvider>;
  }

  return (
    <Providers>
      <AppThemeProvider>
        <WalletAuthProvider>
          <UpdateChecker>
            <PreAuthProvider>
              <NextTopLoader color="#3167DD" showSpinner={false} />
              <NavigationLoaderProvider>
                <TrayNavigationListener />
                <TranslocationGuard />
                <ZoomController />
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
