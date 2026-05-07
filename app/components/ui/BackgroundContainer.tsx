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
  strokeClassName?: string;
  fillClassName?: string;
  stopClickPropagation?: boolean;
  hideBackgroundDecorations?: boolean;
  hideBackgroundGradient?: boolean;
  addDotWithBlurryEffect?: boolean;
  isDialog?: boolean;
  borderClassName?: string;
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

function DecorationLines({ isDialog = false }: { isDialog?: boolean }) {
  const lightColor = "#dcdcdc";
  const darkColor = "#2c2c2c";
  const hLen = isDialog ? "50vw" : "100vw";
  const vLen = isDialog ? "100vh" : "200vh";

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 overflow-visible block"
    >
      {/* Light mode lines */}
      <div className="dark:hidden">
        {(["top", "bottom"] as const).map((p) => (
          <div
            key={p}
            className={cn(
              "absolute left-1/2 h-px w-[100vw] -translate-x-1/2",
              p === "top" ? "top-0" : "bottom-0",
            )}
            style={{ background: gradientLine("horizontal", lightColor) }}
          />
        ))}
        {(["left", "right"] as const).map((p) => (
          <div
            key={p}
            className={cn(
              "absolute top-1/2 w-px -translate-y-1/2",
              p === "left" ? "left-0" : "right-0",
            )}
            style={{ height: "200vh", background: gradientLine("vertical", lightColor) }}
          />
        ))}
      </div>

      {/* Dark mode lines */}
      <div className="hidden dark:block">
        {(["top", "bottom"] as const).map((p) => (
          <div
            key={p}
            className={cn(
              "absolute left-1/2 h-px -translate-x-1/2",
              p === "top" ? "top-0" : "bottom-0",
            )}
            style={{ width: hLen, background: gradientLine("horizontal", darkColor, 14, 86) }}
          />
        ))}
        {(["left", "right"] as const).map((p) => (
          <div
            key={p}
            className={cn(
              "absolute top-1/2 w-px -translate-y-1/2",
              p === "left" ? "left-0" : "right-0",
            )}
            style={{ height: vLen, background: gradientLine("vertical", darkColor, 14, 86) }}
          />
        ))}
      </div>
    </div>
  );
}

export function BackgroundContainer({
  children,
  className,
  contentClassName,
  shellClassName,
  cardClassName,
  strokeClassName,
  fillClassName,
  stopClickPropagation = false,
  hideBackgroundDecorations = false,
  addDotWithBlurryEffect = false,
  isDialog = false,
  borderClassName,
}: Props) {
  return (
    <div
      className={cn("relative w-fit", className)}
      onClick={stopClickPropagation ? (e) => e.stopPropagation() : undefined}
    >
      <div className="relative isolate overflow-visible">

        {/* Guide lines */}
        {!hideBackgroundDecorations && <DecorationLines isDialog={isDialog} />}

        {/* Corner connector icons */}
        {[
          "absolute top-0 left-0 -translate-x-1/2 -translate-y-1/2",
          "absolute top-0 right-0 translate-x-1/2 -translate-y-1/2",
          "absolute bottom-0 left-0 -translate-x-1/2 translate-y-1/2",
          "absolute bottom-0 right-0 translate-x-1/2 translate-y-1/2",
        ].map((pos, i) => (
          <BackgroundHippo
            key={i}
            fillClassName={fillClassName}
            strokeClassName={strokeClassName}
            className={cn("size-[22px] pointer-events-none z-[30] block", pos)}
          />
        ))}

        {/* Diagonal-line frame SVG — light */}
        <BackgroundContainerFrame
          className="absolute inset-0 h-full w-full pointer-events-none dark:hidden block"
        />
        {/* Diagonal-line frame SVG — dark */}
        <BackgroundContainerFrame
          tone="dark"
          className="absolute inset-0 h-full w-full pointer-events-none hidden dark:block"
        />

        {/* Dot pattern + edge blur (opt-in) */}
        {addDotWithBlurryEffect && (
          <>
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
