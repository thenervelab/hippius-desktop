"use client";

import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

/** The design's confetti palette: blue, green, yellow, coral, pale blue. */
const COLORS = ["#568bff", "#04c870", "#ffc823", "#ff6d61", "#9ab8ff"];

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vrot: number;
  w: number;
  h: number;
  color: string;
  alpha: number;
  /** Phase for the side-to-side drift, so pieces do not sway in unison. */
  sway: number;
}

/**
 * Confetti drifting down from the top edge, drawn on a canvas.
 *
 * Pieces fall the way paper does, slowly with a sideways sway and a tumble,
 * and fade out before they reach the bottom of the box so the content below
 * stays legible. The stream loops for as long as the canvas is mounted;
 * viewers who asked for reduced motion get one still frame instead.
 */
export default function ConfettiCanvas({
  className,
  count = 90,
}: {
  className?: string;
  /** How many pieces are in the air at once. */
  count?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    let width = 0;
    let height = 0;
    let frame = 0;

    const spawn = (p: Piece, fromTop: boolean): Piece => {
      const w = 3 + Math.random() * 5;
      p.x = Math.random() * width;
      // Fresh pieces start above the box; the first fill scatters them
      // through it so the stream is already under way on the first frame.
      p.y = fromTop ? -10 - Math.random() * 40 : Math.random() * height;
      p.vx = (Math.random() - 0.5) * 0.3;
      p.vy = 0.35 + Math.random() * 0.55;
      p.rot = Math.random() * Math.PI;
      p.vrot = (Math.random() - 0.5) * 0.06;
      p.w = w;
      p.h = w * (0.35 + Math.random() * 0.25);
      p.color = COLORS[Math.floor(Math.random() * COLORS.length)];
      // The design draws the whole confetti layer at 80% opacity.
      p.alpha = 0.45 + Math.random() * 0.4;
      p.sway = Math.random() * Math.PI * 2;
      return p;
    };

    const pieces: Piece[] = [];

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (pieces.length === 0) {
        for (let i = 0; i < count; i++) {
          pieces.push(spawn({} as Piece, false));
        }
      }
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, width, height);
      for (const p of pieces) {
        // Fade over the last third of the drop so nothing lands on the text.
        const fade = Math.max(0, Math.min(1, (height - p.y) / (height * 0.35)));
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = p.alpha * fade;
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();

        if (reduceMotion) continue;
        p.x += p.vx + Math.sin(t / 900 + p.sway) * 0.25;
        p.y += p.vy;
        p.rot += p.vrot;
        if (p.y > height + 10 || p.x < -20 || p.x > width + 20) {
          spawn(p, true);
        }
      }
      if (!reduceMotion) frame = requestAnimationFrame(draw);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [count]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className={cn("pointer-events-none block", className)}
    />
  );
}
