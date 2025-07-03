"use client";

import React, { useState, useEffect } from "react";
import { LucideLoader2 } from "lucide-react";
import { Suspense } from "react";
import { RevealTextLine } from "../ui";
import Link from "next/link";
import AccessKeyForm from "./AccessKeyForm";
import SetNewPassCodeForm from "./SetNewPasscodeForm";
import { hasWalletRecord } from "@/app/lib/helpers/walletDb";
import LoginWithPassCodeForm from "./LoginWithPasscodeForm";
import AuthLayout from "./AuthLayout";

const Login = () => {
  const [showPasscodeFields, setShowPasscodeFields] = useState(false);
  const [mnemonic, setMnemonic] = useState("");
  const [hasWallet, setHasWallet] = useState<boolean | null>(null);

  useEffect(() => {
    hasWalletRecord().then(setHasWallet);
  }, []);

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
          {hasWallet ? (
            <LoginWithPassCodeForm />
          ) : showPasscodeFields ? (
            <SetNewPassCodeForm mnemonic={mnemonic} />
          ) : (
            <AccessKeyForm
              setShowPasscodeFields={setShowPasscodeFields}
              setMnemonic={setMnemonic}
              mnemonic={mnemonic}
            />
          )}
        </Suspense>
        <RevealTextLine rotate reveal={true} className="delay-500">
          <div className="w-full items-start justify-start flex mt-6 text-grey-50 gap-1">
            Are you new here?{" "}
            <Link href="/signup">
              <b className="text-grey-10">Create New Account</b>
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

export default Login;
