import * as Dialog from "@radix-ui/react-dialog";
import React, { useState } from "react";
import { Label } from "@/components/ui/label";
import DialogContainer from "@/components/ui/DialogContainer";
import { AbstractIconWrapper, CardButton, Icons, Input } from "@/components/ui";
import { AlertCircle } from "lucide-react";
import { isAddress } from "@polkadot/util-crypto";
import { toast } from "sonner";
import { addContact } from "@/app/lib/helpers/addressBookDb";

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
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<{
    name?: string;
    address?: string;
  }>({});

  const validateForm = () => {
    const newErrors: { name?: string; address?: string } = {};
    let isValid = true;

    // Name validation
    if (!name.trim()) {
      newErrors.name = "Name is required";
      isValid = false;
    }

    // Address validation
    if (!address.trim()) {
      newErrors.address = "Address is required";
      isValid = false;
    } else if (!isAddress(address)) {
      newErrors.address = "Invalid address format";
      isValid = false;
    }

    setErrors(newErrors);
    return isValid;
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.target.value);
    if (errors.name) setErrors((prev) => ({ ...prev, name: undefined }));
  };

  const handleAddressChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setAddress(e.target.value);
    if (errors.address) setErrors((prev) => ({ ...prev, address: undefined }));
  };

  const handleSave = async () => {
    if (!validateForm()) return;

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
    } catch (error) {
      toast.error("An error occurred while saving the address");
      console.error("Error saving address:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setName("");
    setAddress("");
    setErrors({});
    onClose();
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(isOpen) => !isOpen && handleClose()}
    >
      <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[428px] h-fit">
        <Dialog.Title className="sr-only">Add New Address</Dialog.Title>
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
              Add New Address
            </span>
          </div>

          {/* Mobile Header */}
          <div className="flex py-4 items-center justify-between text-grey-10 md:hidden">
            <span className="text-lg font-medium">Add New Address</span>
            <button onClick={handleClose}>
              <Icons.CloseCircle className="size-6" />
            </button>
          </div>

          {/* Form Fields */}
          <div className="flex flex-col gap-4 mb-4">
            {/* Name */}
            <div className="flex flex-col gap-2 w-full text-grey-10">
              <Label
                htmlFor="name"
                className="text-sm font-medium text-grey-70"
              >
                Name
              </Label>
              <Input
                id="name"
                placeholder="Enter a name"
                type="text"
                value={name}
                onChange={handleNameChange}
                className={`border-grey-80 h-14 text-grey-30 w-full bg-transparent py-4 font-medium text-base rounded-lg duration-300 outline-none hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus ${errors.name ? "border-error-50" : ""
                  }`}
                disabled={loading}
              />
              {errors.name && (
                <div className="flex items-center gap-2 text-error-70 text-sm font-medium mt-1">
                  <AlertCircle className="size-4" />
                  <span>{errors.name}</span>
                </div>
              )}
            </div>

            {/* Address */}
            <div className="flex flex-col gap-2 w-full text-grey-10">
              <Label
                htmlFor="address"
                className="text-sm font-medium text-grey-70"
              >
                Address
              </Label>
              <Input
                id="address"
                placeholder="Enter wallet address"
                type="text"
                value={address}
                onChange={handleAddressChange}
                className={`border-grey-80 h-14 text-grey-30 w-full bg-transparent py-4 font-medium text-base rounded-lg duration-300 outline-none hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus ${errors.address ? "border-error-50" : ""
                  }`}
                disabled={loading}
              />
              {errors.address && (
                <div className="flex items-center gap-2 text-error-70 text-sm font-medium mt-1">
                  <AlertCircle className="size-4" />
                  <span>{errors.address}</span>
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
              {loading ? "Saving..." : "Save Address"}
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

export default AddNewAddressDialog;
