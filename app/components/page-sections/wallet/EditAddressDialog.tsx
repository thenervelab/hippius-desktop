import * as Dialog from "@radix-ui/react-dialog";
import React, { useState, useEffect } from "react";
import { Label } from "@/components/ui/label";
import DialogContainer from "@/components/ui/DialogContainer";
import { AbstractIconWrapper, CardButton, Icons, Input } from "@/components/ui";
import { AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { updateContact } from "@/app/lib/helpers/addressBookDb";
import { useAddressValidation } from "@/lib/hooks/useAddressValidation";

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
  onEditSuccess
}) => {
  const [name, setName] = useState("");
  const {
    address,
    setAddress,
    addressError,
    handleAddressChange: onAddressChange,
    validateAddress,
    clearAddressError,
  } = useAddressValidation();
  const [loading, setLoading] = useState(false);
  const [nameError, setNameError] = useState<string | undefined>();

  // Initialize form with contact data
  useEffect(() => {
    if (contact) {
      setName(contact.name);
      setAddress(contact.walletAddress);
    }
  }, [contact]);

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

  const handleAddressChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onAddressChange(e.target.value);
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
    } catch (error) {
      toast.error("An error occurred while updating the address");
      console.error("Error updating address:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setNameError(undefined);
    clearAddressError();
    onClose();
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(isOpen) => !isOpen && handleClose()}
    >
      <DialogContainer className="md:inset-0 md:m-auto w-[428px] h-fit">
        <Dialog.Title className="sr-only">Edit Address</Dialog.Title>
        {/* Mobile accent line */}
        <div className="h-4 bg-primary-50 md:hidden" />

        <div className="px-4">
          {/* Desktop Header */}
          <div className="hidden md:flex flex-col items-center justify-center pb-4 pt-4 gap-2">
            <div className="flex items-center mb-2 p-2">
              <AbstractIconWrapper className="size-8 sm:size-10">
                <Icons.DocumentText className="absolute size-4 sm:size-6 text-primary-50" />
              </AbstractIconWrapper>
            </div>
            <span className="text-center text-2xl text-grey-10 font-medium">
              Edit Address
            </span>
          </div>

          {/* Mobile Header */}
          <div className="flex py-4 items-center justify-between text-grey-10 md:hidden">
            <span className="text-lg font-medium">Edit Address</span>
            <button onClick={handleClose}>
              <Icons.CloseCircle className="size-6" />
            </button>
          </div>

          {/* Form Fields */}
          <div className="flex flex-col gap-4 mb-4">
            {/* Name */}
            <div className="flex flex-col gap-2 w-full text-grey-10">
              <Label
                htmlFor="edit-name"
                className="text-sm font-medium text-grey-70"
              >
                Name
              </Label>
              <Input
                id="edit-name"
                placeholder="Enter a name"
                type="text"
                value={name}
                onChange={handleNameChange}
                className={`border-grey-80 h-14 text-grey-30 w-full bg-transparent py-4 font-medium text-base rounded-lg duration-300 outline-none hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus ${nameError ? "border-error-50" : ""
                  }`}
                disabled={loading}
              />
              {nameError && (
                <div className="flex items-center gap-2 text-error-70 text-sm font-medium mt-1">
                  <AlertCircle className="size-4" />
                  <span>{nameError}</span>
                </div>
              )}
            </div>

            {/* Address */}
            <div className="flex flex-col gap-2 w-full text-grey-10">
              <Label
                htmlFor="edit-address"
                className="text-sm font-medium text-grey-70"
              >
                Address
              </Label>
              <Input
                id="edit-address"
                placeholder="Enter wallet address"
                type="text"
                value={address}
                onChange={handleAddressChange}
                className={`border-grey-80 h-14 text-grey-30 w-full bg-transparent py-4 font-medium text-base rounded-lg duration-300 outline-none hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus ${addressError ? "border-error-50" : ""
                  }`}
                disabled={loading}
              />
              {addressError && (
                <div className="flex items-center gap-2 text-error-70 text-sm font-medium mt-1">
                  <AlertCircle className="size-4" />
                  <span>{addressError}</span>
                </div>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-4 mt-4 mb-4">
            <CardButton
              className="bg-primary-50 text-[18px] hover:bg-primary-40 transition text-white w-full font-medium"
              variant="dialog"
              onClick={handleSave}
              disabled={loading}
              loading={loading}
            >
              {loading ? "Saving..." : "Update Address"}
            </CardButton>

            <CardButton
              className="w-full text-[18px]"
              variant="secondary"
              onClick={handleClose}
              disabled={loading}
            >
              Cancel
            </CardButton>
          </div>
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
};

export default EditAddressDialog;
