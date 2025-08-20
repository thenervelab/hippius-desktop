"use client";

import { useState } from "react";
import { Label } from "@/components/ui/label";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, Icons, Input, RevealTextLine } from "@/components/ui";
import { Eye, EyeOff, Key } from "@/components/ui/icons";
import { InView } from "react-intersection-observer";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { useRouter } from "next/navigation";
import { useAtomValue } from "jotai";
import { phaseAtom } from "@/components/splash-screen/atoms";
import * as Checkbox from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";

const LoginWithPassCodeForm = () => {
  const [error, setError] = useState<string | null>(null);
  const [logginIn, setLoggingIn] = useState(false);
  const [showPasscode, setShowPasscode] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [keepMeLoggedIn, setKeepMeLoggedIn] = useState(false);

  const { unlockWithPasscode } = useWalletAuth();
  const router = useRouter();
  const phase = useAtomValue(phaseAtom);

  const handleLogin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setLoggingIn(true);

    if (!passcode) {
      setError("Passcode cannot be empty");
      setLoggingIn(false);
      return;
    }

    try {
      // Pass keepMeLoggedIn flag to use -1 minutes (forever) if checked
      const logoutTimeInMinutes = keepMeLoggedIn ? -1 : undefined;
      const success = await unlockWithPasscode(passcode, logoutTimeInMinutes);
      if (success) {
        router.push("/");
      } else {
        setError("Incorrect passcode. Please try again.");
      }
    } catch (err) {
      console.error("[handleLogin] ", err);
      setError("Failed to unlock wallet. Please try again.");
    } finally {
      setLoggingIn(false);
    }
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
              <div className="space-y-1 text-grey-10 w-full flex flex-col">
                <RevealTextLine rotate reveal={inView} className="delay-300">
                  <Label
                    htmlFor="passcode"
                    className="text-sm font-medium text-grey-70"
                  >
                    Passcode
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
                      id="passcode"
                      placeholder="Enter your passcode here"
                      type={showPasscode ? "text" : "password"}
                      value={passcode}
                      onChange={(e) => setPasscode(e.target.value)}
                      className="px-11 border-grey-80 h-14 text-grey-30 w-full
                    bg-grey-100 py-4 font-medium text-base rounded-lg duration-300 outline-none 
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
              </div>

              <RevealTextLine rotate reveal={inView} className="delay-500">
                <div className="flex items-start mt-3">
                  <Checkbox.Root
                    className="h-4 w-4 rounded border border-grey-70 flex items-center justify-center bg-grey-90 mt-[3px] data-[state=checked]:bg-primary-50 data-[state=checked]:border-primary-50 transition-colors"
                    checked={keepMeLoggedIn}
                    onCheckedChange={() => setKeepMeLoggedIn((prev) => !prev)}
                    id="keepMeLoggedIn"
                  >
                    <Checkbox.Indicator>
                      <Check className="h-3.5 w-3.5 text-white" />
                    </Checkbox.Indicator>
                  </Checkbox.Root>
                  <div className="ml-2">
                    <label
                      htmlFor="keepMeLoggedIn"
                      className="text-[15px] font-medium text-grey-20 leading-[22px]"
                    >
                      Keep me logged in
                    </label>
                  </div>
                </div>
              </RevealTextLine>

              {error && (
                <div className="flex text-error-70 text-sm font-medium mt-2 items-center gap-2">
                  <AlertCircle className="size-4 !relative" />
                  <span>{error}</span>
                </div>
              )}

              <div className="pt-3  flex flex-col w-full">
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
                    disabled={logginIn || phase !== "ready"}
                    icon={<Icons.ArrowRight />}
                  >
                    {logginIn
                      ? "Logging in..."
                      : phase !== "ready"
                      ? "Initializing..."
                      : "Login"}
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

export default LoginWithPassCodeForm;
