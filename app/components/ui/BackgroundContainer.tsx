"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { BackgroundContainerFrame } from "./BackgroundContainerFrame";
import { BackgroundHippo } from "./BackgroundHippo";

interface Props {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  shellClassName?: string;
  cardClassName?: string;
  hippoIconClassName?: string;
  fillClassName?: string;
  stopClickPropagation?: boolean;
  hideBackgroundDecorations?: boolean;
  hideBackgroundGradient?: boolean;
  addDotWithBlurryEffect?: boolean;
  isDialog?: boolean;
  borderClassName?: string;
  // When set, the four edge guide lines render as a solid 1px stroke of
  // this color in both light and dark mode (the gradient fade-in/out is
  // bypassed). Used by the wallet welcome screen — Figma spec there is
  // `border: 1px solid rgba(151,151,151,0.17)`.
  decorationLineColor?: string;
}

function gradientLine(
  direction: "horizontal" | "vertical",
  color: string,
  fadeStart = 26,
  fadeEnd = 74,
) {
  const axis = direction === "horizontal" ? "90deg" : "180deg";
  return `linear-gradient(${axis}, rgba(255,255,255,0) 0%, ${color} ${fadeStart}%, ${color} ${fadeEnd}%, rgba(255,255,255,0) 100%)`;
}

function DecorationLines({
  isDialog = false,
  solidColor,
}: {
  isDialog?: boolean;
  solidColor?: string;
}) {
  const lightColor = "#dcdcdc";
  const darkColor = "#2c2c2c";
  const vLen = isDialog ? "100vh" : "200vh";

  // Solid-color branch: single stroke in both themes (the rgba alpha
  // does the heavy lifting on dark surfaces). Skips the gradient mask
  // entirely so callers can hit the Figma "1px solid" spec.
  if (solidColor) {
    return (
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 overflow-visible block"
      >
        <div
          className="absolute top-0 left-1/2 h-px -translate-x-1/2"
          style={{ width: "100vw", background: solidColor }}
        />
        <div
          className="absolute bottom-0 left-1/2 h-px -translate-x-1/2"
          style={{ width: "100vw", background: solidColor }}
        />
        <div
          className="absolute top-1/2 left-0 w-px -translate-y-1/2"
          style={{ height: vLen, background: solidColor }}
        />
        <div
          className="absolute top-1/2 right-0 w-px -translate-y-1/2"
          style={{ height: vLen, background: solidColor }}
        />
      </div>
    );
  }

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 overflow-visible block"
    >
      {/* Top line */}
      <div
        className="absolute top-0 left-1/2 h-px -translate-x-1/2 dark:hidden"
        style={{ width: "100vw", background: gradientLine("horizontal", lightColor) }}
      />
      <div
        className="absolute top-0 left-1/2 h-px -translate-x-1/2 hidden dark:block"
        style={{ width: "100vw", background: gradientLine("horizontal", darkColor, 14, 86) }}
      />
      {/* Bottom line */}
      <div
        className="absolute bottom-0 left-1/2 h-px -translate-x-1/2 dark:hidden"
        style={{ width: "100vw", background: gradientLine("horizontal", lightColor) }}
      />
      <div
        className="absolute bottom-0 left-1/2 h-px -translate-x-1/2 hidden dark:block"
        style={{ width: "100vw", background: gradientLine("horizontal", darkColor, 14, 86) }}
      />
      {/* Left line */}
      <div
        className="absolute top-1/2 left-0 w-px -translate-y-1/2 dark:hidden"
        style={{ height: "200vh", background: gradientLine("vertical", lightColor) }}
      />
      <div
        className="absolute top-1/2 left-0 w-px -translate-y-1/2 hidden dark:block"
        style={{ height: vLen, background: gradientLine("vertical", darkColor, 14, 86) }}
      />
      {/* Right line */}
      <div
        className="absolute top-1/2 right-0 w-px -translate-y-1/2 dark:hidden"
        style={{ height: "200vh", background: gradientLine("vertical", lightColor) }}
      />
      <div
        className="absolute top-1/2 right-0 w-px -translate-y-1/2 hidden dark:block"
        style={{ height: vLen, background: gradientLine("vertical", darkColor, 14, 86) }}
      />
    </div>
  );
}

export function BackgroundContainer({
  children,
  className,
  contentClassName,
  shellClassName,
  cardClassName,
  hippoIconClassName,
  fillClassName,
  stopClickPropagation = false,
  hideBackgroundDecorations = false,
  addDotWithBlurryEffect = false,
  isDialog = false,
  borderClassName,
  decorationLineColor,
}: Props) {
  return (
    <div
      className={cn("relative w-fit", className)}
      onClick={stopClickPropagation ? (e) => e.stopPropagation() : undefined}
    >
      <div className="relative isolate overflow-visible">

        {/* Guide lines */}
        {!hideBackgroundDecorations && (
          <DecorationLines
            isDialog={isDialog}
            solidColor={decorationLineColor}
          />
        )}

        {/* Corner hippo logos */}
        <BackgroundHippo fillClassName={fillClassName} hippoIconClassName={hippoIconClassName}
          className="absolute top-0 left-0 size-[22px] pointer-events-none z-[30] hidden sm:block -translate-x-1/2 -translate-y-1/2" />
        <BackgroundHippo fillClassName={fillClassName} hippoIconClassName={hippoIconClassName}
          className="absolute top-0 right-0 size-[22px] pointer-events-none z-[30] hidden sm:block translate-x-1/2 -translate-y-1/2" />
        <BackgroundHippo fillClassName={fillClassName} hippoIconClassName={hippoIconClassName}
          className="absolute bottom-0 left-0 size-[22px] pointer-events-none z-[30] hidden sm:block -translate-x-1/2 translate-y-1/2" />
        <BackgroundHippo fillClassName={fillClassName} hippoIconClassName={hippoIconClassName}
          className="absolute bottom-0 right-0 size-[22px] pointer-events-none z-[30] hidden sm:block translate-x-1/2 translate-y-1/2" />

        {/* Diagonal-stripe frame — light mode */}
        <BackgroundContainerFrame
          className="absolute inset-0 h-full w-full pointer-events-none dark:hidden hidden sm:block"
        />
        {/* Diagonal-stripe frame — dark mode */}
        <BackgroundContainerFrame
          tone="dark"
          className="absolute inset-0 hidden h-full w-full pointer-events-none dark:sm:block"
        />

        {/* Dot pattern + edge blur (opt-in). Two variants per layer so
            the same Figma-style dotted backdrop renders in both themes:
            `#d4d4d4` dots on the light backdrop, `#2c2c2c` dots that
            stay legible against the dialog's `bg-[#04040466]` dark
            overlay. The radial-mask blur sits on top in both modes to
            soften the dots into the dialog's edge. */}
        {addDotWithBlurryEffect && (
          <>
            {/* Light-mode dots */}
            <div
              className="pointer-events-none absolute top-1/2 left-1/2 z-[-1] h-[100vh] w-[100vw] -translate-x-1/2 -translate-y-1/2 dark:hidden block"
              aria-hidden="true"
            >
              <div
                className="w-full h-full"
                style={{
                  backgroundImage:
                    "radial-gradient(circle, #d4d4d4 1.5px, transparent 1.5px)",
                  backgroundSize: "18px 18px",
                }}
              />
            </div>
            {/* Dark-mode dots */}
            <div
              className="pointer-events-none absolute top-1/2 left-1/2 z-[-1] h-[100vh] w-[100vw] -translate-x-1/2 -translate-y-1/2 hidden dark:block"
              aria-hidden="true"
            >
              <div
                className="w-full h-full"
                style={{
                  backgroundImage:
                    "radial-gradient(circle, #2c2c2c 1.5px, transparent 1.5px)",
                  backgroundSize: "18px 18px",
                }}
              />
            </div>
            {/* Light-mode edge blur */}
            <div
              className="pointer-events-none absolute top-1/2 left-1/2 z-[11] -translate-x-1/2 -translate-y-1/2 dark:hidden block"
              aria-hidden="true"
              style={{
                height: "100vh",
                width: "100vw",
                backdropFilter: "blur(1.5px)",
                maskImage:
                  "radial-gradient(ellipse 50vw 75vh at 50% 50%, transparent 0%, transparent 60%, black 61%)",
                WebkitMaskImage:
                  "radial-gradient(ellipse 60vw 75vh at 50% 50%, transparent 0%, transparent 60%, black 61%)",
              }}
            />
            {/* Dark-mode edge blur */}
            <div
              className="pointer-events-none absolute top-1/2 left-1/2 z-[11] -translate-x-1/2 -translate-y-1/2 hidden dark:block"
              aria-hidden="true"
              style={{
                height: "100vh",
                width: "100vw",
                backdropFilter: "blur(1.5px)",
                maskImage:
                  "radial-gradient(ellipse 50vw 75vh at 50% 50%, transparent 0%, transparent 60%, black 61%)",
                WebkitMaskImage:
                  "radial-gradient(ellipse 60vw 75vh at 50% 50%, transparent 0%, transparent 60%, black 61%)",
              }}
            />
          </>
        )}

        {/* Content layers: gray ring → colored border → white card */}
        <div className={cn("relative z-[20] px-0 py-0 sm:px-[60px] sm:py-[51px]", contentClassName)}>
          {/* Gray outer ring */}
          <div
            className={cn(
              "bg-[#e1e1e1] p-1.5 rounded-[16px] sm:p-4 sm:rounded-[32px] w-full min-w-0 dark:bg-[#343333]",
              shellClassName,
            )}
          >
            {/* Colored accent border */}
            <div className={cn("p-2 sm:p-3 rounded-[10px] sm:rounded-[16px]", borderClassName ?? "bg-[#3167dd]")}>
              {/* White / dark card */}
              <div
                className={cn(
                  "bg-white rounded-[4px] p-4 flex flex-col gap-4 overflow-hidden dark:bg-[#161616]",
                  "shadow-[0px_125px_35px_0px_rgba(0,0,0,0),0px_80px_32px_0px_rgba(0,0,0,0.03),0px_45px_27px_0px_rgba(0,0,0,0.08),0px_20px_20px_0px_rgba(0,0,0,0.14),0px_5px_11px_0px_rgba(0,0,0,0.17)]",
                  cardClassName,
                )}
              >
                {children}
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

export default BackgroundContainer;
