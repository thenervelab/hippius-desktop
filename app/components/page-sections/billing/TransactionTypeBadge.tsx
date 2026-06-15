import { cva, type VariantProps } from "class-variance-authority";
import { TaoLogo } from "@/components/ui/icons";
import { CreditCard } from "lucide-react";
import { cn } from "@/lib/utils";

// Em-based pill geometry — same rationale as StatusTypeBadge: WKWebView's
// pageZoom clamps small fonts (~9px floor) on zoom-out, so px geometry
// shrinks away from the text; em tracks the clamped size. Values are
// pixel-identical to the old px ones at 100% zoom.
const badgeVariants = cva(
  "flex px-[0.6em] py-0 justify-center items-center gap-[0.4em] rounded-[90px] w-fit font-medium text-[10px] leading-[1.6] tracking-[-0.02em]",
  {
    variants: {
      type: {
        card: "bg-[rgba(232,151,2,0.30)] text-[#0A0A0A] dark:text-[#FEB101]",
        tao:  "bg-[rgba(223,229,247,0.30)] text-[#0A0A0A] dark:text-[#DFE5F7]",
      },
    },
  },
);

interface Props extends VariantProps<typeof badgeVariants> {
  className?: string;
}

export const getData = (type: Props["type"]) => {
  switch (type) {
    case "card":
      return { Icon: CreditCard, label: "Credit Card" };
    case "tao":
      return { Icon: TaoLogo, label: "TAO" };
    default:
      return { Icon: CreditCard, label: "Credit" };
  }
};

const TransactionTypeBadge: React.FC<Props> = ({ type, className }) => {
  const { Icon, label } = getData(type);
  return (
    <div className={cn(badgeVariants({ type }), className)}>
      {/* 1em = 10px at 100% (was size-2.5); em keeps the icon in step with
          the zoom-clamped text, like the pill geometry above. */}
      <Icon className="size-[1em] shrink-0" />
      <span>{label}</span>
    </div>
  );
};

export default TransactionTypeBadge;
