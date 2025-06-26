import React, { useRef, useLayoutEffect, useState } from "react";

const SVG_SIZE = 1000;
const MIDDLE_RING_RADIUS = 400;
const MIDDLE_RING_DIAMETER = MIDDLE_RING_RADIUS * 2;
const INNER_RING_RADIUS = 180;
const INNER_RING_DIAMETER = INNER_RING_RADIUS * 2;

export default function AnimatedRings() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [blurDiameter, setBlurDiameter] = useState(0);
  const [innerBlurDiameter, setInnerBlurDiameter] = useState(0);

  useLayoutEffect(() => {
    function updateSize() {
      if (containerRef.current) {
        const { width, height } = containerRef.current.getBoundingClientRect();
        const scale = Math.min(width, height) / SVG_SIZE;
        setBlurDiameter(MIDDLE_RING_DIAMETER * scale + 250);
        setInnerBlurDiameter(INNER_RING_DIAMETER * scale - 30);
      }
    }
    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 flex items-center justify-center pointer-events-none z-6"
    >
      {/* Blur circles */}
      <div
        className="absolute rounded-full bg-[#0B1A48] "
        style={{
          width: `${blurDiameter}px`,
          height: `${blurDiameter}px`,
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
          opacity: 0.9,
          filter: "blur(144px)",
          pointerEvents: "none",
          zIndex: 10,
        }}
      />
      <div
        className="absolute rounded-full"
        style={{
          width: `${innerBlurDiameter}px`,
          height: `${innerBlurDiameter}px`,
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
          background: "#274996",
          filter: "blur(80px)",
          pointerEvents: "none",
          zIndex: 11,
        }}
      />

      {/* --- Animated SVG Rings --- */}
      <svg
        className="w-full h-full"
        viewBox="0 0 1000 1000"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          zIndex: 20,
        }}
      >
        <defs>
          <linearGradient id="fadeVertical" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(82,132,242,0)" />
            <stop offset="30%" stopColor="rgba(82,132,242,0.15)" />
            <stop offset="50%" stopColor="rgba(82,132,242,0.25)" />
            <stop offset="70%" stopColor="rgba(82,132,242,0.15)" />
            <stop offset="100%" stopColor="rgba(82,132,242,0)" />
          </linearGradient>
          <linearGradient id="fadeVerticalInner" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(39,73,150,0)" />
            <stop offset="30%" stopColor="rgba(39,73,150,0.2)" />
            <stop offset="50%" stopColor="rgba(39,73,150,1)" />
            <stop offset="70%" stopColor="rgba(39,73,150,0.2)" />
            <stop offset="100%" stopColor="rgba(39,73,150,0)" />
          </linearGradient>
        </defs>

        {/* OUTER ring */}
        <g className="animate-spin-fast origin-center">
          <circle
            cx={500}
            cy={500}
            r={500}
            fill="none"
            stroke="url(#fadeVertical)"
            strokeWidth={6}
          />
        </g>

        {/* MIDDLE ring, rotated initial angle */}
        <g style={{ transform: "rotate(70deg)" }} className="origin-center">
          <g className="animate-spin-reverse-fast origin-center">
            <circle
              cx={500}
              cy={500}
              r={MIDDLE_RING_RADIUS}
              fill="none"
              stroke="url(#fadeVertical)"
              strokeWidth={6}
            />
          </g>
        </g>

        {/* INNER ring, rotated initial angle */}
        <g style={{ transform: "rotate(-33deg)" }} className="origin-center">
          <g className="animate-spin-fast origin-center">
            <circle
              cx={500}
              cy={500}
              r={INNER_RING_RADIUS}
              fill="none"
              stroke="url(#fadeVerticalInner)"
              strokeWidth={4}
            />
          </g>
        </g>
      </svg>
    </div>
  );
}
