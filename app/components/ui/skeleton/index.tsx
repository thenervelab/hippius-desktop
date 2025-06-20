import { cn } from "@/app/lib/utils";

type SkeletonProps = {
  /**
   * The shape of the skeleton
   * @default "rectangle"
   */
  variant?: "rectangle" | "circle" | "text";
  /**
   * Width of the skeleton
   * @default "100%"
   */
  width?: string | number;
  /**
   * Height of the skeleton
   * @default "1rem"
   */
  height?: string | number;
  /**
   * Whether to show an animation
   * @default true
   */
  animated?: boolean;
  /**
   * Additional CSS classes
   */
  className?: string;
  /**
   * For text skeletons, the number of lines
   * @default 1
   */
  lines?: number;
};

const Skeleton: React.FC<SkeletonProps> = ({
  variant = "rectangle",
  width = "100%",
  height = "1rem",
  animated = true,
  className,
  lines = 1,
}) => {
  const skeletonStyles = cn(
    "bg-grey-90 dark:bg-grey-70 rounded",
    animated && "animate-pulse",
    variant === "circle" && "rounded-full",
    variant === "text" && "rounded-md",
    className
  );

  // Set default styling based on variant
  const variantStyles = {
    width: width,
    height: variant === "text" ? "1rem" : height,
  };

  // For multi-line text skeletons
  if (variant === "text" && lines > 1) {
    return (
      <div className="flex flex-col gap-2">
        {Array(lines)
          .fill(0)
          .map((_, i) => (
            <div
              key={i}
              className={skeletonStyles}
              style={{
                ...variantStyles,
                width:
                  i === lines - 1 && typeof width === "string" ? "70%" : width,
              }}
            />
          ))}
      </div>
    );
  }

  return <div className={skeletonStyles} style={variantStyles} />;
};

export default Skeleton;
