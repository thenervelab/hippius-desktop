import * as Menubar from "@radix-ui/react-menubar";
import React, { useEffect, useState, useRef, KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { getContacts } from "@/app/lib/helpers/addressBookDb";
import { Icons } from "@/components/ui";

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
}

const AddressSelect: React.FC<AddressSelectProps> = ({
  value,
  onChange,
  error,
  disabled = false,
  onOpenChange,
  placeholder = "Enter or select address",
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [searchText, setSearchText] = useState(value);
  const [filteredAddresses, setFilteredAddresses] = useState<Address[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load addresses from address book
  useEffect(() => {
    const loadAddresses = async () => {
      const contacts = await getContacts();
      setAddresses(contacts);
      setFilteredAddresses(contacts);
    };

    loadAddresses();
  }, []);

  // Update search text when value changes externally
  useEffect(() => {
    setSearchText(value);
  }, [value]);

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
    const value = e.target.value;
    setSearchText(value);
    onChange(value);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setIsOpen(false);
    }
  };

  return (
    <Menubar.Root>
      <Menubar.Menu>
        <Menubar.Trigger asChild>
          <div
            className={cn(
              "relative h-14 w-full bg-transparent rounded-lg border border-grey-80",
              "flex items-center cursor-pointer transition-shadow duration-300",
              "hover:shadow-input-focus group",
              error ? "border-error-50" : "",
              disabled ? "opacity-50 cursor-not-allowed" : ""
            )}
            onClick={() => {
              if (!disabled) {
                handleOpenChange(!isOpen);
              }
            }}
          >
            <div className="relative z-10 flex items-center w-full  py-3 px-4">
              <input
                ref={inputRef}
                value={searchText}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                disabled={disabled}
                className="border-0 shadow-none p-0 bg-transparent h-full w-full outline-none focus:ring-0 focus:shadow-none placeholder-grey-60 font-medium text-base"
              />
              <span className="relative z-10 ml-2  flex justify-center items-center text-grey-60  ">
                <Icons.ChevronDown
                  className={cn(
                    "size-6 transition-transform duration-200 group-data-[state=open]:rotate-180"
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
            className="w-[var(--radix-menubar-trigger-width)] max-h-[300px] overflow-y-auto bg-white shadow-menu rounded-lg border border-grey-80 z-50 py-2 flex flex-col gap-1"
            hidden={!isOpen}
          >
            {filteredAddresses.length > 0 &&
              filteredAddresses.map((addr) => (
                <Menubar.Item
                  key={addr.id}
                  className={cn(
                    "px-6 py-1 cursor-pointer  flex items-center justify-between group",
                    value === addr.walletAddress
                      ? "text-primary-50 border-l border-primary-50"
                      : ""
                  )}
                  onSelect={() => handleSelectAddress(addr.walletAddress)}
                >
                  <div className="flex flex-col">
                    <span className="text-grey-70 text-[10px] leading-4 group-hover:text-primary-50">
                      {addr.name}
                    </span>
                    <span className="text-grey-50 text-[12px]  leading-[18px] font-medium group-hover:text-primary-50">
                      {addr.walletAddress.slice(0, 12)}...
                      {addr.walletAddress.slice(-12)}
                    </span>
                  </div>
                </Menubar.Item>
              ))}

            {addresses.length === 0 && (
              <div className="py-3 px-4 text-grey-50 text-sm text-center">
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
