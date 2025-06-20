import { cn } from "@/lib/utils";
import { ReactNode } from "react";

interface Props {
  children: ReactNode;
  wrapperClassName?: string;
  innerClassName?: string;
}

export const TruncatedCell: React.FC<Props> = ({
  children,
  wrapperClassName,
  innerClassName,
}) => (
  <div className={cn("flex relative", wrapperClassName)}>
    <div className={cn("grow text-grey-20 truncate", innerClassName)}>
      {children}
    </div>
  </div>
);

export default TruncatedCell;
