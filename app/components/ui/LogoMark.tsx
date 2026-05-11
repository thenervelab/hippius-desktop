import { HippiusLogo } from "@/components/ui/icons";
import { cn } from "@/app/lib/utils";

export function LogoMark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative size-[min(3.5rem,56px)] overflow-hidden bg-grey-light-100 dark:bg-black-500",
        className,
      )}
    >
      <div
        className="absolute inset-0 opacity-70"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(31,80,189,0.35) 1px, transparent 1px), linear-gradient(to bottom, rgba(31,80,189,0.35) 1px, transparent 1px)",
          backgroundSize: "16px 16px",
        }}
      />
      <div
        className="absolute inset-0 dark:hidden"
        style={{
          background:
            "radial-gradient(50% 70% at 50% 50%, rgba(255,255,255,0) 0%, #ffffff 100%)",
        }}
      />
      <div
        className="absolute inset-0 hidden dark:block"
        style={{
          background:
            "radial-gradient(50% 70% at 50% 50%, rgba(22,22,22,0) 0%, #161616 100%)",
        }}
      />
      <HippiusLogo className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 size-[min(2rem,32px)] rounded" />
    </div>
  );
}
