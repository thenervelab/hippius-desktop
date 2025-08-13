"use client";

import React, { useState, useEffect } from "react";
import { AppVersion, RevealTextLine } from "@/components/ui";
import Link from "next/link";
import AccessKeyForm from "./AccessKeyForm";
import SetNewPassCodeForm from "./signup/SetNewPasscodeForm";
import { hasWalletRecord } from "@/app/lib/helpers/hippiusDesktopDB";
import LoginWithPassCodeForm from "./LoginWithPasscodeForm";
import AuthLayout from "./AuthLayout";
import { openUrl } from "@tauri-apps/plugin-opener";

const Login = () => {
  const [showPasscodeFields, setShowPasscodeFields] = useState(false);
  const [mnemonic, setMnemonic] = useState("");
  const [hasWallet, setHasWallet] = useState<boolean | null>(null);

  useEffect(() => {
    hasWalletRecord().then(setHasWallet);
  }, []);

  const handleTermsClick = async () => {
    try {
      await openUrl("https://hippius.com/terms-and-conditions");
    } catch (error) {
      console.error("Failed to open Terms of Service:", error);
    }
  };

  const handlePrivacyClick = async () => {
    try {
      await openUrl("https://hippius.com/privacy-policy");
    } catch (error) {
      console.error("Failed to open Privacy Policy:", error);
    }
  };
  return (
    <AuthLayout>
      <>
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
        <RevealTextLine rotate reveal={true} className="delay-500">
          <div className="w-full items-start justify-start flex mt-6 text-grey-50 gap-1">
            Are you new here?{" "}
            <Link href="/signup">
              <b className="text-grey-10">Create New Account</b>
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
            <button
              onClick={handleTermsClick}
              className="text-primary-50 hover:text-[#0052ff]/90 hover:underline"
            >
              Terms of Service
            </button>{" "}
            and{" "}
            <button
              onClick={handlePrivacyClick}
              className="text-primary-50 hover:text-[#0052ff]/90 hover:underline"
            >
              Privacy Policy
            </button>
          </p>
        </RevealTextLine>
        <RevealTextLine rotate reveal={true} className="delay-500">
          <div className="text-grey-70 text-xs font-medium mt-2 flex items-center gap-2">
            <span>
              Version <AppVersion />
            </span>
          </div>
        </RevealTextLine>
      </>
    </AuthLayout>
  );
};

export default Login;
