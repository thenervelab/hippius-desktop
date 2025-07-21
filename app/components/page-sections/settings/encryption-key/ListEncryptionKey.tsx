import React, { useState } from "react";
import { Icons, RevealTextLine, IconButton, CardButton } from "@/components/ui";
import { toast } from "sonner";
import SectionHeader from "../SectionHeader";
import { PlusCircle } from "lucide-react";
import { Input } from "@/components/ui";
import { Label } from "@/components/ui/label";
import { Eye, Key } from "@/components/ui/icons";
import { getWalletRecord } from "@/app/lib/helpers/walletDb";
import { hashPasscode } from "@/app/lib/helpers/crypto";
import { cn } from "@/lib/utils";
import PasscodeInput from "./PasscodeInput";

interface ListEncryptionKeyProps {
  encryptionKeys: Array<{ id: number; key: string }>;
  inView: boolean;
  onGenerateClick: () => void;
  onImportClick: () => void;
}

const ListEncryptionKey: React.FC<ListEncryptionKeyProps> = ({
  encryptionKeys,
  inView,
  onGenerateClick,
  onImportClick
}) => {
  const [showPasscodeInput, setShowPasscodeInput] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [showPasscode, setShowPasscode] = useState(false);
  const [isKeyRevealed, setIsKeyRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleEyeClick = () => {
    setShowPasscodeInput(!showPasscodeInput);
    setPasscode("");
    setIsKeyRevealed(false);
    setError(null);
  };

  const handleToggleShowPasscode = () => {
    setShowPasscode(!showPasscode);
  };

  const validatePasscode = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    if (!passcode) {
      setError("Please enter your passcode");
      return;
    }

    setIsValidating(true);
    setError(null);

    try {
      const record = await getWalletRecord();
      if (!record) throw new Error("No wallet record found");
      if (hashPasscode(passcode) !== record.passcodeHash)
        throw new Error("Incorrect passcode");

      setIsKeyRevealed(true);
      setShowPasscodeInput(false);
      setTimeout(() => toast.success("Passcode validated successfully"), 500);
    } catch (error) {
      setError("Incorrect passcode. Please try again.");
      console.log("Passcode validation failed:", error);
    } finally {
      setIsValidating(false);
    }
  };

  const copyToClipboard = async () => {
    if (!latestKey?.key) return;

    try {
      await navigator.clipboard.writeText(latestKey.key);
      setCopied(true);
      toast.success("Encryption key copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      toast.error("Failed to copy to clipboard");
      console.log("Copy failed:", error);
    }
  };

  const latestKey = encryptionKeys.length > 0 ? encryptionKeys[0] : null;

  return (
    <>
      <RevealTextLine
        rotate
        reveal={inView}
        parentClassName="w-full"
        className="delay-300 w-full"
      >
        <div className="w-full flex justify-between gap-4">
          <SectionHeader
            Icon={Icons.ShieldSecurity}
            title="Encryption Key"
            subtitle="This encryption key is used to securely save your files."
          />
          <div className="flex gap-4 h-[42px]">
            <CardButton
              className="w-[207px] "
              variant="secondary"
              onClick={onImportClick} // Use the onImportClick prop here
            >
              <div className="flex items-center gap-2 text-base font-medium text-grey-10">
                <Key className="size-4" />
                Import Encryption Key
              </div>
            </CardButton>
            <IconButton
              className="w-[210px]"
              icon={PlusCircle}
              text="Generate New Key"
              onClick={onGenerateClick}
            />
          </div>
        </div>
      </RevealTextLine>

      <RevealTextLine
        rotate
        reveal={inView}
        parentClassName="w-full"
        className="delay-300 w-full mt-8"
      >
        <div className="space-y-1 text-grey-10 w-full flex flex-col">
          <Label
            htmlFor="encryption-key"
            className="text-sm font-medium text-grey-70"
          >
            Your Key
          </Label>
          <div className="relative flex items-start w-full">
            <Key className="size-6 absolute left-3 top-[28px] transform -translate-y-1/2 text-grey-60" />
            <Input
              id="encryption-key"
              placeholder="No encryption key found"
              type={isKeyRevealed ? "text" : "password"}
              value={latestKey?.key || ""}
              readOnly
              className="px-11 border-grey-80 h-14 text-grey-30 w-full
            bg-transparent py-4 font-medium text-base rounded-lg duration-300 outline-none 
            hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus bg-white"
            />
            {isKeyRevealed ? (
              <div className="cursor-pointer" onClick={copyToClipboard}>
                {copied ? (
                  <Icons.Check
                    className={cn(
                      "size-6 text-green-500 absolute right-3 top-[28px] transform -translate-y-1/2"
                    )}
                  />
                ) : (
                  <Icons.Copy
                    className={cn(
                      "size-6 text-grey-60 hover:text-grey-70 absolute right-3 top-[28px] transform -translate-y-1/2"
                    )}
                  />
                )}
              </div>
            ) : (
              <Eye
                onClick={handleEyeClick}
                type="button"
                className="size-6 absolute right-3 top-[28px] transform -translate-y-1/2 text-grey-60 cursor-pointer"
              />
            )}
          </div>
        </div>
      </RevealTextLine>

      <div
        className={cn(
          "overflow-hidden transition-all duration-300 ease-in-out",
          showPasscodeInput ? "max-h-96 opacity-100" : "max-h-0 opacity-0"
        )}
      >
        <form className="flex flex-col" onSubmit={validatePasscode}>
          <PasscodeInput
            passcode={passcode}
            onPasscodeChange={setPasscode}
            showPasscode={showPasscode}
            onToggleShowPasscode={handleToggleShowPasscode}
            error={error}
            inView={inView}
            reveal={showPasscodeInput}
          />

          <RevealTextLine
            rotate
            reveal={inView && showPasscodeInput}
            className="delay-300 w-full mt-11"
          >
            <IconButton
              type="submit"
              outerPadding="p-1.5"
              innerPadding="px-6 py-2.5"
              fontSizeClass="text-lg"
              innerClassName="h-12"
              text={"View Encryption Key"}
              onClick={validatePasscode}
              disabled={isValidating || !passcode}
            />
          </RevealTextLine>
        </form>
      </div>
    </>
  );
};

export default ListEncryptionKey;
