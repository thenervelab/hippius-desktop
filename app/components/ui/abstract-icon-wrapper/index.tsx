import { cn } from "@/app/lib/utils";
import { IconGrid } from "@/components/ui/icons";

type Props = {
  children: React.ReactNode;
  className?: string;
  backgroundIcon?: React.ComponentType<{ className?: string }>;
};

const AbstractIconWrapper: React.FC<Props> = ({
  className,
  children,
  backgroundIcon: BackgroundIcon = IconGrid,
}) => (
  <div
    className={cn(
      "flex items-center relative px-1.5 justify-center",
      className
    )}
  >
    <BackgroundIcon className="absolute w-full h-full" />
    {children}
  </div>
);

export default AbstractIconWrapper;
