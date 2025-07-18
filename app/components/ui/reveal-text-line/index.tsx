import { cn } from "@/app/lib/utils";
import { ReactNode } from "react";

const RevealTextLine: React.FC<{
  children: ReactNode;
  reveal: boolean;
  className?: string;
  parentClassName?: string;
  rotate?: boolean;
  delay?: number;
  onClick?: () => void;
}> = ({
  children,
  reveal,
  rotate,
  className,
  delay,
  parentClassName,
  onClick,
}) => {
    return (
      <span
        className={cn("overflow-y-hidden inline-flex", parentClassName)}
        onClick={onClick}
      >
        <span
          style={{ transitionDelay: delay ? `${delay}ms` : undefined }}
          className={cn(
            cn(
              "translate-y-full inline-flex opacity-0 duration-500",
              rotate && "rotate-6 origin-top-left"
            ),
            reveal && cn("translate-y-0 opacity-100", rotate && "rotate-0 "),
            className
          )}
        >
          {children}
        </span>
      </span>
    );
  };

export default RevealTextLine;
