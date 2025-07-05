"use client";

import React, { useState } from "react";
import { RevealTextLine } from "../ui";
import Link from "next/link";
import CreateAccountForm from "./SignupForm";
import PassCodeForm from "./SetNewPasscodeForm";
import AuthLayout from "./AuthLayout";
import { openUrl } from "@tauri-apps/plugin-opener";

const SignUp = () => {
  const [showPasscodeFields, setShowPasscodeFields] = useState(false);
  const [mnemonic, setMnemonic] = useState("");

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
        {showPasscodeFields ? (
          <PassCodeForm mnemonic={mnemonic} />
        ) : (
          <CreateAccountForm
            setShowPasscodeFields={setShowPasscodeFields}
            setMnemonic={setMnemonic}
            mnemonic={mnemonic}
          />
        )}
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
          <div className="text-grey-70 text-xs font-medium mt-2">
            Version 0.4.1.3
          </div>
        </RevealTextLine>
      </>
    </AuthLayout>
  );
};

export default SignUp;
