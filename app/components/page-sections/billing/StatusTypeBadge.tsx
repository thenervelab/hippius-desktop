import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVatiants = cva(
  "py-1 px-2 flex gap-x-1 text-grey-10 font-semibold tracking-tighter rounded items-center w-fit",
  {
    variants: {
      type: {
        failed: "bg-error-50 text-grey-90",
        error: "bg-error-50 text-grey-90",
        declined: "bg-error-50 text-grey-90",
        cancelled: "bg-error-50 text-grey-90",
        canceled: "bg-error-50 text-grey-90",
        expired: "bg-error-50 text-grey-90",
        success: "bg-success-90",
        successful: "bg-success-90",
        completed: "bg-success-90",
        paid: "bg-success-90",
        confirmed: "bg-success-90",
        pending: "bg-primary-90",
        processing: "bg-primary-90",
        in_progress: "bg-primary-90",
        refunded: "bg-grey-70 text-grey-10",
        reversed: "bg-grey-70 text-grey-10",
      },
    },
  },
);

interface Props extends VariantProps<typeof badgeVatiants> {
  className?: string;
  fallback?: string;
}

const StatusTypeBadge: React.FC<Props> = ({ type, className, fallback }) => {
  const label = type
    ? type.charAt(0).toUpperCase() + type.slice(1).toLowerCase()
    : fallback || "";

  if (!label) return null;

  return (
    <div
      className={cn(
        badgeVatiants({ type }),
        !type && "bg-grey-70 text-grey-10",
        className,
      )}
    >
      <span className="text-xs">{label}</span>
    </div>
  );
};

export default StatusTypeBadge;
