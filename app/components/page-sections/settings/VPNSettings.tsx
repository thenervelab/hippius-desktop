import React, { useState, useEffect } from "react";
import { toast } from "sonner";
import { InView } from "react-intersection-observer";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { SettingsToggle } from "./SettingsToggle";
import { errorMessage } from "@/lib/utils/errorUtils";
import { cn } from "@/lib/utils";

interface AutoconnectStatus {
  is_enabled: boolean;
}

const VPNSettings: React.FC = () => {
  const [autoconnectEnabled, setAutoconnectEnabled] = useState(false);
  const [originalState, setOriginalState] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
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
    load();
  }, []);

  const handleSave = async () => {
    if (autoconnectEnabled === originalState) return;
    setSaving(true);
    try {
      const newStatus = await invoke<AutoconnectStatus>(
        "toggle_autoconnect_status"
      );
      setAutoconnectEnabled(newStatus.is_enabled);
      setOriginalState(newStatus.is_enabled);
      toast.success(
        newStatus.is_enabled
          ? "VPN will now connect automatically on app start"
          : "VPN autoconnect disabled"
      );
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to update autoconnect setting");
      setAutoconnectEnabled(originalState);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setAutoconnectEnabled(originalState);
  };

  const hasChanged = autoconnectEnabled !== originalState;
  const busy = saving;

  if (loading) {
    return (
      <div className="h-12 w-full max-w-md rounded-lg bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse" />
    );
  }

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div ref={ref} className="flex flex-col gap-6">
          {/* Autoconnect toggle row (no card wrapper) */}
          <div
            className={cn(
              "transition-all duration-500 ease-out",
              inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
            )}
          >
            <div>
              {/* Top row: toggle + label vertically centered together */}
              <div className="flex items-center gap-3">
                <SettingsToggle
                  checked={autoconnectEnabled}
                  onCheckedChange={setAutoconnectEnabled}
                  disabled={busy}
                />
                <p className="text-sm font-medium text-grey-10 dark:text-white">
                  Autoconnect on startup
                </p>
              </div>
              {/* Description on its own row, indented to align with the label (22px toggle + 12px gap) */}
              <p className="text-sm text-grey-60 dark:text-grey-70 mt-1 pl-[34px]">
                Automatically connect to VPN when the app starts
              </p>
            </div>
          </div>

          {/* Action buttons */}
          <div
            className={cn(
              "flex items-center gap-3 transition-all duration-500 ease-out delay-150",
              inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
            )}
          >
            <Button
              variant="defaultStable"
              size="auto"
              onClick={handleCancel}
              disabled={busy || !hasChanged}
              className={cn(
                "h-[30px] px-3 py-2 gap-[7px] rounded-[6px] border text-sm font-medium",
                "border-grey-dark-100 bg-[#FEFEFE] text-[#4F4F4F]",
                "shadow-[0_5px_2.3px_rgba(0,0,0,0.03),0_1px_1.9px_rgba(0,0,0,0.14),0_0_1px_rgba(0,0,0,0.16),inset_0_1px_0_#FFF]",
                "hover:bg-[#F5F5F5] hover:rounded-[6px]",
                "dark:border-black-300 dark:bg-black-600 dark:text-grey-dark-700 dark:shadow-[0_1px_2px_rgba(0,0,0,0.4)] dark:hover:bg-black-500"
              )}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="auto"
              onClick={handleSave}
              disabled={busy || !hasChanged}
              loading={busy}
              className={cn(
                "h-[30px] px-3 py-[10px] gap-[10px] rounded-[6px] border text-sm font-medium",
                "border-[#3167DD] bg-[#3167DD] text-white",
                "hover:bg-[#2454c4] hover:border-[#2454c4]",
                "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]"
              )}
            >
              {busy ? "Saving..." : "Save Changes"}
            </Button>
          </div>
        </div>
      )}
    </InView>
  );
};

export default VPNSettings;
