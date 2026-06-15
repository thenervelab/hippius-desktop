import * as Tooltip from "@radix-ui/react-tooltip";
import { Icons } from "@/components/ui";

type PrivacyBadgeVariant = "file" | "folder";

const TOOLTIP_TEXT: Record<PrivacyBadgeVariant, string> = {
    file: "Files uploaded here will be added to your sync folder and encrypted for security.",
    folder: "This folder will be added to your private sync folder and encrypted for security.",
};

interface PrivacyBadgeProps {
    variant: PrivacyBadgeVariant;
}

export default function PrivacyBadge({ variant }: PrivacyBadgeProps) {
    return (
        <Tooltip.Provider delayDuration={200}>
            <Tooltip.Root>
                <Tooltip.Trigger asChild>
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary-95 border border-primary-80 cursor-default shrink-0 dark:bg-primary-50/10 dark:border-primary-50/40">
                        <Icons.ShieldSecurity className="size-3.5 text-primary-50 dark:text-primary-65" />
                        <span className="text-[0.6875rem] leading-none font-medium text-primary-50 dark:text-primary-65">
                            Private
                        </span>
                    </span>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                    <Tooltip.Content
                        side="bottom"
                        align="center"
                        sideOffset={6}
                        className="z-[9999] max-w-[15rem] bg-white border border-grey-80 rounded-lg px-3 py-2 text-xs text-grey-40 shadow-lg animate-in fade-in-0 zoom-in-95 dark:bg-[#1f1f1f] dark:border-[#494949] dark:text-[#a3a3a3]"
                    >
                        {TOOLTIP_TEXT[variant]}
                        <Tooltip.Arrow
                            className="fill-white dark:fill-[#1f1f1f]"
                            width={12}
                            height={6}
                        />
                    </Tooltip.Content>
                </Tooltip.Portal>
            </Tooltip.Root>
        </Tooltip.Provider>
    );
}
