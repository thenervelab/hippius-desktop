"use client";

import React, { useEffect, useState, useRef } from "react";

/* ─── cipher‑text scramble characters ─── */
const CIPHER_CHARS = "█▓▒░@#$%&*?!<>{}[]~^±§µ∆Ω";
const CLEAR_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomChar(pool: string) {
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * A single character cell that cycles through cipher glyphs and
 * eventually "resolves" to a clear alphanumeric — the classic
 * Hollywood‑style decrypt reveal.
 */
const ScrambleCell: React.FC<{ delay: number; resolved: boolean }> = ({
  delay,
  resolved,
}) => {
  const [char, setChar] = useState(() => randomChar(CIPHER_CHARS));
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const timeout = setTimeout(() => {
      intervalRef.current = setInterval(() => {
        setChar(resolved ? randomChar(CLEAR_CHARS) : randomChar(CIPHER_CHARS));
      }, 60);
    }, delay);
    return () => {
      clearTimeout(timeout);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [delay, resolved]);

  return (
    <span
      className={
        resolved
          ? "text-primary-50 dark:text-primary-40 opacity-90"
          : "text-[#666] dark:text-[#555] opacity-60"
      }
      style={{ transition: "color 0.3s, opacity 0.3s" }}
    >
      {char}
    </span>
  );
};

/**
 * Grid of scrambling characters with a reveal wave that sweeps
 * left → right, turning cipher glyphs into clear text.
 */
const ScrambleGrid: React.FC = () => {
  const cols = 14;
  const rows = 3;
  const total = cols * rows;
  const [revealIndex, setRevealIndex] = useState(-1);

  useEffect(() => {
    // Wave reveal: one column at a time every 220ms, loops
    const interval = setInterval(() => {
      setRevealIndex((prev) => {
        if (prev >= cols + 2) return -1; // reset to loop
        return prev + 1;
      });
    }, 220);
    return () => clearInterval(interval);
  }, []);

  return (
    <div
      className="grid gap-x-[3px] gap-y-[2px] font-mono text-[11px] leading-[14px] tracking-[1px]"
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
    >
      {Array.from({ length: total }, (_, i) => {
        const col = i % cols;
        const resolved = col <= revealIndex;
        return (
          <ScrambleCell
            key={i}
            delay={col * 30 + Math.random() * 40}
            resolved={resolved}
          />
        );
      })}
    </div>
  );
};

/**
 * Animated decryption graphic. Depicts an unlocking padlock with
 * the shackle opening, surrounded by cipher text that resolves into
 * clear characters — clearly communicating "decryption in progress".
 *
 * @param showScramble — show the cipher-text grid (default true).
 *   Pass `false` where only the lock animation is needed.
 * @param ringFill — progress-ring behaviour. `"loop"` (default) sweeps
 *   continuously for indefinite page loads. `"once"` sweeps a single, quicker
 *   revolution and holds full (`forwards`), for a deliberate "we're done"
 *   hand-off — used by the splash outro so the ring never restarts from empty.
 */
const DecryptingAnimation: React.FC<{
  showScramble?: boolean;
  ringFill?: "loop" | "once";
}> = ({ showScramble = true, ringFill = "loop" }) => (
  <div className="flex flex-col items-center gap-6 select-none">
    {/* ─── Main graphic ─── */}
    <div className="relative flex items-center justify-center w-[120px] h-[120px]">
      {/* Soft radial glow */}
      <div
        className="absolute inset-0 rounded-full animate-[pulse_3s_ease-in-out_infinite]"
        style={{
          background:
            "radial-gradient(circle, rgba(59,130,246,0.07) 0%, transparent 70%)",
        }}
      />

      {/* Progress ring — continuously fills around the lock */}
      <svg
        className="absolute inset-0 w-full h-full -rotate-90"
        viewBox="0 0 120 120"
        fill="none"
      >
        <circle
          cx="60"
          cy="60"
          r="56"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-primary-50/10 dark:text-primary-50/[0.07]"
        />
        <circle
          cx="60"
          cy="60"
          r="56"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray="352"
          className={
            ringFill === "once"
              ? "text-primary-50/40 dark:text-primary-40/30 animate-[decrypt-progress_1.2s_ease-out_forwards]"
              : "text-primary-50/40 dark:text-primary-40/30 animate-[decrypt-progress_2.5s_linear_infinite]"
          }
        />
      </svg>

      {/* Unlock icon — centre piece */}
      <svg
        className="relative z-10 w-[44px] h-[44px] text-primary-50 dark:text-primary-40 drop-shadow-[0_0_12px_rgba(59,130,246,0.25)]"
        viewBox="0 0 64 64"
        fill="none"
      >
        {/* Lock body */}
        <rect
          x="18"
          y="30"
          width="28"
          height="20"
          rx="3"
          stroke="currentColor"
          strokeWidth="2"
          fill="currentColor"
          fillOpacity="0.06"
        />
        {/* Shackle — animates from closed to open */}
        <path
          d="M24 30V24C24 18.48 28.48 14 34 14V14"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="animate-[decrypt-unlock_3s_ease-in-out_infinite]"
        />
        {/* Keyhole */}
        <circle
          cx="32"
          cy="38"
          r="2.5"
          fill="currentColor"
          className="animate-[pulse_2s_ease-in-out_infinite]"
        />
        <line
          x1="32"
          y1="40.5"
          x2="32"
          y2="44"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>

      {/* Burst particles — data escaping the lock */}
      {[0, 45, 90, 135, 180, 225, 270, 315].map((angle, i) => (
        <div
          key={angle}
          className="absolute left-1/2 top-1/2 w-0 h-0"
          style={{ transform: `rotate(${angle}deg)` }}
        >
          <div
            className="absolute w-[2.5px] h-[2.5px] rounded-full bg-primary-50/50 dark:bg-primary-40/40 animate-[decrypt-burst_2.5s_ease-out_infinite]"
            style={{
              animationDelay: `${i * 0.1}s`,
              left: "-1.25px",
            }}
          />
        </div>
      ))}
    </div>

    {/* ─── Scramble text ─── */}
    {showScramble && <ScrambleGrid />}
  </div>
);

export default DecryptingAnimation;
