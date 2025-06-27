import { cn } from "@/lib/utils";
import { TaoLogo } from "@/components/ui/icons";
import { CreditCard } from "lucide-react";

type TransactionType = "card" | "tao";

interface Props {
  type?: TransactionType;
  className?: string;
}

const getBadgeClasses = (type?: TransactionType) => {
  const baseClasses =
    "py-1 px-2 flex gap-x-1 text-grey-10 font-semibold tracking-tighter rounded items-center w-fit";

  switch (type) {
    case "card":
      return cn(baseClasses, "bg-warning-90");
    case "tao":
      return cn(baseClasses, "bg-primary-90");
    default:
      return cn(baseClasses, "bg-warning-90");
  }
};

export const getData = (type?: TransactionType) => {
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
    <div className={cn(getBadgeClasses(type), className)}>
      <Icon className="size-3" />
      <span className="text-xs">{label}</span>
    </div>
  );
};

export default TransactionTypeBadge;
