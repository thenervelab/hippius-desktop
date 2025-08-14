import { cn } from "@/lib/utils";

export interface TrProps extends React.HTMLAttributes<HTMLTableRowElement> {
  rowHover?: boolean;
  transparent?: boolean;
  roundedHeader?: boolean;
}

export const Tr: React.FC<TrProps> = ({
  children,
  className,
  rowHover,
  transparent,
  roundedHeader,
  ...rest
}) => (
  <tr
    className={cn(
      "animate-fade-in-0.3 border-b last:border-b-transparent",
      rowHover && "group/hoverable-row hover:bg-primary-100/20 cursor-pointer",
      transparent && "*:bg-transparent",
      roundedHeader && "group/rounded-header",
      className
    )}
    {...rest}
  >
    {children}
  </tr>
);

export const TrSpacer = () => <tr className="h-2" />;

export const BodyTr: React.FC<TrProps> = (props) => (
  <>
    <Tr {...props} />
    <TrSpacer />
  </>
);
