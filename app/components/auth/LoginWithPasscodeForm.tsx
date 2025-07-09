"use client";

import { useState } from "react";
import { Label } from "@/components/ui/label";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, Icons, Input, RevealTextLine } from "../ui";
import { Eye, EyeOff, Key } from "../ui/icons";
import { InView } from "react-intersection-observer";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { useRouter } from "next/navigation";
import { useAtomValue } from "jotai";
import { phaseAtom } from "../splash-screen/atoms";

const LoginWithPassCodeForm = () => {
  const [error, setError] = useState<string | null>(null);
  const [logginIn, setLoggingIn] = useState(false);
  const [showPasscode, setShowPasscode] = useState(false);
  const [passcode, setPasscode] = useState("");

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
      const success = await unlockWithPasscode(passcode);
      if (success) {
        router.push("/");
        setLoggingIn(false);
      } else {
        setError("Incorrect passcode. Please try again.");
        setLoggingIn(false);
      }
    } catch (err) {
      console.log("err", err);
      setError("Failed to unlock wallet. Please try again.");
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
                      "w-full h-[60px] text-white font-medium text-lg"
                    )}
                    disabled={logginIn || phase !== "ready"}
                    icon={<Icons.ArrowRight />}
                  >
                    {logginIn ? "Logging in..." : phase !== "ready" ? "Initializing..." : "Login"}
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
