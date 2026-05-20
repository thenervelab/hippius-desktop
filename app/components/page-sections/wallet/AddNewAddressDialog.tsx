"use client";

import React, { useState } from "react";
import { AlertCircle } from "lucide-react";
import { toast } from "sonner";

import { Label } from "@/components/ui/label";
import { Input, Icons } from "@/components/ui";
import { cn } from "@/lib/utils";

import { addContact } from "@/app/lib/helpers/addressBookDb";
import { useAddressValidation } from "@/lib/hooks/useAddressValidation";
import {
  WalletDialogShell,
  WalletDialogFooter,
} from "./shared/WalletDesign";

interface AddNewAddressDialogProps {
  open: boolean;
  onClose: () => void;
  onAddSuccess?: () => void;
}

const AddNewAddressDialog: React.FC<AddNewAddressDialogProps> = ({
  open,
  onClose,
  onAddSuccess,
}) => {
  const [name, setName] = useState("");
  const {
    address,
    setAddress,
    addressError,
    handleAddressChange,
    validateAddress,
    clearAddressError,
  } = useAddressValidation();
  const [loading, setLoading] = useState(false);
  const [nameError, setNameError] = useState<string | undefined>();

  const validateForm = async () => {
    let nameValid = true;
    if (!name.trim()) {
      setNameError("Name is required");
      nameValid = false;
    } else {
      setNameError(undefined);
    }
    const addressValid = await validateAddress();
    return nameValid && addressValid;
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.target.value);
    if (nameError) setNameError(undefined);
  };

  const handleClose = () => {
    setName("");
    setAddress("");
    setNameError(undefined);
    clearAddressError();
    onClose();
  };

  const handleSave = async () => {
    if (!(await validateForm())) return;
    setLoading(true);
    try {
      const success = await addContact(name, address);
      if (success) {
        toast.success("Address saved successfully");
        onAddSuccess?.();
        handleClose();
      } else {
        toast.error("Failed to save address");
      }
    } catch (e) {
      toast.error("An error occurred while saving the address");
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <WalletDialogShell
      open={open}
      onClose={handleClose}
      title="Add New Address"
      description="Save a wallet address to your address book for faster transfers later."
      icon={<Icons.DocumentText className="size-4 text-white" />}
      iconTitleGap="mt-4 mb-0"
      titleDescriptionGap="mt-0"
      maxWidth="max-w-[500px]"
      contentClassName="px-4 pb-4 pt-5 sm:w-[420px] sm:px-5 sm:pb-5"
      footer={
        <WalletDialogFooter
          primaryLabel={loading ? "Saving..." : "Save Address"}
          secondaryLabel="Cancel"
          onPrimaryClick={handleSave}
          onSecondaryClick={handleClose}
          primaryLoading={loading}
          secondaryDisabled={loading}
        />
      }
    >
      <div className="space-y-3.5">
        <div className="space-y-2">
          <Label
            htmlFor="contact-name"
            className="text-[14px] font-medium leading-[normal] tracking-[-0.28px] text-[#7d7d7d]"
          >
            Name
          </Label>
          <Input
            id="contact-name"
            placeholder="Enter a name"
            type="text"
            value={name}
            onChange={handleNameChange}
            aria-invalid={!!nameError}
            disabled={loading}
            className={cn("h-12 text-base font-medium", nameError && "border-error-50")}
          />
          {nameError ? (
            <div className="flex items-center gap-2 text-error-70 text-sm font-medium">
              <AlertCircle className="size-4" />
              <span>{nameError}</span>
            </div>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label
            htmlFor="contact-address"
            className="text-[14px] font-medium leading-[normal] tracking-[-0.28px] text-[#7d7d7d]"
          >
            Address
          </Label>
          <Input
            id="contact-address"
            placeholder="Enter wallet address"
            type="text"
            value={address}
            onChange={(e) => handleAddressChange(e.target.value)}
            aria-invalid={!!addressError}
            disabled={loading}
            className={cn(
              "h-12 text-base font-medium",
              addressError && "border-error-50",
            )}
          />
          {addressError ? (
            <div className="flex items-center gap-2 text-error-70 text-sm font-medium">
              <AlertCircle className="size-4" />
              <span>{addressError}</span>
            </div>
          ) : null}
        </div>
      </div>
    </WalletDialogShell>
  );
};

export default AddNewAddressDialog;
