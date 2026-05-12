import { cn } from "@/lib/utils";

interface SettingsToggleProps {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
}

/**
 * Horizontal mini-toggle (Figma spec).
 *
 * 22px wide × ~17px tall (auto from padding + pill height).
 * Pill slides left ↔ right via alignItems on a column flex container:
 *   flex-start = pill left (off), flex-end = pill right (on).
 * Off state uses opacity-30; colors flip black↔white between light and dark mode.
 */
export function SettingsToggle({
  checked,
  onCheckedChange,
  disabled,
}: SettingsToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => !disabled && onCheckedChange(!checked)}
      disabled={disabled}
      className={cn(
        "flex-shrink-0 outline-none border-[1.2px] transition-all duration-150",
        checked
          ? "border-[#1F51BE]"
          : "border-grey-60 dark:border-white dark:opacity-30",
        disabled ? "cursor-not-allowed" : "cursor-pointer"
      )}
      style={{
        display: "flex",
        width: 22,
        padding: 2,
        flexDirection: "column",
        alignItems: checked ? "flex-end" : "flex-start",
        borderRadius: 4,
        background: "transparent",
        boxSizing: "border-box",
      }}
    >
      <div
        className={cn(
          "transition-colors",
          checked ? "bg-[#1F51BE]" : "bg-grey-60 dark:bg-white"
        )}
        style={{
          width: 8.571,
          height: 12.857,
          borderRadius: 2,
          flexShrink: 0,
        }}
      />
    </button>
  );
}
