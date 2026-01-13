import React, { useState, useEffect } from "react";
import { Icons, RevealTextLine, CardButton, IconButton } from "@/components/ui";
import { toast } from "sonner";
import SectionHeader from "./SectionHeader";
import { InView } from "react-intersection-observer";
import { invoke } from "@tauri-apps/api/core";
import { Edit } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import * as Checkbox from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";

interface AutoconnectStatus {
  is_enabled: boolean;
}

const VPNSettings: React.FC = () => {
  const [autoconnectEnabled, setAutoconnectEnabled] = useState(false);
  const [originalState, setOriginalState] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);

  useEffect(() => {
    // Load the current autoconnect status
    const loadStatus = async () => {
      try {
        const status = await invoke<AutoconnectStatus>(
          "get_autoconnect_status"
        );
        setAutoconnectEnabled(status.is_enabled);
        setOriginalState(status.is_enabled);
      } catch (err) {
        console.error("Failed to load autoconnect status:", err);
        toast.error("Failed to load VPN autoconnect settings");
      } finally {
        setLoading(false);
      }
    };

    loadStatus();
  }, []);

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    // No need to proceed if the setting is unchanged
    if (autoconnectEnabled === originalState) {
      toast.info("No changes detected");
      setEditMode(false);
      return;
    }

    setSaving(true);
    try {
      const newStatus = await invoke<AutoconnectStatus>(
        "toggle_autoconnect_status"
      );

      setAutoconnectEnabled(newStatus.is_enabled);
      setOriginalState(newStatus.is_enabled);
      setEditMode(false);

      toast.success(
        newStatus.is_enabled
          ? "VPN will now connect automatically on app start"
          : "VPN autoconnect disabled"
      );
    } catch (error) {
      toast.error("Failed to update autoconnect setting");
      console.error("Update failed:", error);
      // Revert to original state on error
      setAutoconnectEnabled(originalState);
    } finally {
      setSaving(false);
    }
  };

  // Toggle edit mode
  const toggleEditMode = () => {
    setEditMode(!editMode);

    // If exiting edit mode, reset to original state
    if (editMode) {
      setAutoconnectEnabled(originalState);
    }
  };

  // Check if the setting has been modified
  const hasSettingChanged = autoconnectEnabled !== originalState;

  if (loading) {
    return (
      <div className="flex gap-6 w-full flex-col border border-grey-80 rounded-lg p-4 relative bg-[url('/assets/rpc-bg-layer.png')] bg-repeat-round bg-cover">
        <div className="flex items-center justify-center h-32">
          <span className="text-grey-60">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className={
            "flex gap-6 w-full flex-col border border-grey-80 rounded-lg p-4 relative bg-[url('/assets/rpc-bg-layer.png')] bg-repeat-round bg-cover"
          }
        >
          <div className="w-full flex flex-col ">
            <div className="w-full">
              <RevealTextLine
                rotate
                reveal={inView}
                parentClassName="w-full"
                className="delay-300 w-full"
              >
                <div className="w-full flex justify-between gap-4">
                  <SectionHeader
                    Icon={Icons.ShieldSecurity}
                    title="VPN Settings"
                    subtitle="Configure VPN behavior when the application starts."
                    info="When autoconnect is enabled, the VPN will automatically connect when you start the application. This ensures your connection is always protected. When disabled, you'll need to manually turn on the VPN each time you start the app."
                    learnMoreUrl="https://docs.hippius.com/use/desktop/settings#vpn-settings"
                  />
                  {!editMode && (
                    <IconButton
                      icon={Edit}
                      text={"Update"}
                      onClick={toggleEditMode}
                    />
                  )}
                </div>
              </RevealTextLine>
            </div>
            <form className="w-full flex flex-col" onSubmit={handleSave}>
              <RevealTextLine
                rotate
                reveal={inView}
                parentClassName="w-full"
                className="delay-300 w-full mt-[38px]"
              >
                <div className="space-y-4 text-grey-10 w-full flex flex-col">
                  {/* Autoconnect Checkbox */}
                  <div className="flex items-center justify-between p-4 bg-white border border-grey-80 rounded-lg">
                    <div className="flex flex-col">
                      <span className="text-base font-medium text-grey-10">
                        Autoconnect on Startup
                      </span>
                      <span className="text-sm text-grey-60 mt-1">
                        Automatically connect to VPN when the app starts
                      </span>
                    </div>
                    <Checkbox.Root
                      checked={autoconnectEnabled}
                      onCheckedChange={(checked) => {
                        if (editMode) {
                          setAutoconnectEnabled(checked === true);
                        }
                      }}
                      disabled={!editMode}
                      className={cn(
                        "w-11 h-6 rounded-full transition-all duration-200 relative flex items-center",
                        autoconnectEnabled ? "bg-primary-50" : "bg-grey-80",
                        !editMode && "opacity-50 cursor-not-allowed",
                        editMode && "cursor-pointer hover:shadow-md"
                      )}
                    >
                      <div
                        className={cn(
                          "flex justify-center items-center w-5 h-5 bg-white rounded-full transition-transform duration-200 shadow-sm",
                          autoconnectEnabled
                            ? "translate-x-[22px]"
                            : "translate-x-[2px]"
                        )}
                      >
                        {autoconnectEnabled && (
                          <Check className="w-3 h-3 text-primary-50" />
                        )}
                      </div>
                    </Checkbox.Root>
                  </div>
                </div>
              </RevealTextLine>

              {/* Form with Save Button - Only visible in edit mode */}
              <div
                className={cn(
                  "overflow-hidden transition-all duration-300 ease-in-out",
                  editMode ? "max-h-96 opacity-100 mt-6" : "max-h-0 opacity-0"
                )}
              >
                <RevealTextLine
                  rotate
                  reveal={inView && editMode}
                  className="delay-300 w-full"
                >
                  <CardButton
                    type="submit"
                    className="max-w-[160px] h-[48px]"
                    variant="dialog"
                    disabled={saving || !hasSettingChanged}
                    onClick={handleSave}
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex items-center text-lg leading-6 font-medium">
                        {saving ? "Saving..." : "Save Changes"}
                      </span>
                    </div>
                  </CardButton>
                </RevealTextLine>
              </div>
            </form>
          </div>
        </div>
      )}
    </InView>
  );
};

export default VPNSettings;
