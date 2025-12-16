import React from "react";
import { InView } from "react-intersection-observer";
import { cn } from "@/lib/utils";
import RevealTextLine from "./reveal-text-line";

interface ComingSoonProps {
    variant?: "subtle" | "warning" | "danger" | "white" | "primary";
    overlay?: boolean;
    blurIntensity?: "extraLight" | "light" | "medium" | "heavy";
    position?: "top-right" | "center" | "top-center";
    size?: "small" | "medium" | "large";
}

const ComingSoon: React.FC<ComingSoonProps> = ({
    variant = "subtle",
    overlay = false,
    blurIntensity = "medium",
    position = "top-right",
    size = "small",
}) => {
    const variantStyles = {
        subtle:
            "bg-grey-80/85 backdrop-blur-md text-grey-30 border-grey-70/40 shadow-sm",
        warning:
            "bg-yellow-500/15 backdrop-blur-md text-yellow-600 border-yellow-400/40 shadow-sm",
        danger:
            "bg-red-500/10 backdrop-blur-md text-red-500 border-red-400/60 shadow-md",
        white:
            "bg-white/95 backdrop-blur-md text-grey-40 border-grey-80/30 shadow-lg",
        primary:
            "bg-primary-50/90 backdrop-blur-md text-white border-primary-30/50 shadow-lg",
    };

    const blurStyles = {
        extraLight: "backdrop-blur-[4px]",
        light: "backdrop-blur-sm",
        medium: "backdrop-blur-md",
        heavy: "backdrop-blur-lg",
    };

    const positionStyles = {
        "top-right": "absolute top-3 right-3 z-20",
        center:
            "absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-30",
        "top-center": "absolute top-3 left-1/2 transform -translate-x-1/2 z-20",
    };

    const sizeStyles = {
        small: "px-3 py-1.5 text-[10px]",
        medium: "px-4 py-2 text-xs",
        large: "px-6 py-3 text-sm",
    };

    if (overlay) {
        return (
            <InView triggerOnce threshold={0.3}>
                {({ inView, ref }) => (
                    <>
                        {/* Blur overlay */}
                        <div
                            className={cn(
                                "absolute inset-0 z-10 transition-all duration-500",
                                blurStyles[blurIntensity],
                                inView ? "opacity-100" : "opacity-0"
                            )}
                        />

                        {/* Coming Soon Badge */}
                        <div
                            ref={ref}
                            className={cn(
                                "rounded-lg font-medium border uppercase tracking-wider transition-all duration-200 hover:scale-105",
                                variantStyles[variant],
                                positionStyles[position],
                                sizeStyles[size]
                            )}
                        >
                            <RevealTextLine reveal={inView} className="overflow-hidden">
                                coming soon
                            </RevealTextLine>
                        </div>
                    </>
                )}
            </InView>
        );
    }

    return (
        <InView triggerOnce threshold={0.3}>
            {({ inView, ref }) => (
                <div
                    ref={ref}
                    className={cn(
                        "rounded-lg font-medium border uppercase tracking-wider transition-all duration-200 hover:scale-105",
                        variantStyles[variant],
                        positionStyles[position],
                        sizeStyles[size]
                    )}
                >
                    <RevealTextLine reveal={inView} className="overflow-hidden">
                        coming soon
                    </RevealTextLine>
                </div>
            )}
        </InView>
    );
};

export default ComingSoon;
