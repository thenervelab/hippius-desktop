"use client";

import { useState } from "react";
import { Label } from "@/components/ui/label";
import { AlertCircle } from "lucide-react";
import { Button, Icons, Input, RevealTextLine } from "../../ui";
import { Eye, EyeOff, Key } from "../../ui/icons";
import { InView } from "react-intersection-observer";

interface ConfirmAccessKeyProps {
  mnemonic: string;
  onBack: () => void;
  onContinue: () => void;
}

const ConfirmAccessKey: React.FC<ConfirmAccessKeyProps> = ({
  mnemonic,
  onBack,
  onContinue,
}) => {
  const [enteredKey, setEnteredKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const handleVerifyKey = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setVerifying(true);

    if (!enteredKey.trim()) {
      setError("Please enter your access key");
      setVerifying(false);
      return;
    }

    if (enteredKey.trim() !== mnemonic) {
      setError("The access key doesn't match. Please check and try again.");
      setVerifying(false);
      return;
    }

    // Access key is correct
    setVerifying(false);
    onContinue();
  };

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div ref={ref} className="w-full ">
          <div className="text-grey-10 opacity-0 animate-fade-in-0.5 w-full ">
            <form onSubmit={handleVerifyKey}>
              <RevealTextLine
                rotate
                reveal={inView}
                parentClassName="w-full"
                className="delay-300 w-full"
              >
                <div className="w-full flex flex-col gap-[26px]">
                  <button
                    type="button"
                    className="flex gap-2 font-semibold text-lg items-center"
                    onClick={onBack}
                  >
                    <Icons.ArrowLeft className="size-5 text-grey-10" />
                    Back
                  </button>
                  <div className="flex flex-col gap-2">
                    <div className="text-grey-10  xl:text-[32px] text-2xl font-medium">
                      Confirm your Access Key
                    </div>
                    <div className="text-grey-70 text-sm leading-5 font-medium">
                      Please enter your access key to confirm and continue
                      creating your account
                    </div>
                  </div>
                </div>
              </RevealTextLine>

              <div className="space-y-2 mb-2 text-grey-10 w-full flex flex-col mt-6">
                <RevealTextLine rotate reveal={inView} className="delay-300">
                  <Label
                    htmlFor="accessKey"
                    className="text-sm font-medium text-grey-70"
                  >
                    Enter your access key to confirm
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
                      id="accessKey"
                      placeholder="Enter your access key here"
                      type={showKey ? "text" : "password"}
                      value={enteredKey}
                      onChange={(e) => setEnteredKey(e.target.value)}
                      className="bg-grey-100 px-11 border-grey-80 h-14 text-grey-30 w-full
                                   py-4 font-medium text-base rounded-lg duration-300 outline-none 
                                  hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus"
                    />
                    {!showKey ? (
                      <Eye
                        onClick={() => setShowKey(true)}
                        className="size-6 absolute right-3 top-[28px] transform -translate-y-1/2 text-grey-60 cursor-pointer"
                      />
                    ) : (
                      <EyeOff
                        onClick={() => setShowKey(false)}
                        className="size-6 absolute right-3 top-[28px] transform -translate-y-1/2 text-grey-60 cursor-pointer"
                      />
                    )}
                  </div>
                </RevealTextLine>
                {error && (
                  <div className="flex text-error-70 text-sm font-medium mt-2 items-center gap-2">
                    <AlertCircle className="size-4 !relative" />
                    <span>{error}</span>
                  </div>
                )}
              </div>

              <div className="flex flex-col w-full">
                <RevealTextLine
                  rotate
                  reveal={inView}
                  className="delay-300 w-full"
                >
                  <Button
                    type="submit"
                    className="w-full h-[60px] text-white font-medium text-lg"
                    disabled={verifying}
                    icon={<Icons.ArrowRight />}
                  >
                    {verifying ? "Verifying..." : "Continue"}
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

export default ConfirmAccessKey;
