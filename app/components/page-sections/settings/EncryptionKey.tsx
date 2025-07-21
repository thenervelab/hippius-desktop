import React, { useState, useEffect } from "react";
import { Icons, RevealTextLine, IconButton } from "../../ui";
import { InView } from "react-intersection-observer";

import { toast } from "sonner";
import SectionHeader from "./SectionHeader";

import { PlusCircle, AlertCircle } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Input } from "../../ui";
import { Label } from "@/components/ui/label";
import { Eye, EyeOff, Key } from "../../ui/icons";
import { getWalletRecord } from "@/app/lib/helpers/walletDb";
import { hashPasscode } from "@/app/lib/helpers/crypto";
import { cn } from "@/lib/utils";

const EncryptionKey = () => {
  const [encryptionKeys, setEncryptionKeys] = useState<
    Array<{ id: number; key: string }>
  >([]);
  const [showPasscodeInput, setShowPasscodeInput] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [showPasscode, setShowPasscode] = useState(false);
  const [isKeyRevealed, setIsKeyRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchEncryptionKeys();
  }, []);

  const fetchEncryptionKeys = async () => {
    try {
      const keys = await invoke<Array<{ id: number; key: string }>>(
        "get_encryption_keys"
      );
      setEncryptionKeys(keys);
    } catch (error) {
      console.log("Failed to fetch encryption keys:", error);
    }
  };

  const handleEyeClick = () => {
    setShowPasscodeInput(!showPasscodeInput);
    setPasscode("");
    setIsKeyRevealed(false);
    setError(null);
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
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className="flex  w-full flex-col border broder-grey-80 rounded-lg p-4 relative bg-[url('/assets/balance-bg-layer.png')] bg-repeat-round bg-cover"
        >
          <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
            <div className="w-full flex justify-between">
              <SectionHeader
                Icon={Icons.ShieldSecurity}
                title="Encryption Key"
                subtitle="This encryption key is used to securely save your files."
              />
              <IconButton
                icon={PlusCircle}
                text="New Encryption Key  "
                onClick={() => {}}
              />
            </div>
          </RevealTextLine>

          <RevealTextLine
            rotate
            reveal={inView}
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
              <RevealTextLine
                rotate
                reveal={inView && showPasscodeInput}
                className="delay-300 w-full mt-8"
              >
                <div className="space-y-1 text-grey-10 w-full flex flex-col">
                  <Label
                    htmlFor="passcode"
                    className="text-sm font-medium text-grey-70"
                  >
                    Enter your Passcode to view your key
                  </Label>
                  <div className="relative flex items-start w-full">
                    <Key className="size-6 absolute left-3 top-[28px] transform -translate-y-1/2 text-grey-60" />
                    <Input
                      id="passcode"
                      placeholder="Enter your passcode here"
                      type={showPasscode ? "text" : "password"}
                      value={passcode}
                      onChange={(e) => setPasscode(e.target.value)}
                      className="px-11 border-grey-80 h-14 text-grey-30 w-full
                  bg-transparent py-4 font-medium text-base rounded-lg duration-300 outline-none 
                  hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus bg-white"
                    />
                    {!showPasscode ? (
                      <Eye
                        onClick={() => setShowPasscode(true)}
                        className="size-6 absolute right-3 top-[28px] transform -translate-y-1/2 text-grey-60 cursor-pointer"
                      />
                    ) : (
                      <EyeOff
                        onClick={() => setShowPasscode(false)}
                        className="size-6 absolute right-3 top-[28px] transform -translate-y-1/2 text-grey-60 cursor-pointer"
                      />
                    )}
                  </div>
                </div>
              </RevealTextLine>

              {error && (
                <RevealTextLine
                  rotate
                  reveal={inView && showPasscodeInput}
                  className="delay-400 w-full mt-2"
                >
                  <div className="flex text-error-70 text-sm font-medium items-center gap-2">
                    <AlertCircle className="size-4 !relative" />
                    <span>{error}</span>
                  </div>
                </RevealTextLine>
              )}

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
        </div>
      )}
    </InView>
  );
};

export default EncryptionKey;
