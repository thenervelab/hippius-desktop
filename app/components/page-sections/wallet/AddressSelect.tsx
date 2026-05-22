import * as Menubar from "@radix-ui/react-menubar";
import React, { useEffect, useState, useRef, KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { getContacts } from "@/app/lib/helpers/addressBookDb";
import { Icons } from "@/components/ui";
import {
  inputFieldControlClassName,
  inputFieldShellClassName,
} from "@/components/ui/input";

interface Address {
  id: number;
  name: string;
  walletAddress: string;
}

interface AddressSelectProps {
  value: string;
  onChange: (value: string) => void;
  error?: string;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
  placeholder?: string;
  /** Override classes applied to the trigger shell — e.g. `!shadow-none`
   *  for surfaces (Send dialog) where the global Input ring isn't wanted. */
  wrapperClassName?: string;
}

/**
 * Recipient picker for the Send dialog. Mirrors hippius-web's AddressSelect:
 *   - Trigger reuses the Input shell classes so light/dark/focus visuals stay
 *     in lockstep with the rest of the form.
 *   - Dropdown is portalled with a high z-index so it escapes the dialog
 *     stacking context.
 *   - Items support hover/focus/selected/separator states in both themes.
 */
const AddressSelect: React.FC<AddressSelectProps> = ({
  value,
  onChange,
  error,
  disabled = false,
  onOpenChange,
  placeholder = "Enter or select address",
  wrapperClassName,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [searchText, setSearchText] = useState(value);
  const [filteredAddresses, setFilteredAddresses] = useState<Address[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const loadAddresses = async () => {
      const contacts = await getContacts();
      setAddresses(contacts);
      setFilteredAddresses(contacts);
    };
    loadAddresses();
  }, []);

  useEffect(() => {
    setSearchText(value);
  }, [value]);

  useEffect(() => {
    if (!searchText.trim()) {
      setFilteredAddresses(addresses);
    } else {
      const lower = searchText.toLowerCase();
      setFilteredAddresses(
        addresses.filter(
          (a) =>
            a.name.toLowerCase().includes(lower) ||
            a.walletAddress.toLowerCase().includes(lower),
        ),
      );
    }
  }, [searchText, addresses]);

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    onOpenChange?.(open);
    focusInput();
  };

  const focusInput = () => {
    if (inputRef.current) {
      inputRef.current.focus();
    }
  };

  const handleSelectAddress = (address: string) => {
    onChange(address);
    setSearchText(address);
    setIsOpen(false);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    setSearchText(next);
    onChange(next);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setIsOpen(false);
    }
  };

  // `!shadow-none` callers also want to opt out of the focus-ring on the
  // open state. Detect the override so we don't fight their intent.
  const suppressShadow = wrapperClassName?.includes("!shadow-none");

  return (
    <Menubar.Root>
      <Menubar.Menu>
        <Menubar.Trigger asChild>
          <div
            className={cn(
              inputFieldShellClassName,
              "relative min-h-[54px] cursor-pointer rounded-[10px] px-4",
              error && !suppressShadow
                ? "border-error-50 shadow-[0px_0px_0px_4px_rgba(235,87,87,0.12)]"
                : error
                  ? "border-error-50"
                  : "",
              isOpen && !suppressShadow
                ? "border-primary-50 shadow-[0px_0px_0px_4px_rgba(49,103,221,0.12)]"
                : isOpen
                  ? "border-primary-50"
                  : "",
              disabled ? "cursor-not-allowed opacity-50" : "",
              wrapperClassName,
            )}
            onClick={() => {
              if (!disabled) {
                handleOpenChange(!isOpen);
              }
            }}
          >
            <div className="relative z-10 flex w-full items-center gap-2">
              <input
                ref={inputRef}
                value={searchText}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                disabled={disabled}
                className={cn(
                  inputFieldControlClassName,
                  "h-full text-[15px] tracking-[-0.3px]",
                )}
              />
              <span className="relative z-10 flex items-center justify-center text-[#7d7d7d] dark:text-[#8a8a8a]">
                <Icons.ChevronDown
                  className={cn(
                    "size-5 transition-transform duration-200",
                    isOpen ? "rotate-180" : "",
                  )}
                />
              </span>
            </div>
          </div>
        </Menubar.Trigger>

        <Menubar.Portal>
          <Menubar.Content
            align="start"
            side="bottom"
            sideOffset={8}
            onEscapeKeyDown={() => handleOpenChange(false)}
            onInteractOutside={() => handleOpenChange(false)}
            className={cn(
              "w-[var(--radix-menubar-trigger-width)] max-h-[300px] overflow-y-auto",
              "z-[9999] flex flex-col gap-1 rounded-lg border border-grey-80 bg-white py-2 shadow-menu",
              "dark:border-[#494949] dark:bg-[#1f1f1f] dark:shadow-[0px_4px_16px_rgba(0,0,0,0.4)]",
            )}
            style={{
              position: "fixed",
              zIndex: 9999,
              pointerEvents: "auto",
            }}
            hidden={!isOpen}
          >
            {filteredAddresses.length > 0 &&
              filteredAddresses.map((addr, idx) => {
                const isLast = idx === filteredAddresses.length - 1;
                const isSelected = value === addr.walletAddress;
                return (
                  <Menubar.Item
                    key={addr.id}
                    className={cn(
                      "group flex cursor-pointer items-center justify-between px-4 py-3",
                      "hover:bg-[#f5f7fb] focus:bg-[#f5f7fb] focus:outline-none",
                      "dark:hover:bg-[#2a2a2a] dark:focus:bg-[#2a2a2a]",
                      isSelected &&
                        "border-l-2 border-primary-50 bg-[#f5f7fb] text-primary-50 dark:bg-[#2a2a2a]",
                      !isLast && "border-b border-[#efefef] dark:border-[#3a3a3a]",
                    )}
                    onSelect={() => handleSelectAddress(addr.walletAddress)}
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span
                        className={cn(
                          "text-[13px] font-medium leading-4 tracking-[-0.26px]",
                          "text-[#4f4f4f] dark:text-[#e0e0e0]",
                          "group-hover:text-primary-50 dark:group-hover:text-primary-65",
                        )}
                      >
                        {addr.name}
                      </span>
                      <span
                        className={cn(
                          "text-[12px] leading-[18px] tracking-[-0.24px] break-all",
                          "text-[#7d7d7d] dark:text-[#8a8a8a]",
                          "group-hover:text-primary-50 dark:group-hover:text-primary-65",
                        )}
                      >
                        {addr.walletAddress}
                      </span>
                    </div>
                  </Menubar.Item>
                );
              })}

            {filteredAddresses.length === 0 &&
              addresses.length > 0 &&
              searchText && (
                <div className="px-4 py-3 text-center text-sm text-grey-50 dark:text-[#8a8a8a]">
                  No addresses found matching &quot;{searchText}&quot;
                </div>
              )}

            {addresses.length === 0 && (
              <div className="px-4 py-3 text-center text-sm text-grey-50 dark:text-[#8a8a8a]">
                No saved addresses. Add addresses in the Address Book.
              </div>
            )}
          </Menubar.Content>
        </Menubar.Portal>
      </Menubar.Menu>
    </Menubar.Root>
  );
};

export default AddressSelect;
