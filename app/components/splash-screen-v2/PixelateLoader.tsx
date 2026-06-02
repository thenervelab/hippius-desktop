"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { gsap } from "gsap";

interface PixelateLoaderProps {
  durationMs?: number; // total time to stagger-shrink pixels
  cellSize?: number;   // pixel square size in px
  color?: string;      // overlay color
  easing?: string;     // gsap ease
  onComplete?: () => void;
}

// Full-screen pixelation transition overlay using GSAP
export default function PixelateLoader({
  durationMs = 900,
  cellSize = 24,
  color = "#0F0507",
  easing = "power2.inOut",
  onComplete,
}: PixelateLoaderProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [gridDims, setGridDims] = useState<{ rows: number; cols: number } | null>(null);

  // Compute grid once on client (before paint to avoid FOUC)
  useLayoutEffect(() => {
    setMounted(true);
    const width = window.innerWidth;
    const height = window.innerHeight;
    const cols = Math.ceil(width / cellSize);
    const rows = Math.ceil(height / cellSize);
    setGridDims({ rows, cols });
  }, [cellSize]);

  // Build and run the pixelate animation once
  useLayoutEffect(() => {
    if (!mounted || !gridDims || hidden) return;

    // Respect reduced motion
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setHidden(true);
      onComplete?.();
      return;
    }

    let raf1 = 0;
    let raf2 = 0;
    const ctx = gsap.context(() => {
      // Wait two frames to ensure the grid is mounted and painted
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          const gridEl = gridRef.current;
          const cells = gridEl ? (Array.from(gridEl.children) as HTMLDivElement[]) : [];
          if (cells.length === 0) return;

          gsap.set(cells, {
            scale: 1,
            opacity: 1,
            transformOrigin: "50% 50%",
            willChange: "transform, opacity",
            backfaceVisibility: "hidden",
          });

          const tl = gsap.timeline({
            defaults: { ease: easing },
            onComplete: () => {
              gsap.to(containerRef.current, {
                opacity: 0,
                duration: 0.35,
                ease: "power2.out",
                onComplete: () => {
                  setHidden(true);
                  onComplete?.();
                },
              });
            },
          });

          // Pixelate out from center by default
          tl.fromTo(
            cells,
            { scale: 1, opacity: 1 },
            {
              scale: 0,
              opacity: 0,
              force3D: true,
              duration: 0.6,
              stagger: {
                amount: durationMs / 1000,
                grid: [gridDims.rows, gridDims.cols],
                from: "center",
              },
            }
          );
        });
      });
    }, containerRef);

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      ctx.revert();
    };
  }, [mounted, gridDims, durationMs, easing, hidden, onComplete]);

  // Hide entirely after complete
  if (hidden) return null;

  // Render a solid overlay first to avoid FOUC before grid mounts
  return (
    <div
      ref={containerRef}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        backgroundColor: gridDims ? "transparent" : color,
        overflow: "hidden",
      }}
    >
      {/* Render grid only when dims known */}
      {gridDims ? (
        <div
          ref={gridRef}
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            gridTemplateColumns: `repeat(${gridDims.cols}, ${cellSize}px)`,
            gridTemplateRows: `repeat(${gridDims.rows}, ${cellSize}px)`,
          }}
        >
          {Array.from({ length: gridDims.rows * gridDims.cols }).map((_, idx) => (
            <div
              key={idx}
              className="pixel-cell"
              style={{
                backgroundColor: color,
                width: "100%",
                height: "100%",
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
