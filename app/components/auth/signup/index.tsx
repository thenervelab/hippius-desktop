"use client";

import React, { useState, useEffect } from "react";
import { RevealTextLine } from "../../ui";
import Link from "next/link";
import CreateAccountForm from "./CreateAccountForm";
import PassCodeForm from "./SetNewPasscodeForm";
import ConfirmAccessKey from "./ConfirmAccessKey";
import AuthLayout from "../AuthLayout";
import { openUrl } from "@tauri-apps/plugin-opener";
import { generateMnemonic } from "@/app/lib/helpers/mnemonic";

const SignUp = () => {
  const [currentStep, setCurrentStep] = useState<
    "create" | "verify" | "passcode"
  >("create");
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
  useEffect(() => {
    generateMnemonic().then(setMnemonic);
  }, [setMnemonic]);
  // Render the correct component based on step
  const renderCurrentStep = () => {
    switch (currentStep) {
      case "create":
        return (
          <CreateAccountForm
            setShowPasscodeFields={() => setCurrentStep("verify")}
            mnemonic={mnemonic}
          />
        );
      case "verify":
        return (
          <ConfirmAccessKey
            mnemonic={mnemonic}
            onBack={() => setCurrentStep("create")}
            onContinue={() => setCurrentStep("passcode")}
          />
        );
      case "passcode":
        return <PassCodeForm mnemonic={mnemonic} />;
      default:
        return null;
    }
  };

  return (
    <AuthLayout isVerify={currentStep === "verify"}>
      <>
        {renderCurrentStep()}
        <RevealTextLine rotate reveal={true} className="delay-500">
          <div className="w-full items-start justify-start flex mt-6 text-grey-50 gap-1">
            Already have an account?{" "}
            <Link href="/login">
              <b className="text-grey-10">Sign In</b>
            </Link>
          </div>
        </RevealTextLine>
        {currentStep === "create" && (
          <RevealTextLine rotate reveal={true} className="delay-500">
            <div className="w-full items-start justify-start flex mt-2 text-grey-50 gap-1">
              Do you have a backup?{" "}
              <Link href="/restore-backup">
                <b className="text-grey-10">Restore Backup</b>
              </Link>
            </div>
          </RevealTextLine>
        )}
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
