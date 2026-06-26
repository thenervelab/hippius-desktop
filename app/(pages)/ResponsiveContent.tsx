"use client";
import { useAtom } from "jotai";
import { useEffect, useLayoutEffect, useRef } from "react";
import { sidebarCollapsedAtom } from "@/components/sidebar/sideBarAtoms";
import cn from "@/app/lib/utils/cn";
import ConflictsBanner from "@/components/ui/ConflictsBanner";
import MigrationBanner from "@/components/ui/MigrationBanner";
import CreditsExhaustedBanner from "@/components/billing/CreditsExhaustedBanner";
import OfflineBanner from "@/components/ui/OfflineBanner";
import { SyncReauthRequiredAlert } from "@/components/ui/SyncReauthRequiredAlert";
import FileDetailsPanel from "../components/page-sections/drive/FileDetailsPanel";

/**
 * Distance the content's left margin changes between the expanded and collapsed
 * sidebar (`16.4375rem − 3.8125rem`). The shift is a fixed constant, so the
 * collapse/expand motion can be played as a GPU `transform` (see below) without
 * measuring anything at runtime.
 */
const COLLAPSE_SHIFT_REM = 12.625;

/**
 * `useLayoutEffect` on the server is a no-op that React warns about. The app is a
 * static export (client components are still prerendered in Node at build time),
 * so guard it. The FLIP below MUST run before paint, hence layout-effect not
 * effect.
 */
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

export default function ResponsiveContent({
  children,
}: {
  children: React.ReactNode;
}) {
  const [collapsed] = useAtom(sidebarCollapsedAtom);
  const mainRef = useRef<HTMLElement>(null);
  const prevCollapsed = useRef(collapsed);

  // Collapse/expand animation — FLIP, not a `margin-left` transition.
  //
  // The content's usable width changes with the sidebar, so animating
  // `margin-left` reflows this entire subtree (and re-runs every `@container`
  // query inside it) on EVERY frame of the 300ms — the source of the reported
  // lag. Instead the new margin (the final layout) is applied synchronously this
  // render; we then INVERT it with a composited `translateX` so it visually
  // starts where it was, and PLAY to identity. The whole motion is a single GPU
  // transform: zero per-frame reflow, and the container width changes exactly
  // once (at rest) instead of every frame.
  //
  // The rail itself keeps animating its width (a small, layer-promoted subtree),
  // and shares this curve/duration, so the rail's right edge and the content's
  // left edge stay locked together throughout.
  useIsomorphicLayoutEffect(() => {
    if (prevCollapsed.current === collapsed) return;
    prevCollapsed.current = collapsed;

    const el = mainRef.current;
    if (!el) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    // collapsed → margin shrank, content moves left → start shifted right (+).
    // expanded  → margin grew,  content moves right → start shifted left  (−).
    const invertRem = collapsed ? COLLAPSE_SHIFT_REM : -COLLAPSE_SHIFT_REM;

    el.style.transition = "none";
    el.style.transform = `translateX(${invertRem}rem)`;
    el.style.willChange = "transform";
    // Force the inverted start position to commit before re-enabling the
    // transition, otherwise the browser coalesces both writes and nothing moves.
    void el.offsetWidth;
    el.style.transition = "";
    el.style.transform = "";

    const clear = () => {
      el.style.willChange = "";
      el.removeEventListener("transitionend", clear);
    };
    el.addEventListener("transitionend", clear);
    return () => {
      el.removeEventListener("transitionend", clear);
      el.style.willChange = "";
    };
  }, [collapsed]);

  return (
    <div className="flex  w-full overflow-hidden">
      <main
        ref={mainRef}
        className={cn(
          // The margin SNAPS to its final value each toggle (no transition on
          // it); the visible motion is the FLIP transform above, which is all
          // this element transitions. See the layout effect for why.
          "flex w-full flex-col h-[calc(100%-0.25rem)] transition-transform duration-300 ease-in-out overflow-hidden bg-grey-light-200 rounded-[11px] dark:bg-black-900 mr-1 mb-1",
          collapsed ? "ml-[3.8125rem]" : "ml-[16.4375rem]",
        )}
      >
        {/* System alerts — sticky so they stay visible while scrolling */}
        <div className="sticky top-0 z-30 px-4">
          <OfflineBanner />
          <ConflictsBanner />
          <MigrationBanner />
          <CreditsExhaustedBanner />
          {/* `SyncReauthRequiredAlert` auto-renders null unless Rust's
              `restore_session` flagged `sync_requires_reauth = true`
              (keychain-miss for a mnemonic user). Mounting it here in
              the sticky toolbar makes it visible on every authenticated
              route — the previous FilesContainer-only mount missed
              users whose last-visited page was /wallet, /billing, etc. */}
          <SyncReauthRequiredAlert className="mt-2" />
        </div>

        {/* Scrollable content area — serves as container query context */}
        <div className="flex-1 overflow-y-auto @container flex flex-col">
          {/* Cap + center the content column on every page so cards and
              grids keep a sane aspect when the viewport is very wide in
              CSS px (zoomed out or large monitors). Below the cap this is
              a no-op. Note the @container above is the uncapped scroll
              area, so container-query breakpoints still see the full
              viewport width — fine, since 1800px fits every max layout. */}
          <div className="w-full max-w-[1800px] mx-auto flex-1 flex flex-col font-geist">
            {children}
          </div>
        </div>
      </main>
      <FileDetailsPanel />
    </div>
  );
}
