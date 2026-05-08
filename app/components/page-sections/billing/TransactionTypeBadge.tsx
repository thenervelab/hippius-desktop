import { cva, type VariantProps } from "class-variance-authority";
import { TaoLogo } from "@/components/ui/icons";
import { CreditCard } from "lucide-react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "flex px-[6px] py-0 justify-center items-center gap-[4px] rounded-[90px] w-fit font-medium text-[10px] leading-[16px] tracking-[-0.2px]",
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
      <Icon className="size-2.5 shrink-0" />
      <span>{label}</span>
    </div>
  );
};

export default TransactionTypeBadge;
