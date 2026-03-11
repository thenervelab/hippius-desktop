import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface UseAddressValidationOptions {
  /** If provided, validation will reject this address (e.g. user's own address) */
  disallowedAddress?: string;
  /** Error message when disallowed address is entered */
  disallowedAddressMessage?: string;
}

interface UseAddressValidationReturn {
  address: string;
  setAddress: (value: string) => void;
  addressError: string | undefined;
  setAddressError: (error: string | undefined) => void;
  handleAddressChange: (value: string) => void;
  /** Validates the current address. Returns true if valid. */
  validateAddress: () => Promise<boolean>;
  clearAddressError: () => void;
}

/**
 * Hook that encapsulates wallet address state, change handling, and validation
 * via the Rust `validate_address` command. Used by wallet dialog components
 * (SendBalanceDialog, AddNewAddressDialog, EditAddressDialog) to avoid
 * duplicating address validation logic.
 */
export function useAddressValidation(
  options: UseAddressValidationOptions = {}
): UseAddressValidationReturn {
  const { disallowedAddress, disallowedAddressMessage } = options;
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState<string | undefined>();

  const clearAddressError = useCallback(() => {
    setAddressError(undefined);
  }, []);

  const handleAddressChange = useCallback((value: string) => {
    setAddress(value);
    setAddressError((current) => (current ? undefined : current));
  }, []);

  const validateAddress = useCallback(async (): Promise<boolean> => {
    if (!address.trim()) {
      setAddressError("Address is required");
      return false;
    }

    const valid = await invoke<boolean>("validate_address", { address });
    if (!valid) {
      setAddressError("Invalid address format");
      return false;
    }

    if (disallowedAddress && address.trim() === disallowedAddress) {
      setAddressError(
        disallowedAddressMessage ?? "This address is not allowed"
      );
      return false;
    }

    setAddressError(undefined);
    return true;
  }, [address, disallowedAddress, disallowedAddressMessage]);

  return {
    address,
    setAddress,
    addressError,
    setAddressError,
    handleAddressChange,
    validateAddress,
    clearAddressError,
  };
}
