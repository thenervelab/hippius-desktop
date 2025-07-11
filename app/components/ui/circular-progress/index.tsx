import AbstractIconWrapper from "../abstract-icon-wrapper";
import { cn } from "@/lib/utils";
import { ReactNode } from "react";

const CircularProgress: React.FC<{
    angle: number;
    className?: string;
    children?: ReactNode;
}> = ({ angle, className, children }) => (
    <div
        style={{
            backgroundImage: `conic-gradient(#3167DD 0deg, #3167DD ${angle}deg, white ${angle}deg, white 360deg)`,
        }}
        className={cn("duration-200 p-1 rounded-full relative", className)}
    >
        <div className="h-full w-full rounded-full overflow-hidden bg-primary-100 p-1">
            <AbstractIconWrapper
                className="h-full w-full rounded-full p-0"
            >
                {children}
            </AbstractIconWrapper>
        </div>
    </div>
);

export default CircularProgress;
