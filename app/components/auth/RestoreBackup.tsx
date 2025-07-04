"use client";

import React from "react";
import { RevealTextLine } from "../ui";
import Link from "next/link";
import RestoreBackupForm from "./RestoreBackupForm";
import AuthLayout from "./AuthLayout";

const RestoreBackup = () => {
  return (
    <AuthLayout>
      <>
        <RestoreBackupForm />

        <RevealTextLine rotate reveal={true} className="delay-500">
          <div className="w-full items-start justify-start flex xl:mt-6 mt-3 text-grey-50 gap-1">
            Are you new here?{" "}
            <Link href="/signup">
              <b className="text-grey-10">Create New Account</b>
            </Link>
          </div>
        </RevealTextLine>
        <RevealTextLine rotate reveal={true} className="delay-500">
          <div className="w-full items-start justify-start flex xl:mt-2 mt-1 text-grey-50 gap-1">
            Already have an account?{" "}
            <Link href="/login">
              <b className="text-grey-10">Sign In</b>
            </Link>
          </div>
        </RevealTextLine>
        <RevealTextLine rotate reveal={true} className="delay-300">
          <p className="text-xs xl:mt-2 mt-1 text-grey-60 font-medium w-full">
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
          <div className="text-grey-70 text-xs font-medium xl:mt-2 mt-1">
            Version 0.4.1.3
          </div>
        </RevealTextLine>
      </>
    </AuthLayout>
  );
};

export default RestoreBackup;
