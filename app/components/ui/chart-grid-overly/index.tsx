import { cn } from "@/app/lib/utils";

interface GridOverlayProps {
  marginClasses?: string;
  className?: string;
  bgClass?: string;
}

const ChartGridOverlay: React.FC<GridOverlayProps> = ({
  marginClasses = "mt-[3.125rem] ml-[3.75rem] mb-[1.875rem] mr-[1.3125rem]",
  className = "",
  bgClass = "bg-[url('/chart-grid.png')]",
}) => (
  <div
    className={cn(
      "absolute inset-0 pointer-events-none",
      marginClasses,
      className
    )}
  >
    <div className="relative w-full h-full pointer-events-none">
      <div
        className={cn(
          "absolute inset-0 bg-cover z-[-1] pointer-events-none",
          bgClass
        )}
      />
    </div>
  </div>
);

export default ChartGridOverlay;
