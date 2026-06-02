"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { progressAtom, phaseAtom, isUpdateCheckPhaseAtom } from "./atoms";
import {
  PHASE_CONTENT,
  UPDATE_CHECK_CONTENT,
  AppSetupPhaseContent,
} from "./SplashContent";

const TOTAL_CELLS = 40;
const BRACKET_SIZE = 15;
const BRACKET_THICKNESS = 1.5;
const BRACKET_COLOR = "rgba(255,255,255,0.65)";

/**
 * The loader card from the new splash mockup, wired to the real setup logic.
 *
 * The mockup drove itself with a fake 5s RAF ramp and a hardcoded list of
 * cycling messages. Here the percentage + segmented bar read the shared
 * `progressAtom` (real weighted phase progress), and the scramble headline +
 * caption read the active phase's `status` / `subStatus`. Completion is owned
 * by the wrapper (`index.tsx`) via the phase loop, so there is no `onComplete`.
 */
export default function LoadingScreen() {
  const progress = useAtomValue(progressAtom);
  const phase = useAtomValue(phaseAtom);
  const isUpdateCheckPhase = useAtomValue(isUpdateCheckPhaseAtom);

  // Resolve the active phase's copy. During the pre-main update-check beat we
  // show UPDATE_CHECK_CONTENT; otherwise the current PHASE_CONTENT entry, with
  // the update-check copy as a safe fallback before the first phase is set.
  const content: AppSetupPhaseContent =
    isUpdateCheckPhase || !phase
      ? UPDATE_CHECK_CONTENT
      : PHASE_CONTENT[phase] ?? UPDATE_CHECK_CONTENT;

  const status = content.status;
  const subStatus = content.subStatus;

  // Render status + substatus as ONE two-line title block (identical styling,
  // both scramble together) — mirrors the original mockup's single multi-line
  // message. Trailing dots are stripped from the substatus so the appended
  // animated dots don't double up.
  const titleText = `${status}\n${subStatus.replace(/[.\s]+$/, "")}`;

  const filledCells = Math.round((progress / 100) * TOTAL_CELLS);

  const bracket = (pos: React.CSSProperties): React.CSSProperties => ({
    position: "absolute",
    width: BRACKET_SIZE,
    height: BRACKET_SIZE,
    pointerEvents: "none",
    ...pos,
  });

  return (
    <div
      style={{
        width: 580,
        height: 650,
        backgroundColor: "#3167DD",
        position: "relative",
        fontFamily: "var(--font-geist-mono)",
        fontSize: 14,
        textTransform: "uppercase",
        color: "white",
        flexShrink: 0,
      }}
    >
      {/* Corner brackets */}
      <div
        style={bracket({
          top: 30,
          left: 30,
          borderTop: `${BRACKET_THICKNESS}px solid ${BRACKET_COLOR}`,
          borderLeft: `${BRACKET_THICKNESS}px solid ${BRACKET_COLOR}`,
        })}
      />
      <div
        style={bracket({
          top: 30,
          right: 30,
          borderTop: `${BRACKET_THICKNESS}px solid ${BRACKET_COLOR}`,
          borderRight: `${BRACKET_THICKNESS}px solid ${BRACKET_COLOR}`,
        })}
      />
      <div
        style={bracket({
          bottom: 30,
          left: 30,
          borderBottom: `${BRACKET_THICKNESS}px solid ${BRACKET_COLOR}`,
          borderLeft: `${BRACKET_THICKNESS}px solid ${BRACKET_COLOR}`,
        })}
      />
      <div
        style={bracket({
          bottom: 30,
          right: 30,
          borderBottom: `${BRACKET_THICKNESS}px solid ${BRACKET_COLOR}`,
          borderRight: `${BRACKET_THICKNESS}px solid ${BRACKET_COLOR}`,
        })}
      />

      {/* Inner content */}
      <div
        style={{
          position: "absolute",
          inset: 60,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 0,
        }}
      >
        {/* Top text block: status + substatus as one two-line title (identical
            styling, scrambling together) with the animated dots at the end and
            the percentage aligned to the top-right. The title takes all width
            except the percentage (flex:1 + minWidth:0) so a long substatus and
            its trailing dots stay on the second line instead of overflowing to
            a third. */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 16,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <StatusScrambleText text={titleText} />
          </div>
          <div style={{ flexShrink: 0 }}>{Math.round(progress)}%</div>
        </div>

        {/* Animated hippo, centered. Rendered as an <img> (a GIF), NOT a
            <video>: WebKitGTK (Tauri's Linux/macOS webview) composites <video>
            on its own GPU layer that the parent's mix-blend-mode can't reach,
            which leaves the video's black background as an opaque square. An
            <img> paints on the normal layer, so `mix-blend-mode: screen` drops
            the black out against the blue card exactly like the mockup. */}
        <div style={{ display: "flex", justifyContent: "center" }}>
          <img
            src="/hippo.gif"
            alt=""
            aria-hidden="true"
            style={{
              width: 450,
              height: 450,
              flexShrink: 0,
              objectFit: "contain",
              display: "block",
              mixBlendMode: "screen",
            }}
          />
        </div>

        {/* Segmented loading bar */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${TOTAL_CELLS}, 1fr)`,
            gap: 6,
            height: 8,
          }}
        >
          {Array.from({ length: TOTAL_CELLS }).map((_, i) => (
            <div
              key={i}
              style={{
                backgroundColor:
                  i < filledCells ? "white" : "rgba(255,255,255,0.25)",
                height: "100%",
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#@%&";

/**
 * Renders `text`, replaying the mockup's per-character scramble each time the
 * text changes (i.e. on every phase transition) so phase swaps still read as
 * the original "decoding" animation instead of a hard cut. Non-alphanumeric
 * characters (spaces, punctuation, emoji, and the newline that splits the
 * status/substatus into the two-line title) are preserved untouched, so both
 * lines stay split and aligned throughout the scramble.
 */
function StatusScrambleText({ text }: { text: string }) {
  const [display, setDisplay] = useState(text);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const scrambleTo = useCallback((target: string) => {
    if (tickRef.current) clearInterval(tickRef.current);
    let step = 0;
    const total = 14;
    tickRef.current = setInterval(() => {
      step++;
      const scrambled = target
        .split("")
        .map((char) => {
          if (!/[a-zA-Z0-9]/.test(char)) return char;
          if (step > total / 2 && Math.random() < step / total) return char;
          return SCRAMBLE_CHARS[
            Math.floor(Math.random() * SCRAMBLE_CHARS.length)
          ];
        })
        .join("");
      setDisplay(scrambled);
      if (step >= total) {
        setDisplay(target);
        if (tickRef.current) {
          clearInterval(tickRef.current);
          tickRef.current = null;
        }
      }
    }, 40);
  }, []);

  useEffect(() => {
    scrambleTo(text);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [text, scrambleTo]);

  return (
    <div style={{ lineHeight: 1.4, whiteSpace: "pre-line" }}>
      {display}
      <AnimatedDots />
    </div>
  );
}

function AnimatedDots() {
  return (
    <>
      <style>{`
        @keyframes dotFade {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.15; }
        }
      `}</style>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            display: "inline-block",
            animation: `dotFade 1.2s ease-in-out ${i * 0.25}s infinite`,
          }}
        >
          .
        </span>
      ))}
    </>
  );
}
