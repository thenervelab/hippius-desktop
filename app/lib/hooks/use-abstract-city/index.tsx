"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { initialise } from "./functions";
import { AbstractCityData } from "./types";
import { DEFAULT_ABSTRACT_CITY_DATA } from "./constants";
import { useFps } from "@/app/lib/hooks";

const LOOP_DURATION = 16.67; // Loop duration in seconds
const FPS_SAMPLE_SIZE = 60; // Number of frames to sample for FPS calculation

const useAbstractCity = (args?: Partial<AbstractCityData>) => {
  const refreshRate = useFps({ duration: 1000 });
  const [performanceState, setPerformanceState] = useState<
    "performant" | "unperformant" | null
  >(null);
  const perfDetermined = useRef(false);
  const { animate }: AbstractCityData = useMemo(
    () => ({ ...DEFAULT_ABSTRACT_CITY_DATA, ...(args || {}) }),
    [args]
  );

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const observer = useRef<ResizeObserver | null>(null);
  const time = useRef(0);
  const lastTime = useRef(0);
  const [render, setRender] = useState<((t: number) => void) | null>(null);

  // FPS tracking
  const frameTimesRef = useRef<number[]>([]);
  const lastFrameTimeRef = useRef(0);
  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    if (canvasRef.current) {
      initialise(canvasRef.current).then((r) => {
        setRender(() => r);
      });
    }
  }, []);

  useEffect(() => {
    if (render && refreshRate) {
      if (animate) {
        lastTime.current = Date.now();
        lastFrameTimeRef.current = performance.now();

        const draw = () => {
          if (!render) return;

          const now = performance.now();
          const deltaTime = now - lastFrameTimeRef.current;
          lastFrameTimeRef.current = now;

          // Track FPS after initial stabilization
          if (frameTimesRef.current.length > 5) {
            frameTimesRef.current.push(deltaTime);

            if (frameTimesRef.current.length > FPS_SAMPLE_SIZE) {
              frameTimesRef.current.shift();
            }

            if (frameTimesRef.current.length === FPS_SAMPLE_SIZE) {
              const avgDeltaTime =
                frameTimesRef.current.reduce((sum, t) => sum + t, 0) /
                FPS_SAMPLE_SIZE;
              const fps = 1000 / avgDeltaTime;

              if (!perfDetermined.current) {
                if (fps < refreshRate * 0.9) {
                  setPerformanceState("unperformant");
                  render(0); // Render a single frame
                  return; // Stop animation
                } else {
                  setPerformanceState("performant");
                }
                perfDetermined.current = true;
              }
            }
          } else {
            frameTimesRef.current.push(deltaTime);
          }

          render((time.current % LOOP_DURATION) * (1000 / LOOP_DURATION));
          const currentTime = Date.now();
          time.current += (currentTime - lastTime.current) * 0.000004;
          lastTime.current = currentTime;

          animationRef.current = requestAnimationFrame(draw);
        };

        animationRef.current = requestAnimationFrame(draw);
      } else {
        render(0);
        observer.current = new ResizeObserver(() => {
          render(0);
        });
        setPerformanceState(null);
        setLoaded(true);
      }
      return () => {
        if (observer.current) {
          observer.current.disconnect();
        }
        if (animationRef.current !== null) {
          cancelAnimationFrame(animationRef.current);
        }
      };
    }
  }, [animate, render, refreshRate]);

  useEffect(() => {
    if (performanceState && !loaded) {
      setLoaded(true);
    }
  }, [loaded, performanceState]);

  return {
    canvasRef,
    loaded,
    performanceState,
  };
};

export default useAbstractCity;
