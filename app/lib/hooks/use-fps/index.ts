import { useCallback, useEffect, useRef, useState } from "react";

type Options = {
  duration: number;
  trimPercent: number;
};

const DEFAULT_OPTIONS: Options = {
  duration: 1000,
  trimPercent: 20,
};

const useFPS = (options?: Partial<Options>) => {
  const { duration, trimPercent } = { ...DEFAULT_OPTIONS, ...options };

  const [avgFPS, setAvgFPS] = useState(0);
  const frameTimesRef = useRef<number[]>([]);
  const rafIdRef = useRef<number | null>(null);
  const timeoutIdRef = useRef<NodeJS.Timeout | null>(null);
  const isMeasuringRef = useRef(true);

  const measureFrames = useCallback(() => {
    if (!isMeasuringRef.current) return;

    const now = performance.now();
    frameTimesRef.current.push(now);

    rafIdRef.current = requestAnimationFrame(measureFrames);
  }, []);

  useEffect(() => {
    const startMeasurement = () => {
      frameTimesRef.current = [];
      isMeasuringRef.current = true;

      measureFrames();

      timeoutIdRef.current = setTimeout(() => {
        isMeasuringRef.current = false;

        const frameTimes = frameTimesRef.current;
        if (frameTimes.length <= 1) {
          setAvgFPS(0);
          return;
        }

        const frameDeltas: number[] = [];
        for (let i = 1; i < frameTimes.length; i++) {
          frameDeltas.push(frameTimes[i] - frameTimes[i - 1]);
        }

        const sortedDeltas = [...frameDeltas].sort((a, b) => a - b);

        const trimCount = Math.floor(sortedDeltas.length * (trimPercent / 100));
        const trimmedDeltas = sortedDeltas.slice(
          trimCount,
          sortedDeltas.length - trimCount
        );

        const avgFrameTime =
          trimmedDeltas.reduce((sum, delta) => sum + delta, 0) /
          trimmedDeltas.length;

        const calculatedFPS = 1000 / avgFrameTime;

        setAvgFPS(Math.round(calculatedFPS));
      }, duration);
    };

    startMeasurement();

    return () => {
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
      if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current);
    };
  }, [duration, measureFrames, trimPercent]);

  return avgFPS;
};

export default useFPS;
