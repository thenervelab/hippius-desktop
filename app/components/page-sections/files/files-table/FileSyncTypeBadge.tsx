import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVatiants = cva(
    "py-1 px-2 flex gap-x-1 text-grey-10 font-semibold tracking-tighter rounded items-center w-fit",
    {
        variants: {
            type: {
                public: "bg-warning-90",
                private: "bg-primary-90",
            },
        },
    }
);

interface Props extends VariantProps<typeof badgeVatiants> {
    className?: string;
}
const FileSyncTypeBadge: React.FC<Props> = ({ type, className }) => {
    return (
        <div className={cn(badgeVatiants({ type }), className)}>
            <span className="text-xs">{type ? type.charAt(0).toUpperCase() + type.slice(1) : ''}</span>
        </div>
    );
};

export default FileSyncTypeBadge;
