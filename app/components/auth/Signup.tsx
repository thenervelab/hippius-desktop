"use client";

import React, { useState } from "react";
import { LucideLoader2 } from "lucide-react";
import { Suspense } from "react";
import { RevealTextLine } from "../ui";
import Link from "next/link";
import CreateAccountForm from "./SignupForm";
import PassCodeForm from "./SetNewPasscodeForm";
import AuthLayout from "./AuthLayout";

const SignUp = () => {
  const [showPasscodeFields, setShowPasscodeFields] = useState(false);
  const [mnemonic, setMnemonic] = useState("");

  return (
    <AuthLayout>
      <>
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
        <RevealTextLine rotate reveal={true} className="delay-500">
          <div className="w-full items-start justify-start flex mt-6 text-grey-50 gap-1">
            Already have an account?{" "}
            <Link href="/login">
              <b className="text-grey-10">Sign In</b>
            </Link>
          </div>
        </RevealTextLine>
        <RevealTextLine rotate reveal={true} className="delay-500">
          <div className="w-full items-start justify-start flex mt-2 text-grey-50 gap-1">
            Do you have a backup?{" "}
            <Link href="/restore-backup">
              <b className="text-grey-10">Restore Backup</b>
            </Link>
          </div>
        </RevealTextLine>
        <RevealTextLine rotate reveal={true} className="delay-300">
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
        <RevealTextLine rotate reveal={true} className="delay-500">
          <div className="text-grey-70 text-xs font-medium mt-2">
            Version 0.4.1.3
          </div>
        </RevealTextLine>
      </>
    </AuthLayout>
  );
};

export default SignUp;
