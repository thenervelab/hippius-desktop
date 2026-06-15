"use client";

import React, { useEffect, useState } from "react";
import { AlertCircle } from "lucide-react";
import { toast } from "sonner";

import { Label } from "@/components/ui/label";
import { Input, Icons } from "@/components/ui";
import { cn } from "@/lib/utils";

import { updateContact } from "@/app/lib/helpers/addressBookDb";
import { useAddressValidation } from "@/lib/hooks/useAddressValidation";
import {
  WalletDialogShell,
  WalletDialogFooter,
} from "./shared/WalletDesign";

interface Contact {
  id: number;
  name: string;
  walletAddress: string;
}

interface EditAddressDialogProps {
  open: boolean;
  onClose: () => void;
  contact: Contact;
  onEditSuccess?: () => void;
}

const EditAddressDialog: React.FC<EditAddressDialogProps> = ({
  open,
  onClose,
  contact,
  onEditSuccess,
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

  // Re-seed the form whenever the dialog opens for a (potentially
  // different) contact. Mirrors the legacy effect — same setter calls
  // each time so the user sees the contact's current values on entry.
  useEffect(() => {
    if (!open || !contact) return;
    setName(contact.name);
    setAddress(contact.walletAddress);
    setNameError(undefined);
    clearAddressError();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, contact]);

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
    setNameError(undefined);
    clearAddressError();
    onClose();
  };

  const handleSave = async () => {
    if (!(await validateForm())) return;
    setLoading(true);
    try {
      const success = await updateContact(contact.id, name, address);
      if (success) {
        toast.success("Address updated successfully");
        onEditSuccess?.();
        handleClose();
      } else {
        toast.error("Failed to update address");
      }
    } catch (e) {
      toast.error("An error occurred while updating the address");
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <WalletDialogShell
      open={open}
      onClose={handleClose}
      title="Edit Address"
      description="Update a saved contact in your wallet address book."
      icon={<Icons.DocumentText className="size-4 text-white" />}
      maxWidth="max-w-[600px]"
      titleDescriptionGap="mt-2"
      footer={
        <WalletDialogFooter
          primaryLabel={loading ? "Saving..." : "Update Address"}
          secondaryLabel="Cancel"
          onPrimaryClick={handleSave}
          onSecondaryClick={handleClose}
          primaryLoading={loading}
          secondaryDisabled={loading}
        />
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <Label
            htmlFor="edit-contact-name"
            className="text-sm font-medium text-[#6c6c6c] dark:text-grey-dark-700"
          >
            Name
          </Label>
          <Input
            id="edit-contact-name"
            placeholder="Enter a name"
            type="text"
            value={name}
            onChange={handleNameChange}
            aria-invalid={!!nameError}
            disabled={loading}
            className={cn(nameError && "border-error-50")}
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
            htmlFor="edit-contact-address"
            className="text-sm font-medium text-[#6c6c6c] dark:text-grey-dark-700"
          >
            Address
          </Label>
          <Input
            id="edit-contact-address"
            placeholder="Enter wallet address"
            type="text"
            value={address}
            onChange={(e) => handleAddressChange(e.target.value)}
            aria-invalid={!!addressError}
            disabled={loading}
            className={cn(addressError && "border-error-50")}
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

export default EditAddressDialog;
