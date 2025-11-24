/**
 * Main Login Form Component
 * 
 * Displays OAuth login options (Google, Apple, GitHub) and Access Key option.
 * Handles switching between OAuth flow and traditional access key authentication.
 */

"use client";

import { useState, useEffect } from "react";
import { OAuthButtonsGroup } from "./OAuthButtons";
import { AccessKeyLoginForm } from "./AccessKeyLoginForm";
import * as Typography from "@/components/ui/typography";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";


export function LoginForm({ onHideHeaderChange }: { onHideHeaderChange?: (hide: boolean) => void }) {
    const [showAccessKeyForm, setShowAccessKeyForm] = useState(false);
    const [version, setVersion] = useState<string>("");

    useEffect(() => {
        getVersion().then((v) => setVersion(v));
    }, []);

    useEffect(() => {
        // Notify parent when header visibility should change
        if (onHideHeaderChange) {
            onHideHeaderChange(showAccessKeyForm);
        }
    }, [showAccessKeyForm, onHideHeaderChange]);

    if (showAccessKeyForm) {
        return (
            <AccessKeyLoginForm onBack={() => setShowAccessKeyForm(false)} />
        );
    }

    return (
        <div className="opacity-0 animate-fade-in-0.5 w-full">
            <div className="space-y-6 text-grey-10 w-full">

                <Typography.P size="xl" className="text-grey-10 font-medium !text-[32px]">
                    Log In to Hippius
                </Typography.P>

                <div className="space-y-2">
                    <OAuthButtonsGroup
                        onAccessKeyClick={() => setShowAccessKeyForm(true)}
                    />
                </div>

            </div>
            <div className="text-center mt-4">
                <p className="text-xs text-grey-60 font-semibold">
                    By continuing, you agree to our{" "}
                    <button
                        onClick={() => openUrl("https://hippius.com/terms-and-conditions")}
                        className="text-primary-50 font-semibold hover:text-primary-60 transition-colors cursor-pointer"
                    >
                        Terms and Conditions
                    </button>{" "}
                    and{" "}
                    <button
                        onClick={() => openUrl("https://hippius.com/privacy-policy")}
                        className="text-primary-50 font-semibold hover:text-primary-60 transition-colors cursor-pointer"
                    >
                        Privacy Policy
                    </button>
                </p>
            </div>

            <div className="mt-2 text-center text-xs text-grey-70 font-medium">
                <p>Version {version}</p>
            </div>
        </div>
    );
}
