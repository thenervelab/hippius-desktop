import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVatiants = cva(
    "py-1 px-2 flex gap-x-1 text-grey-10 font-semibold tracking-tighter rounded items-center w-fit",
    {
        variants: {
            type: {
                failed: "bg-error-50 text-grey-90",
                success: "bg-success-90",
                completed: "bg-success-90",
                pending: "bg-primary-90",
            },
        },
    }
);

interface Props extends VariantProps<typeof badgeVatiants> {
    className?: string;
}

const StatusTypeBadge: React.FC<Props> = ({ type, className }) => {
    return (
        <div className={cn(badgeVatiants({ type }), className)}>
            <span className="text-xs">{type ? type.charAt(0).toUpperCase() + type.slice(1).toLowerCase() : ''}</span>
        </div>
    );
};

export default StatusTypeBadge;
