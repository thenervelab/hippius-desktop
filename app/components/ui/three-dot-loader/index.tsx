import { cn } from "@/app/lib/utils";
import classes from "./three-dot-loader.module.css";

const LOADING_INDICATOR_ANIMATION_DURATION = 1;

const ThreeDotLoader: React.FC<{
  className?: string;
  dotClassName?: string;
}> = ({ className, dotClassName }) => (
  <div className={cn("flex items-center gap-x-1", className)}>
    {[1, 2, 3].map((value) => (
      <div
        style={{
          animationDelay: `${
            value * (LOADING_INDICATOR_ANIMATION_DURATION / 3)
          }s`,
          animationDuration: `${LOADING_INDICATOR_ANIMATION_DURATION}s`,
        }}
        key={value}
        className={cn(
          "h-2 w-2 rounded-full bg-primary-50",
          classes.loadingIndicatorCircle,
          dotClassName
        )}
      />
    ))}
  </div>
);

export default ThreeDotLoader;
