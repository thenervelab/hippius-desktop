"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Label } from "@/components/ui/label";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, Icons, Input, RevealTextLine } from "../ui";
import { Eye, EyeOff, Key, OctagonAlert } from "../ui/icons";
import { InView } from "react-intersection-observer";
import { encryptMnemonic, hashPasscode } from "@/app/lib/helpers/crypto";
import { saveWallet } from "@/app/lib/helpers/walletDb";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { invoke } from "@tauri-apps/api/core";
import { useAtomValue } from "jotai";
import { phaseAtom } from "../splash-screen/atoms";

const passcodeFields = [
  {
    name: "newPassCode",
    label: "Set a Passcode",
    placeholder: "Enter Passcode",
  },
  {
    name: "confirmPassCode",
    label: "Confirm your Passcode",
    placeholder: "Confirm Passcode",
  },
];
type PasscodeField = "newPassCode" | "confirmPassCode";
type FieldErrorState = { [key in PasscodeField]?: string | null };
interface PassCodeFormProps {
  mnemonic: string;
}

const SetNewPassCodeForm: React.FC<PassCodeFormProps> = ({ mnemonic }) => {
  const [passCode, setPasscode] = useState({
    newPassCode: "",
    confirmPassCode: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [logginIn, setLoggingIn] = useState(false);
  const [showPasscode, setShowPasscode] = useState(false);
  const [fieldError, setFieldError] = useState<FieldErrorState>({});

  const router = useRouter();
  const { setSession, polkadotAddress } = useWalletAuth();
  const phase = useAtomValue(phaseAtom);

  const validateNewPass = (val: string) => {
    if (!val) return "Please enter a passcode.";
    if (val.length < 8) return "Passcode must be at least 8 characters.";
    if (!/[A-Z]/.test(val)) return "Must contain an uppercase letter.";
    if (!/[a-z]/.test(val)) return "Must contain a lowercase letter.";
    if (!/[0-9]/.test(val)) return "Must contain a digit.";
    if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(val))
      return "Must contain a special character.";
    return null;
  };
  const validateConfirmPass = (confirm: string, newPass: string) => {
    if (!newPass) return "Enter your passcode new passcode first.";
    if (!confirm) return "Please confirm your passcode.";
    if (confirm !== newPass) return "Passcodes do not match.";
    return null;
  };

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement>,
    fieldName: "newPassCode" | "confirmPassCode"
  ) => {
    const updated = { ...passCode, [fieldName]: e.target.value };
    setPasscode(updated);

    let err = null;
    if (fieldName === "newPassCode") {
      err = validateNewPass(e.target.value);
    } else if (fieldName === "confirmPassCode") {
      err = validateConfirmPass(e.target.value, updated.newPassCode);
    }
    setFieldError((prev) => ({ ...prev, [fieldName]: err }));
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();

    const errNew = validateNewPass(passCode.newPassCode);
    const errConfirm = validateConfirmPass(
      passCode.confirmPassCode,
      passCode.newPassCode
    );
    setFieldError({ newPassCode: errNew, confirmPassCode: errConfirm });

    if (errNew || errConfirm) {
      return;
    }
    setLoggingIn(true);

    try {
      // Encrypt mnemonic with passcode, and hash the passcode
      const encryptedMnemonic = encryptMnemonic(mnemonic, passCode.newPassCode);
      const passcodeHash = hashPasscode(passCode.newPassCode);

      // Store in walletDb (SQLite/sql.js)
      await saveWallet(encryptedMnemonic, passcodeHash);
      await setSession(mnemonic);
      await router.push("/");
    } catch (error) {
      console.error("Failed to create wallet:", error);
      setError(
        error instanceof Error
          ? error.message
          : "An error occurred. Please try again."
      );
    } finally {
      setLoggingIn(false);
    }
  };

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div ref={ref} className="w-full flex flex-col">
          <div className="text-grey-10 opacity-0 animate-fade-in-0.5 w-full  flex flex-col">
            <form onSubmit={handleLogin} className="flex flex-col gap-5">
              <div className="flex flex-col gap-2 mb-1">
                <div className="text-grey-10 xl:text-[32px] text-2xl font-medium">
                  <RevealTextLine rotate reveal={inView} className="delay-300">
                    Encrypt your Hippius Account
                  </RevealTextLine>
                </div>
                <div className="text-grey-70 text-sm font-medium">
                  <RevealTextLine rotate reveal={inView} className="delay-300">
                    Your access key is encrypted with your passcode for
                    security. You&apos;ll need this passcode to log in next time.
                  </RevealTextLine>
                </div>
              </div>
              {passcodeFields?.map((item, index) => {
                return (
                  <div
                    className="space-y-2 text-grey-10 w-full flex flex-col"
                    key={index}
                  >
                    <RevealTextLine
                      rotate
                      reveal={inView}
                      className="delay-300"
                    >
                      <Label
                        htmlFor={item?.name}
                        className="text-sm font-medium text-grey-70"
                      >
                        {item?.label}
                      </Label>
                    </RevealTextLine>
                    <RevealTextLine
                      rotate
                      reveal={inView}
                      className="delay-500 w-full"
                    >
                      <div className="relative flex items-start w-full">
                        <Key className="size-6 absolute left-3 top-[28px] transform -translate-y-1/2 text-grey-60" />
                        <Input
                          id={item?.name}
                          placeholder={item?.placeholder}
                          type={showPasscode ? "text" : "password"}
                          value={
                            passCode[
                              item?.name as "newPassCode" | "confirmPassCode"
                            ]
                          }
                          onChange={(e) =>
                            handleInputChange(e, item.name as PasscodeField)
                          }
                          className="pl-11 border-grey-80 h-14 text-grey-30 w-full
                                  bg-transparent py-4 font-medium text-base rounded-lg duration-300 outline-none 
                                  hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus"
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
                    </RevealTextLine>
                    {fieldError[item.name as PasscodeField] && (
                      <div className="flex text-error-70 text-sm font-medium mt-2 items-center gap-2">
                        <AlertCircle className="size-4 !relative" />
                        <span>{fieldError[item.name as PasscodeField]}</span>
                      </div>
                    )}
                  </div>
                );
              })}

              {error && (
                <div className="flex text-error-70 text-sm font-medium mt-2 items-center gap-2">
                  <AlertCircle className="size-4 !relative" />
                  <span>{error}</span>
                </div>
              )}

              <RevealTextLine
                rotate
                reveal={inView}
                className="delay-300 w-full"
              >
                <div className="flex gap-2 items-center">
                  <OctagonAlert className="text-warning-50 size-6" />
                  <div className="text-grey-50 font-medium text-sm flex gap-2 items-center">
                    <span>
                      We can&apos;t restore this passcode, so please save it in
                      your password manager
                    </span>
                  </div>
                </div>
              </RevealTextLine>

              <div className="flex flex-col w-full">
                <RevealTextLine
                  rotate
                  reveal={inView}
                  className="delay-300 w-full"
                >
                  <Button
                    type="submit"
                    className={cn(
                      "w-full h-[60px] text-white font-medium text-lg"
                    )}
                    disabled={logginIn || phase !== "ready"}
                    icon={<Icons.ArrowRight />}
                  >
                    {logginIn
                      ? "Creating Account..."
                      : phase !== "ready"
                        ? "Initializing..."
                        : "Create Account"}
                  </Button>
                </RevealTextLine>
              </div>
            </form>
          </div>
        </div>
      )}
    </InView>
  );
};
export default SetNewPassCodeForm;
