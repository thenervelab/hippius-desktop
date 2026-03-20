"use client";

import React, { useState, useEffect } from "react";
import { Mail, Check } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import useNotificationSettings, {
  NotificationSettings,
} from "@/lib/hooks/api/useNotificationSettings";
import * as Dialog from "@radix-ui/react-dialog";
import * as Checkbox from "@radix-ui/react-checkbox";
import * as Switch from "@radix-ui/react-switch";
import { CloseCircle } from "@/components/ui/icons";
import { CardButton, Icons, RevealTextLine, AbstractIconWrapper } from "../../ui";
import SectionHeader from "./SectionHeader";
import { InView } from "react-intersection-observer";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { OAuthButtonsGroup } from "../../auth/OAuthButtons";
import Lock from "../../ui/icons/Lock";

const EmailNotificationSection: React.FC = () => {
  const { oauthSession } = useWalletAuth();
  const { settings, updateSettings, isUpdating } =
    useNotificationSettings();

  const [open, setOpen] = useState(false);

  // Check if user is logged in with mnemonic (access key) or has no OAuth token
  const isAccessKeyLogin = oauthSession?.provider === "mnemonic";
  const requiresOAuthLogin = isAccessKeyLogin || !oauthSession?.token;

  // Local state to manage toggle states
  const [localSettings, setLocalSettings] = useState<NotificationSettings>({
    email_enabled: false,
    low_credit_alerts: false,
    zero_balance_alerts: false,
    file_status_updates: false,
    marketing_emails: false,
  });

  // Sync local state with fetched settings
  useEffect(() => {
    if (settings) {
      setLocalSettings({
        email_enabled: settings.email_enabled,
        low_credit_alerts: settings.low_credit_alerts,
        zero_balance_alerts: settings.zero_balance_alerts,
        file_status_updates: settings.file_status_updates,
        marketing_emails: settings.marketing_emails,
      });
    }
  }, [settings]);

  const handleSave = async () => {
    try {
      await updateSettings(localSettings);
      toast.success("Notification settings updated");
      setOpen(false);
    } catch (error) {
      toast.error("Failed to update notification settings");
      console.error("Error updating notification settings:", error);
    }
  };

  const updateLocalSetting = (
    key: keyof NotificationSettings,
    value: boolean
  ) => {
    setLocalSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (!isOpen && settings) {
      // Reset to saved settings on close
      setLocalSettings({
        email_enabled: settings.email_enabled,
        low_credit_alerts: settings.low_credit_alerts,
        zero_balance_alerts: settings.zero_balance_alerts,
        file_status_updates: settings.file_status_updates,
        marketing_emails: settings.marketing_emails,
      });
    }
  };

  return (
    <>
      <InView triggerOnce>
        {({ inView, ref }) => (
          <div
            ref={ref}
            className="flex flex-col w-full border broder-grey-80 rounded-lg p-4 relative bg-[url('/assets/balance-bg-layer.png')] bg-repeat-round bg-cover"
          >
            <div
              className="w-full cursor-pointer group"
              onClick={() => setOpen(true)}
            >
              <div className="flex flex-row justify-between items-center flex-wrap gap-2">
                <RevealTextLine
                  rotate
                  reveal={inView}
                  className="delay-300 w-full"
                >
                  <SectionHeader
                    Icon={Mail}
                    title="Email Notifications"
                    subtitle={
                      requiresOAuthLogin
                        ? "Sign in with Google, GitHub, or Email to manage notifications"
                        : "Manage your email preferences"
                    }
                  />
                </RevealTextLine>
                <Icons.ArrowRight2 className="size-5 text-grey-10 group-hover:text-primary-50 transition-colors" />
              </div>
            </div>
          </div>
        )}
      </InView>

      <Dialog.Root open={open} onOpenChange={handleOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-white/60 z-50" />
          <Dialog.Content
            className="
              fixed left-1/2 top-1/2 z-50 
              w-full max-w-sm sm:max-w-[428px] 
              max-h-[90vh] overflow-y-auto
              -translate-x-1/2 -translate-y-1/2
              bg-white rounded-[8px]
              shadow-[0px_12px_36px_rgba(0,0,0,0.14)]
              p-4 border border-grey-80
            "
          >
            <div className="absolute top-0 left-0 right-0 h-4 bg-primary-50 rounded-t-[8px] sm:hidden" />
            <Dialog.Close asChild className="sm:hidden">
              <button
                aria-label="Close"
                className="absolute top-[30px] right-4 text-grey-10 hover:text-grey-20"
              >
                <CloseCircle className="size-6" />
              </button>
            </Dialog.Close>

            {/* Show OAuth login when user needs to authenticate */}
            {requiresOAuthLogin ? (
              <div className="py-4">
                <div className="text-center mb-6">
                  <AbstractIconWrapper className="size-12 mx-auto mb-4 flex items-center justify-center">
                    <Lock className="size-7 relative text-primary-50" />
                  </AbstractIconWrapper>
                  <Dialog.Title className="text-2xl font-medium text-grey-10 mb-2">
                    Login Required
                  </Dialog.Title>
                  <Dialog.Description className="text-base text-grey-50 max-w-[330px] mx-auto">
                    Email notifications are not available with Access Key login. Please
                    sign in with one of the following providers to manage your notification settings.
                  </Dialog.Description>
                </div>

                <OAuthButtonsGroup
                  onAccessKeyClick={() => {}}
                  hideAccessKey={true}
                />

                <div className="mt-4 flex justify-center">
                  <Dialog.Close asChild>
                    <button className="text-grey-50 hover:text-grey-10 text-sm font-medium transition-colors">
                      Cancel
                    </button>
                  </Dialog.Close>
                </div>
              </div>
            ) : (
              /* Show notification settings when user is authenticated */
              <>
                <div className="flex justify-between items-start mb-6 max-sm:mt-2.5">
                  <div className="flex flex-col gap-4">
                    <Dialog.Title className="text-grey-10 text-[24px] leading-8 font-medium">
                      Email Notifications
                    </Dialog.Title>
                    <Dialog.Description className="text-grey-50 text-[16px] leading-[22px] font-medium tracking-[-0.32px]">
                      Choose the type of emails you want to recieve
                    </Dialog.Description>
                  </div>
                  <Dialog.Close asChild>
                    <button
                      aria-label="Close"
                      className="text-grey-10 focus-visible:outline-none hover:text-grey-20 hidden sm:block mt-1.5"
                    >
                      <CloseCircle className="size-6" strokeWidth={2} />
                    </button>
                  </Dialog.Close>
                </div>

                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between">
                    <div className="flex flex-col gap-2">
                      <label
                        htmlFor="email-enabled"
                        className="text-[18px] leading-6 font-medium text-grey-10 tracking-[-0.36px]"
                      >
                        Receive Email Notifications
                      </label>
                      <p className="text-[16px] leading-[22px] font-medium text-grey-60 tracking-[-0.32px]">
                        Get emails on everything from us
                      </p>
                    </div>
                    <Switch.Root
                      id="email-enabled"
                      checked={localSettings.email_enabled}
                      onCheckedChange={(checked) =>
                        updateLocalSetting("email_enabled", checked)
                      }
                      className="w-[40px] h-[24px] bg-grey-80 rounded-full relative data-[state=checked]:bg-primary-50 outline-none cursor-pointer border border-grey-80 transition-colors"
                    >
                      <Switch.Thumb className="block w-[20px] h-[20px] bg-white rounded-full transition-transform duration-100 translate-x-0.5 will-change-transform data-[state=checked]:translate-x-[18px]" />
                    </Switch.Root>
                  </div>

                  <div className="h-px bg-grey-80 w-full" />

                  <div className="flex flex-col gap-4">
                    <CheckboxItem
                      label="Low credit balance alerts"
                      checked={localSettings.low_credit_alerts}
                      onCheckedChange={(checked) =>
                        updateLocalSetting("low_credit_alerts", checked as boolean)
                      }
                      disabled={!localSettings.email_enabled}
                    />
                    <CheckboxItem
                      label="Zero balance alerts"
                      checked={localSettings.zero_balance_alerts}
                      onCheckedChange={(checked) =>
                        updateLocalSetting(
                          "zero_balance_alerts",
                          checked as boolean
                        )
                      }
                      disabled={!localSettings.email_enabled}
                    />
                    <CheckboxItem
                      label="Marketing emails & newsletter"
                      checked={localSettings.marketing_emails}
                      onCheckedChange={(checked) =>
                        updateLocalSetting("marketing_emails", checked as boolean)
                      }
                      disabled={!localSettings.email_enabled}
                    />
                  </div>
                </div>

                <div className="mt-4">
                  <CardButton
                    variant="primary"
                    onClick={handleSave}
                    className="w-full"
                    disabled={isUpdating}
                  >
                    {isUpdating ? "Saving..." : "Save Changes"}
                  </CardButton>
                </div>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
};

const CheckboxItem = ({
  label,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean | "indeterminate") => void;
  disabled?: boolean;
}) => (
  <div
    className={cn(
      "flex items-center gap-2",
      disabled && "opacity-50 pointer-events-none"
    )}
  >
    <Checkbox.Root
      className="flex h-4 w-4 appearance-none items-center justify-center rounded-[4px] bg-white border border-grey-80 outline-none data-[state=checked]:bg-primary-50 data-[state=checked]:border-primary-50 transition-colors disabled:cursor-not-allowed"
      checked={checked}
      onCheckedChange={onCheckedChange}
      id={label}
      disabled={disabled}
    >
      <Checkbox.Indicator className="text-white">
        <Check className="h-3 w-3" />
      </Checkbox.Indicator>
    </Checkbox.Root>
    <label
      className={cn(
        "text-[16px] leading-[22px] font-medium text-grey-50 select-none tracking-[-0.32px]",
        disabled ? "cursor-not-allowed" : "cursor-pointer"
      )}
      htmlFor={label}
    >
      {label}
    </label>
  </div>
);

export default EmailNotificationSection;
