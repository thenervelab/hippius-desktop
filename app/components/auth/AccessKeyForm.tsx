"use client";

import { useState } from "react";
import { Label } from "@/components/ui/label";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, Icons, Input, RevealTextLine } from "../ui";
import { Eye, EyeOff, Key } from "../ui/icons";
import { InView } from "react-intersection-observer";
import { isMnemonicValid } from "@/app/lib/helpers/validateMnemonic";

interface AccessKeyFormProps {
  setShowPasscodeFields: React.Dispatch<React.SetStateAction<boolean>>;
  setMnemonic: React.Dispatch<React.SetStateAction<string>>;
  mnemonic: string;
}

const AccessKeyForm: React.FC<AccessKeyFormProps> = ({
  setShowPasscodeFields,
  setMnemonic,
  mnemonic,
}) => {
  const [error, setError] = useState<string | null>(null);
  const [logginIn, setLoggingIn] = useState(false);
  const [showAccessKey, setShowAccessKey] = useState(false);

  const handleLogin = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setLoggingIn(true);
    if (!mnemonic) {
      setError("Seed phrase cannot be empty");
      setLoggingIn(false);
      return;
    }

    if (!isMnemonicValid(mnemonic)) {
      setError("This seed phrase is incorrect");
      setLoggingIn(false);
      return;
    }
    setShowPasscodeFields(true);
    setLoggingIn(false);
  };

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div ref={ref} className="w-full flex flex-col">
          <div className="text-grey-10 opacity-0 animate-fade-in-0.5 w-full  flex flex-col">
            <form onSubmit={handleLogin}>
              <div className="text-grey-10 xl:mb-8 mb-6 xl:text-[32px] text-2xl font-medium">
                <RevealTextLine rotate reveal={inView} className="delay-300">
                  Unlock Your Hippius Account
                </RevealTextLine>
              </div>
              <RevealTextLine rotate reveal={inView} className="delay-300">
                <div className="text-lg text-grey-10 font-medium mb-2">
                  Enter Your Access Key To Continue
                </div>
              </RevealTextLine>
              <div className="space-y-1 text-grey-10 w-full flex flex-col">
                <RevealTextLine rotate reveal={inView} className="delay-300">
                  <Label
                    htmlFor="accessKey"
                    className="text-sm font-medium text-grey-70"
                  >
                    Access Key
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
                      placeholder="Enter or paste seed words here"
                      type={showAccessKey ? "text" : "password"}
                      value={mnemonic}
                      onChange={(e) => setMnemonic(e.target.value)}
                      className="bg-grey-100 px-11 border-grey-80 h-14 text-grey-30 w-full
               py-4 font-medium text-base rounded-lg duration-300 outline-none 
              hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus"
                    />
                    {!showAccessKey ? (
                      <Eye
                        onClick={() => setShowAccessKey(true)}
                        className="size-6 absolute right-3 top-[28px] transform -translate-y-1/2 text-grey-60 cursor-pointer"
                      />
                    ) : (
                      <EyeOff
                        onClick={() => setShowAccessKey(false)}
                        className="size-6 absolute right-3 top-[28px] transform -translate-y-1/2 text-grey-60 cursor-pointer"
                      />
                    )}
                  </div>
                </RevealTextLine>
              </div>

              {error && (
                <div className="flex text-error-70 text-sm font-medium mt-2 items-center gap-2">
                  <AlertCircle className="size-4 !relative" />
                  <span>{error}</span>
                </div>
              )}

              <div className="pt-5  flex flex-col w-full">
                <RevealTextLine
                  rotate
                  reveal={inView}
                  className="delay-300 w-full"
                >
                  <Button
                    type="submit"
                    className={cn(
                      "w-full h-[48px] text-white font-medium text-lg"
                    )}
                    disabled={logginIn}
                    icon={<Icons.ArrowRight />}
                  >
                    {logginIn ? "Logging in..." : "Login"}
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
export default AccessKeyForm;
