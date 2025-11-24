"use client";

import { useState } from "react";
import { LoginForm } from "@/app/components/auth/LoginForm";
import AuthLayout from "@/components/auth/AuthLayout";

export default function LoginPage() {
  const [hideHeader, setHideHeader] = useState(false);

  return (
    <AuthLayout hideHeader={hideHeader}>
      <LoginForm onHideHeaderChange={setHideHeader} />
    </AuthLayout>
  );
}
