import { cn } from "@/app/lib/utils";
import { ReactNode } from "react";

const Card: React.FC<{
  title: ReactNode;
  titleClassName?: string;
  className?: string;
  children: ReactNode;
  contentClassName?: string;
}> = ({ title, titleClassName, contentClassName, className, children }) => (
  <div
    className={cn(
      "border border-grey-80 flex flex-col rounded-lg overflow-hidden",
      className
    )}
  >
    <div
      className={cn(
        "flex gap-x-2 font-medium px-2 py-2.5  text-base lg:text-xl",
        titleClassName
      )}
    >
      {title}
    </div>
    <div className={cn("grow w-full", contentClassName)}>{children}</div>
  </div>
);

export default Card;
