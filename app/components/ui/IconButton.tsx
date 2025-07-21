import React from "react";
import { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils"; // Add this import

interface IconButtonProps {
  icon?: LucideIcon;
  text: string;
  onClick: () => void;
  innerPadding?: string;
  outerPadding?: string;
  className?: string;
  fontSizeClass?: string;
  innerClassName?: string;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
}

const IconButton: React.FC<IconButtonProps> = ({
  icon: Icon,
  text,
  onClick,
  innerPadding = "px-1 sm:px-2 py-1",
  outerPadding = "p-1",
  className = "",
  fontSizeClass = "text-base",
  innerClassName = "",
  disabled = false,
  type = "button",
}) => {
  return (
    <button
      type={type}
      onClick={onClick}
      className={cn(
        outerPadding,
        "bg-primary-50 text-white border border-primary-40 rounded hover:bg-primary-40 transition text-base font-medium disabled:opacity-50  disabled:cursor-not-allowed",
        fontSizeClass,
        className
      )}
      disabled={disabled}
    >
      <div
        className={cn(
          "flex items-center gap-2 border rounded border-primary-40",
          innerPadding,
          innerClassName
        )}
      >
        {Icon && <Icon className="size-4" />}
        <span>{text}</span>
      </div>
    </button>
  );
};

export default IconButton;
