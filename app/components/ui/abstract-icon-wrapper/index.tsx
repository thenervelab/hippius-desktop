import { cn } from "@/app/lib/utils";
import { IconGrid } from "@/components/ui/icons";

type Props = {
  children: React.ReactNode;
  className?: string;
  backgroundIcon?: React.ComponentType<{ className?: string }>;
  /** Forwarded to `IconGrid` — skips the inner white fill so a dark
   *  surface shows through. Match the console FileDropzone pattern. */
  transparent?: boolean;
  /** Override / extend the grid's stroke color (text-* class). Defaults
   *  to the original `text-[#B4C8F3]` so existing call sites are
   *  visually unchanged. */
  iconGridClassName?: string;
};

const AbstractIconWrapper: React.FC<Props> = ({
  className,
  children,
  backgroundIcon: BackgroundIcon = IconGrid,
  transparent,
  iconGridClassName,
}) => (
  <div
    className={cn(
      "flex items-center relative px-1.5 justify-center",
      className
    )}
  >
    <BackgroundIcon
      // `transparent` is only consumed by IconGrid; other background
      // icons silently drop the unknown prop, so we can pass it
      // unconditionally without breaking custom backgrounds.
      {...({ transparent } as Record<string, unknown>)}
      className={cn(
        "absolute w-full h-full text-[#B4C8F3]",
        iconGridClassName
      )}
    />
    {children}
  </div>
);

export default AbstractIconWrapper;
