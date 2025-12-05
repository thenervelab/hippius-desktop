import { useAtomValue } from "jotai";
import { progressAtom } from "./atoms";
import { useEffect, useState, useRef } from "react";

const ProgressDisplay: React.FC = () => {
  const progress = useAtomValue(progressAtom);
  const [displayProgress, setDisplayProgress] = useState(0);
  const animationRef = useRef<number | null>(null);
  const startValueRef = useRef(0);
  const startTimeRef = useRef<number | null>(null);

  useEffect(() => {
    // Animate from current display value to target progress
    const targetProgress = progress;
    const startValue = displayProgress;
    const duration = 800; // Animation duration in ms

    // Cancel any existing animation
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
    }

    startValueRef.current = startValue;
    startTimeRef.current = null;

    const animate = (timestamp: number) => {
      if (startTimeRef.current === null) {
        startTimeRef.current = timestamp;
      }

      const elapsed = timestamp - startTimeRef.current;
      const progressRatio = Math.min(elapsed / duration, 1);

      // Ease-out cubic for smooth deceleration
      const easeOut = 1 - Math.pow(1 - progressRatio, 3);

      const currentValue =
        startValueRef.current +
        (targetProgress - startValueRef.current) * easeOut;
      setDisplayProgress(currentValue);

      if (progressRatio < 1) {
        animationRef.current = requestAnimationFrame(animate);
      }
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [progress]);

  const roundedProgress = Math.round(displayProgress);

  return (
    <span className="font-digital font-normal text-[#3167DD] text-[34px] leading-[40px] overflow-hidden tabular-nums">
      {roundedProgress}%
    </span>
  );
};

export default ProgressDisplay;
