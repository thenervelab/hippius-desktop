import { cn } from "@/lib/utils";
import Refresh from "../icons/Refresh";
import { Loader } from "lucide-react";

const RefreshButton: React.FC<{
    onClick: () => void;
    refetching?: boolean;
}> = ({ onClick, refetching }) => (
    <button
        onClick={onClick}
        disabled={refetching}
        className={cn(
            "flex items-center cursor-pointer relative group justify-center min-w-8 size-8 border rounded duration-300 border-grey-80",
            refetching && "opacity-30"
        )}
    >
        <Refresh
            className={cn(
                "size-4 text-grey-10 group-hover:-rotate-90 absolute duration-300",
                refetching && "scale-0 opacity-0"
            )}
        />

        <div
            className={cn(
                "text-grey-10 opacity-0 scale-0 absolute duration-300",
                refetching && "scale-100 opacity-100 animate-spin"
            )}
        >
            <Loader className="animate-spin size-4" />
        </div>
    </button>
);

export default RefreshButton;
