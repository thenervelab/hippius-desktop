"use client";

import { useState, useEffect } from "react";
import { Label } from "@/components/ui/label";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, Icons, RevealTextLine, ImportantWarnings } from "../ui";
import { InView } from "react-intersection-observer";
import { isMnemonicValid } from "@/app/lib/helpers/validateMnemonic";
import { ShieldSecurity, OctagonAlert } from "@/components/ui/icons";
import { toast } from "sonner";
import { generateMnemonic } from "@/app/lib/helpers/mnemonic";

interface CreateAccountFormProps {
  setShowPasscodeFields: React.Dispatch<React.SetStateAction<boolean>>;
  setMnemonic: React.Dispatch<React.SetStateAction<string>>;
  mnemonic: string;
}

const CreateAccountForm: React.FC<CreateAccountFormProps> = ({
  setShowPasscodeFields,
  setMnemonic,
  mnemonic,
}) => {
  const [error, setError] = useState<string | null>(null);
  const [SigningUp, setSigningUp] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    generateMnemonic().then(setMnemonic);
  }, [setMnemonic]);

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(mnemonic);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success("Copied to clipboard successfully!");
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const handleSignUp = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSigningUp(true);
    if (!mnemonic) {
      setError("Seed phrase cannot be empty");
      setSigningUp(false);
      return;
    }

    if (!isMnemonicValid(mnemonic)) {
      setError("This seed phrase is incorrect");
      setSigningUp(false);
      return;
    }
    setShowPasscodeFields(true);
    setSigningUp(false);
  };

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div ref={ref} className="w-full flex flex-col">
          <div className="text-grey-10 opacity-0 animate-fade-in-0.5 w-full  flex flex-col">
            <form onSubmit={handleSignUp}>
              <div className="text-grey-10 xl:mb-10 mb-4 xl:text-[32px] text-2xl font-medium">
                <RevealTextLine rotate reveal={inView} className="delay-300">
                  Create Your Hippius Account
                </RevealTextLine>
              </div>

              <div className="space-y-1 text-grey-10 w-full flex flex-col">
                <RevealTextLine rotate reveal={inView} className="delay-300">
                  <Label
                    htmlFor="accessKey"
                    className="text-sm font-medium text-grey-70"
                  >
                    Your Access Key
                  </Label>
                </RevealTextLine>
                <div
                  className={cn(
                    "p-4 shadow-input-shadow rounded-lg border border-grey-80 text-grey-30 gap-2 flex justify-between items-start w-full",
                    "transition-opacity duration-500 delay-500",
                    inView
                      ? "opacity-100 translate-y-0"
                      : "opacity-0 translate-y-8"
                  )}
                >
                  <div className="flex gap-2 items-center justify-center">
                    <div>
                      <ShieldSecurity className="text-grey-60 size-6" />
                    </div>

                    <span className="text-base font-medium break-all">
                      {mnemonic}
                    </span>
                  </div>
                  <div className="cursor-pointer" onClick={copyToClipboard}>
                    {copied ? (
                      <Icons.Check className={cn("size-6 text-green-500")} />
                    ) : (
                      <Icons.Copy
                        className={cn("size-6 text-grey-60 hover:text-grey-70")}
                      />
                    )}
                  </div>
                </div>
              </div>

              <ImportantWarnings inView={inView} />

              <div className="xl:pt-5 pt-3 flex flex-col w-full">
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
                    disabled={SigningUp}
                    icon={<Icons.ArrowRight />}
                  >
                    {SigningUp ? "Creating Account..." : "Create Account"}
                  </Button>
                </RevealTextLine>
              </div>
              {error && (
                <div className="flex text-error-70 text-sm font-medium mt-2 items-center gap-2">
                  <AlertCircle className="size-4 !relative" />
                  <span>{error}</span>
                </div>
              )}
            </form>
          </div>
        </div>
      )}
    </InView>
  );
};
export default CreateAccountForm;
