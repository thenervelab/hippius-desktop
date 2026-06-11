/**
 * NoEntriesBackgroundContainer Component
 *
 * A variant of BackgroundContainer designed for empty / "no entries" states.
 * Features:
 * - BackgroundContainerFrame without corner arrows
 * - BackgroundHippo icons at all 4 corners
 * - Solid decoration guide lines (not gradient)
 * - Diagonal-texture patches in the outer top-left and bottom-right corners
 * - No radial gradient overlay or dot-blur effect
 */

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { getDiagonalTextureSvgBackgroundImage } from "@/lib/ui-textures";
import { BackgroundHippo } from "./BackgroundHippo";

/* ------------------------------------------------------------------ */
/*  Pre-computed CSS texture images (same diagonal pattern as the     */
/*  BackgroundContainerFrame but rendered via CSS for the corners).   */
/* ------------------------------------------------------------------ */

const cornerTextureLight = getDiagonalTextureSvgBackgroundImage({
  opacity: 0.21,
});
const cornerTextureDark = getDiagonalTextureSvgBackgroundImage({
  color: "white",
  opacity: 0.1,
});

/* ------------------------------------------------------------------ */
/*  Solid decoration lines (no gradient fade)                         */
/* ------------------------------------------------------------------ */

function SolidDecorationLines({
  className,
  color,
  horizontalLength = "100vw",
  verticalLength = "200vh",
}: {
  className?: string;
  color: string;
  horizontalLength?: string;
  verticalLength?: string;
}) {
  return (
    <>
      <div
        className={cn(
          "absolute top-0 left-1/2 h-px -translate-x-1/2",
          className,
        )}
        style={{ width: horizontalLength, background: color }}
      />
      <div
        className={cn(
          "absolute bottom-0 left-1/2 h-px -translate-x-1/2",
          className,
        )}
        style={{ width: horizontalLength, background: color }}
      />
      <div
        className={cn(
          "absolute top-1/2 left-0 w-px -translate-y-1/2",
          className,
        )}
        style={{ height: verticalLength, background: color }}
      />
      <div
        className={cn(
          "absolute top-1/2 right-0 w-px -translate-y-1/2",
          className,
        )}
        style={{ height: verticalLength, background: color }}
      />
    </>
  );
}

export function NoEntriesSolidDecorations({
  className,
  lineColor = "#dcdcdc",
  darkLineColor = "#313131",
}: {
  className?: string;
  lineColor?: string;
  darkLineColor?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 -z-10 dark:z-10 overflow-visible",
        className,
      )}
    >
      <SolidDecorationLines className="dark:hidden" color={lineColor} />
      <SolidDecorationLines
        className="hidden dark:block"
        color={darkLineColor}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */

interface NoEntriesBackgroundContainerProps {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  fillHeight?: boolean;
}

export function NoEntriesBackgroundContainer({
  children,
  className,
  contentClassName,
  fillHeight = false,
}: NoEntriesBackgroundContainerProps) {
  return (
    <div
      className={cn(
        "relative w-full max-w-[700px]",
        fillHeight && "flex flex-col",
        className,
      )}
    >
      <div
        className={cn(
          "relative isolate overflow-visible",
          fillHeight && "flex-1 flex flex-col",
        )}
      >
        {/* Solid decoration guide lines */}
        <NoEntriesSolidDecorations />

        {/* Hippo icons at all 4 corners – hidden on mobile */}
        <BackgroundHippo className="absolute top-0 left-0 size-[22px] pointer-events-none z-[12] -translate-x-1/2 -translate-y-1/2 hidden md:block" />
        <BackgroundHippo className="absolute top-0 right-0 size-[22px] pointer-events-none z-[12] translate-x-1/2 -translate-y-1/2 hidden md:block" />
        <BackgroundHippo className="absolute bottom-0 left-0 size-[22px] pointer-events-none z-[12] -translate-x-1/2 translate-y-1/2 hidden md:block" />
        <BackgroundHippo className="absolute bottom-0 right-0 size-[22px] pointer-events-none z-[12] translate-x-1/2 translate-y-1/2 hidden md:block" />

        {/* DLight Mode textures */}
        <div
          aria-hidden="true"
          className="absolute inset-0 h-full w-full pointer-events-none dark:hidden bg-[rgba(242,242,242,0.42)]"
          style={{ backgroundImage: cornerTextureLight }}
        />

        {/* The corner patches are screen-sized (not container-sized): every
            host clips them with overflow-hidden, so they must overshoot to
            reach the host panel's edges. Container-sized (w-full/h-full)
            patches stopped one container-width from the corner and left the
            texture floating mid-panel on wide (zoomed-out) viewports. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-full bottom-full w-screen h-screen bg-[rgba(242,242,242,0.42)] dark:hidden"
          style={{ backgroundImage: cornerTextureLight }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-full top-full w-screen h-screen bg-[rgba(242,242,242,0.42)] dark:hidden"
          style={{ backgroundImage: cornerTextureLight }}
        />
        {/* dark mode textures */}
        <div
          aria-hidden="true"
          className="absolute inset-0 h-full w-full pointer-events-none bg-[#1A1A1A] hidden dark:block"
          style={{ backgroundImage: cornerTextureDark }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-full bottom-full w-screen h-screen bg-[#1A1A1A] hidden dark:block"
          style={{ backgroundImage: cornerTextureDark }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-full top-full w-screen h-screen bg-[#1A1A1A] hidden dark:block"
          style={{ backgroundImage: cornerTextureDark }}
        />
        {/* Content */}
        <div
          className={cn(
            "relative z-[20]  px-4 py-5 md:px-[40px] md:py-[33px]",
            fillHeight && "flex-1 flex flex-col",
            contentClassName,
          )}
        >
          {/* Layered card shell matching Figma */}
          <div
            className={cn(
              "md:bg-[#f6f6f6]  md:p-3 md:rounded-[35px] md:dark:bg-[#161616]",
              fillHeight && "flex-1 flex flex-col",
            )}
          >
            <div
              className={cn(
                "bg-[#dedede] p-[10px] rounded-[18px] md:rounded-[23px] dark:bg-[#1e1e1e]",
                fillHeight && "flex-1 flex flex-col",
              )}
            >
              <div
                className={cn(
                  "bg-white p-[5px] md:p-[6px] rounded-[14px] md:rounded-[16px] shadow-[-3px_8px_19px_0px_rgba(0,0,0,0.18)] dark:bg-[#161616] dark:shadow-[-3px_8px_19px_0px_rgba(0,0,0,0.4)]",
                  fillHeight && "flex-1 flex flex-col",
                )}
              >
                <div
                  className={cn(
                    "w-full  border border-[#ebebeb] rounded-[12px] shadow-[0_0_0_1px_rgba(51,51,51,0.04),0_16px_8px_-8px_rgba(51,51,51,0.01),0_12px_6px_-6px_rgba(51,51,51,0.02),0_5px_5px_-2.5px_rgba(51,51,51,0.08),0_1px_3px_-1.5px_rgba(51,51,51,0.16),0_-0.5px_0.5px_0_rgba(51,51,51,0.08)_inset] overflow-hidden  dark:border-[#313131] dark:shadow-[-27px_203px_57px_0px_rgba(0,0,0,0.01),-17px_130px_53px_0px_rgba(0,0,0,0.05),-10px_73px_44px_0px_rgba(0,0,0,0.18),-4px_33px_33px_0px_rgba(0,0,0,0.31),-1px_8px_18px_0px_rgba(0,0,0,0.36)]",
                    fillHeight && "flex-1 flex flex-col justify-between",
                  )}
                >
                  {children}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default NoEntriesBackgroundContainer;
