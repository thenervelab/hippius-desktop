"use client";

import React, { useState } from "react";
import { LucideLoader2 } from "lucide-react";
import { Suspense } from "react";
import { InView } from "react-intersection-observer";
import { RevealTextLine } from "../ui";
import { HippiusLogo } from "../ui/icons";
import RightPanel from "./RightCarouselPanel";
import { cn } from "@/app/lib/utils";
import Link from "next/link";
import CreateAccountForm from "./SignupForm";
import PassCodeForm from "./SetNewPasscodeForm";

const SignUp = () => {
  const [showPasscodeFields, setShowPasscodeFields] = useState(false);
  const [mnemonic, setMnemonic] = useState("");

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className="w-full h-full flex flex-col items-center justify-center"
        >
          <div
            className={cn(
              "absolute top-4 right-4 border-r border-t border-primary-40  w-[23px] h-[23px]",
              inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
            )}
          ></div>
          <div
            className={cn(
              "absolute top-4 left-4 border-l border-t border-primary-40 w-[23px] h-[23px]",
              inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
            )}
          ></div>

          <main
            className="xl:px-[120px] px-[40px] py-10 flex items-center justify-between 
          relative h-full w-full grid grid-cols-2 gap-[40px] xl:gap-[120px]"
          >
            <div className="flex flex-col items-start justify-start h-full py-6">
              <RevealTextLine rotate reveal={inView}>
                <div className="flex items-center relative justify-center size-8 bg-primary-50 rounded text-grey-100 xl:mb-28 mb-10">
                  <HippiusLogo className="size-8" />
                </div>
              </RevealTextLine>

              <Suspense
                fallback={
                  <div className="flex h-full w-full items-center justify-center opacity-0 grow animate-fade-in-0.5">
                    <LucideLoader2 className="animate-spin text-primary-50" />
                  </div>
                }
              >
                {showPasscodeFields ? (
                  <PassCodeForm mnemonic={mnemonic} />
                ) : (
                  <CreateAccountForm
                    setShowPasscodeFields={setShowPasscodeFields}
                    setMnemonic={setMnemonic}
                    mnemonic={mnemonic}
                  />
                )}
              </Suspense>
              <RevealTextLine rotate reveal={inView} className="delay-500">
                <div className="w-full items-start justify-start flex mt-6 text-grey-50 gap-1">
                  Already have an account?{" "}
                  <Link href="/login">
                    <b className="text-grey-10">Sign In</b>
                  </Link>
                </div>
              </RevealTextLine>
              <RevealTextLine rotate reveal={inView} className="delay-500">
                <div className="w-full items-start justify-start flex mt-2 text-grey-50 gap-1">
                  Do you have a backup?{" "}
                  <Link href="/restore-backup">
                    <b className="text-grey-10">Restore Backup</b>
                  </Link>
                </div>
              </RevealTextLine>
              <RevealTextLine rotate reveal={inView} className="delay-300">
                <p className="text-xs mt-2 text-grey-60 font-medium w-full">
                  By continuing, you agree to our{" "}
                  <Link
                    href="https://hippius.com/terms-and-conditions"
                    className="text-primary-50 hover:text-[#0052ff]/90"
                  >
                    Terms of Service
                  </Link>{" "}
                  and{" "}
                  <Link
                    href="https://hippius.com/privacy-policy"
                    className="text-primary-50 hover:text-[#0052ff]/90"
                  >
                    Privacy Policy
                  </Link>
                </p>
              </RevealTextLine>
              <RevealTextLine rotate reveal={inView} className="delay-500">
                <div className="text-grey-70 text-xs font-medium mt-2">
                  Version 0.4.1.3
                </div>
              </RevealTextLine>
            </div>
            <RevealTextLine
              rotate
              reveal={inView}
              parentClassName="w-full h-full min-h-full max-h-full"
              className="w-full h-full min-h-full max-h-full"
            >
              <RightPanel />
            </RevealTextLine>
          </main>
          <div
            className={cn(
              "absolute bottom-4 left-4 border-l border-b border-primary-40 w-[23px] h-[23px]",
              inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
            )}
          ></div>
          <div
            className={cn(
              "absolute bottom-4 right-4 border-r border-b border-primary-40 w-[23px] h-[23px]",
              inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
            )}
          ></div>
        </div>
      )}
    </InView>
  );
};

export default SignUp;
