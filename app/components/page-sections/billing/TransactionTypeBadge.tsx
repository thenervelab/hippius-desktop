import { cva, type VariantProps } from "class-variance-authority";
import { TaoLogo } from "@/components/ui/icons";
import { CreditCard } from "lucide-react";
import { cn } from "@/lib/utils";

const badgeVatiants = cva(
    "py-1 px-2 flex gap-x-1 text-grey-10 font-semibold tracking-tighter rounded items-center w-fit",
    {
        variants: {
            type: {
                card: "bg-warning-90",
                tao: "bg-primary-90",
            },
        },
    }
);

interface Props extends VariantProps<typeof badgeVatiants> {
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
        <div className={cn(badgeVatiants({ type }), className)}>
            <Icon className="size-3" />
            <span className="text-xs">{label}</span>
        </div>
    );
};

export default TransactionTypeBadge;
