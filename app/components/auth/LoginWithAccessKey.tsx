"use client";

import React, { useState } from "react";
import AccessKeyForm from "./AccessKeyForm";
import SetNewPassCodeForm from "./signup/SetNewPasscodeForm";
import AuthLayout from "./AuthLayout";
import LoginFooter from "./LoginFooter";

const LoginWithAccessKey = () => {
  const [showPasscodeFields, setShowPasscodeFields] = useState(false);
  const [mnemonic, setMnemonic] = useState("");

  return (
    <AuthLayout>
      <>
        {showPasscodeFields ? (
          <SetNewPassCodeForm mnemonic={mnemonic} />
        ) : (
          <AccessKeyForm
            showGoBack
            setShowPasscodeFields={setShowPasscodeFields}
            setMnemonic={setMnemonic}
            mnemonic={mnemonic}
          />
        )}
        <LoginFooter />
      </>
    </AuthLayout>
  );
};

export default LoginWithAccessKey;
