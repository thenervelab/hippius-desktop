import { cn } from "@/lib/utils";

/**
 * A keyboard shortcut drawn as keycaps, one per key, the way macOS menus and
 * Settings show them. The symbols (⇧ ⌘ ⌥ ⌃) use the system font: in Geist they
 * render small and thin, which is how ⇧⌘2 became unreadable in the menu.
 */
export default function ShortcutKeys({
  keys,
  size = "sm",
  className,
}: {
  keys: string[];
  /** `lg` is the Settings tile's: the shortcut is what that tile is about. */
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  if (keys.length === 0) return null;
  return (
    <kbd aria-label={`Shortcut ${keys.join(" ")}`} className={cn("inline-flex items-center gap-1 font-sans", className)}>
      {keys.map((key, i) => (
        <span
          key={`${key}-${i}`}
          aria-hidden
          className={cn(
            "inline-grid place-items-center rounded-[5px] border font-semibold leading-none",
            "font-[system-ui,-apple-system,'Segoe_UI',sans-serif]",
            "border-grey-dark-100 bg-grey-light-200 text-grey-10 shadow-[0_1px_0_rgba(0,0,0,0.08)]",
            "dark:border-black-300 dark:bg-black-300 dark:text-white dark:shadow-[0_1px_0_rgba(0,0,0,0.5)]",
            size === "sm"
              ? "h-[22px] min-w-[22px] px-1.5 text-[13px]"
              : size === "md"
                ? "h-7 min-w-7 px-2 text-[14px]"
                : "h-10 min-w-10 rounded-[8px] border-b-2 px-2.5 text-[18px]",
          )}
        >
          {key}
        </span>
      ))}
    </kbd>
  );
}
