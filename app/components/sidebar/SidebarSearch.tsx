import cn from "@/app/lib/utils/cn";
import { Icons } from "@/components/ui";
import { useEffect, useRef, useState } from "react";
import { useSetAtom } from "jotai";
import { sidebarCollapsedAtom } from "./sideBarAtoms";
import Command from "../ui/icons/Command";

interface SidebarSearchProps {
  collapsed?: boolean;
}

const SidebarSearch: React.FC<SidebarSearchProps> = ({ collapsed = false }) => {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom);
  const focusOnNextExpandRef = useRef(false);
  const hasValue = value.trim().length > 0;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "f") return;
      if (!event.ctrlKey && !event.metaKey) return;

      event.preventDefault();
      if (collapsed) {
        focusOnNextExpandRef.current = true;
        setSidebarCollapsed(false);
        return;
      }
      if (!inputRef.current) return;
      inputRef.current.focus();
      inputRef.current.select();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [collapsed, setSidebarCollapsed]);

  useEffect(() => {
    if (!collapsed && focusOnNextExpandRef.current) {
      focusOnNextExpandRef.current = false;
      inputRef.current?.focus();
    }
  }, [collapsed]);

  if (collapsed) {
    return (
      <button
        type="button"
        aria-label="Search Files"
        onClick={() => {
          focusOnNextExpandRef.current = true;
          setSidebarCollapsed(false);
        }}
        className={cn(
          "flex items-center w-full rounded-[12px] bg-[#0000000F] p-[10px] text-[#1111114D] transition-colors overflow-hidden",
          "hover:bg-[#00000014] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#1111111A]",
        )}
      >
        <span className="size-[18px] flex-shrink-0 flex items-center justify-center">
          <Icons.Search className="size-[18px]" />
        </span>
      </button>
    );
  }

  return (
    <div className="w-full">
      <div
        // Keep the full shell clickable so the search field focuses.
        onClick={() => inputRef.current?.focus()}
        className={cn(
          "flex items-center gap-2 w-full rounded-[12px] bg-[#0000000F] px-3 py-2",
          "transition-colors focus-within:ring-1 focus-within:ring-[#1111111f]",
        )}
      >
        <span className="size-[18px] flex-shrink-0 flex items-center justify-center text-[#1111114D]">
          <Icons.Search className="size-[18px]" />
        </span>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Search Files"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 border-0 bg-transparent p-0 outline-none text-[14px] leading-5 font-medium text-black placeholder:text-[#1111114D]"
        />
        {hasValue ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setValue("");
              inputRef.current?.focus();
            }}
            className={cn(
              "flex items-center justify-center rounded-md px-1.5 py-0.5",
              "text-[#1111114D] transition-colors hover:text-[#11111180]",
            )}
          >
            <Icons.Close className="size-3.5" />
          </button>
        ) : (
          <span className="flex items-center gap-1 rounded-md text-[#1111114D] px-1.5 py-0.5 text-[11px] font-medium">
            <Command className="size-3.5" strokeWidth={1.5} />
            <span>F</span>
          </span>
        )}
      </div>
    </div>
  );
};

export default SidebarSearch;
