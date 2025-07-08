import React, { useState } from "react";
import { Label } from "../../ui/label";
import { CardButton, Icons, Input } from "../../ui";
import { cn } from "@/app/lib/utils";
import { PASSWORD_FIELDS } from "./FieldsContent";
import { AlertCircle } from "lucide-react";
import UpdateSuccessDialog from "../../update-success-dialog";
import { Eye, EyeOff } from "../../ui/icons";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { getWalletRecord, updateWallet } from "@/app/lib/helpers/walletDb";
import {
  hashPasscode,
  decryptMnemonic,
  encryptMnemonic,
} from "@/app/lib/helpers/crypto";
import { toast } from "sonner";
import { AbstractIconWrapper } from "../../ui";

type PasscodeFields = {
  currentPasscode: string;
  newPasscode: string;
  confirmPasscode: string;
};

type PasscodeField = "currentPasscode" | "newPasscode" | "confirmPasscode";
type FieldErrorState = { [key in PasscodeField]?: string | null };

const ChangePasscode = ({ className }: { className?: string }) => {
  const { setSession } = useWalletAuth();
  const [fieldsData, setFieldsData] = useState<PasscodeFields>({
    currentPasscode: "",
    newPasscode: "",
    confirmPasscode: "",
  });
  const [isLoading, setIsLoading] = useState(false);
  const [fieldError, setFieldError] = useState<FieldErrorState>({});
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [showPasscodes, setShowPasscodes] = useState({
    currentPasscode: false,
    newPasscode: false,
    confirmPasscode: false,
  });

  function validateCurrent(val: string) {
    if (!val) return "Please enter your current passcode.";
    if (val.length < 8) return "Invalid passcode.";
    return null;
  }

  function validateNew(val: string, current: string) {
    if (!val) return "Please enter a new passcode.";
    if (val === current) return "New passcode cannot be same as current.";
    if (val.length < 8) return "Must be at least 8 characters.";
    if (!/[A-Z]/.test(val)) return "Must contain an uppercase letter.";
    if (!/[a-z]/.test(val)) return "Must contain a lowercase letter.";
    if (!/[0-9]/.test(val)) return "Must contain a digit.";
    if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(val))
      return "Must contain a special character.";
    return null;
  }

  function validateConfirm(confirm: string, newPass: string) {
    if (!confirm) return "Please confirm your new passcode.";
    if (confirm !== newPass) return "Passcodes do not match.";
    return null;
  }

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement>,
    fieldName: PasscodeField
  ) => {
    const updated = { ...fieldsData, [fieldName]: e.target.value };
    setFieldsData(updated);

    let err = null;
    if (fieldName === "currentPasscode") err = validateCurrent(e.target.value);
    if (fieldName === "newPasscode")
      err = validateNew(e.target.value, updated.currentPasscode);
    if (fieldName === "confirmPasscode")
      err = validateConfirm(e.target.value, updated.newPasscode);

    setFieldError((prev) => ({ ...prev, [fieldName]: err }));
  };

  const togglePasscodeVisibility = (field: PasscodeField) => {
    setShowPasscodes((prev) => ({
      ...prev,
      [field]: !prev[field],
    }));
  };

  const handleOpenDialog = () => setIsDialogOpen(true);
  const handleCloseDialog = () => setIsDialogOpen(false);

  const handleChangePasscode = async () => {
    // Validate all fields
    const errCurrent = validateCurrent(fieldsData.currentPasscode);
    const errNew = validateNew(
      fieldsData.newPasscode,
      fieldsData.currentPasscode
    );
    const errConfirm = validateConfirm(
      fieldsData.confirmPasscode,
      fieldsData.newPasscode
    );

    setFieldError({
      currentPasscode: errCurrent,
      newPasscode: errNew,
      confirmPasscode: errConfirm,
    });

    if (errCurrent || errNew || errConfirm) {
      return;
    }

    setIsLoading(true);

    try {
      // Check if current passcode is correct
      const record = await getWalletRecord();
      if (!record) {
        throw new Error("No wallet record found");
      }

      const currentPasscodeHash = hashPasscode(fieldsData.currentPasscode);
      if (currentPasscodeHash !== record.passcodeHash) {
        setFieldError((prev) => ({
          ...prev,
          currentPasscode: "Current passcode is incorrect",
        }));
        setIsLoading(false);
        return;
      }

      // Try to decrypt the mnemonic with current passcode to verify
      let decryptedMnemonic;
      try {
        decryptedMnemonic = decryptMnemonic(
          record.encryptedMnemonic,
          fieldsData.currentPasscode
        );
      } catch (error) {
        console.error("Decryption failed:", error);
        setFieldError((prev) => ({
          ...prev,
          currentPasscode: "Current passcode is incorrect",
        }));
        setIsLoading(false);
        return;
      }

      // Encrypt mnemonic with new passcode
      const newEncryptedMnemonic = encryptMnemonic(
        decryptedMnemonic,
        fieldsData.newPasscode
      );
      const newPasscodeHash = hashPasscode(fieldsData.newPasscode);

      // Update wallet in DB
      await updateWallet(newEncryptedMnemonic, newPasscodeHash);

      // Update the session with the decrypted mnemonic to ensure continuity
      setSession(decryptedMnemonic);

      // Clear form fields
      setFieldsData({
        currentPasscode: "",
        newPasscode: "",
        confirmPasscode: "",
      });

      // Show success dialog
      handleOpenDialog();

      toast.success("Passcode updated successfully", {
        duration: 3000,
      });
    } catch (error) {
      console.error("Failed to update passcode:", error);
      toast.error("Failed to update passcode. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const canSave =
    Object.values(fieldsData).every((v) => v.trim() !== "") &&
    Object.values(fieldError).every((v) => !v);

  return (
    <div className="w-full relative bg-[url('/assets/balance-bg-layer.png')] bg-repeat-round bg-cover">
      <div
        className={cn(
          "border relative border-grey-80 overflow-hidden rounded-xl w-full h-full",
          className
        )}
      >
        <div className="w-full flex flex-col xl:flex-row gap-4 2xl:gap-6 p-4 xl:pr-2 relative">
          <div className="flex items-start">
            <AbstractIconWrapper className="size-8 sm:size-10 text-primary-40">
              <Icons.WalletAdd className="absolute text-primary-40 size-4 sm:size-5" />
            </AbstractIconWrapper>
            <div className="flex flex-col ml-4">
              <span className="text-lg leading-6 font-medium mb-0.5  tracking-[-0.28px] text-grey-10">
                Change Passcode
              </span>
              <div className="text-sm xl:w-[160px] mb-1  text-grey-60">
                Set a new passcode for your account security
              </div>
            </div>
          </div>

          <div className="w-full bg-white grid  grid-cols-2 gap-3 p-2 ">
            {PASSWORD_FIELDS.map((field) => (
              <div
                key={field.name}
                className={cn("flex flex-col gap-2", field?.grid)}
              >
                <Label htmlFor={field.name} className="text-grey-70">
                  {field.label}
                </Label>
                <div className="relative">
                  <Input
                    id={field.name}
                    name={field.name}
                    value={fieldsData[field.name as keyof PasscodeFields]}
                    type={
                      showPasscodes[field.name as PasscodeField]
                        ? "text"
                        : "password"
                    }
                    placeholder={field.placeholder}
                    onChange={(e) =>
                      handleInputChange(e, field.name as PasscodeField)
                    }
                    className="border-grey-80 h-14 text-grey-30 w-full
                    bg-transparent p-4 font-medium text-base rounded-lg duration-300 outline-none 
                    hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus"
                  />
                  {!showPasscodes[field.name as PasscodeField] ? (
                    <Eye
                      onClick={() =>
                        togglePasscodeVisibility(field.name as PasscodeField)
                      }
                      className="size-6 absolute right-3 top-[28px] transform -translate-y-1/2 text-grey-60 cursor-pointer"
                    />
                  ) : (
                    <EyeOff
                      onClick={() =>
                        togglePasscodeVisibility(field.name as PasscodeField)
                      }
                      className="size-6 absolute right-3 top-[28px] transform -translate-y-1/2 text-grey-60 cursor-pointer"
                    />
                  )}
                </div>
                {fieldError[field.name as PasscodeField] && (
                  <div className="flex text-error-70 text-sm font-medium mt-2 items-center gap-2">
                    <AlertCircle className="size-4 !relative" />
                    <span>{fieldError[field.name as PasscodeField]}</span>
                  </div>
                )}
              </div>
            ))}
            <div className="col-span-2 mt-3">
              <CardButton
                className="w-20 h-10"
                disabled={!canSave || isLoading}
                loading={isLoading}
                onClick={handleChangePasscode}
              >
                {isLoading ? "Saving..." : "Save"}
              </CardButton>
            </div>
          </div>
        </div>
      </div>

      <UpdateSuccessDialog
        open={isDialogOpen}
        onClose={handleCloseDialog}
        onDone={handleCloseDialog}
        button="Done"
        heading="Passcode Successfully Updated!"
      />
    </div>
  );
};

export default ChangePasscode;
