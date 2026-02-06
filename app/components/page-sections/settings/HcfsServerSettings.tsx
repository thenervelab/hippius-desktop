import React, { useState, useEffect } from "react";
import { Icons, RevealTextLine, Input, CardButton, IconButton } from "@/components/ui";
import { toast } from "sonner";
import SectionHeader from "./SectionHeader";
import { Label } from "@/components/ui/label";
import { InView } from "react-intersection-observer";
import { AlertCircle } from "lucide-react";
import { Edit } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { useSetAtom } from "jotai";
import { triggerSyncPathRefreshAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { invoke } from "@tauri-apps/api/core";
import {
  getHcfsConfig,
  updateHcfsServerUrl,
  initializeSync,
} from "@/app/lib/utils/hcfsConfigUtils";
import { HCFS_CONFIG } from "@/app/lib/config";

const HcfsServerSettings: React.FC = () => {
  const { polkadotAddress, getMnemonic } = useWalletAuth();
  // Reuses the sync path refresh atom to trigger a file list refetch in FilesContainer
  const triggerSyncPathRefresh = useSetAtom(triggerSyncPathRefreshAtom);
  const [serverUrl, setServerUrl] = useState("");
  const [currentUrl, setCurrentUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);

  useEffect(() => {
    const loadConfig = async () => {
      if (!polkadotAddress) return;
      try {
        const config = await getHcfsConfig(polkadotAddress);
        const url = config.server_url || HCFS_CONFIG.defaultServerUrl;
        setServerUrl(url);
        setCurrentUrl(url);
      } catch (err) {
        console.error("Failed to load HCFS config:", err);
      }
    };

    loadConfig();
  }, [polkadotAddress]);

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    const trimmedUrl = serverUrl.trim();

    if (!trimmedUrl) {
      setError("Please enter a server URL");
      return;
    }

    if (!trimmedUrl.startsWith("http://") && !trimmedUrl.startsWith("https://")) {
      setError("URL must start with http:// or https://");
      return;
    }

    if (trimmedUrl === currentUrl) {
      toast.info("No changes detected - server URL is already set");
      return;
    }

    if (!polkadotAddress) {
      setError("No account connected");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      // Stop the existing sync loop first so it releases the drive mutex
      await invoke("stop_sync");

      // Update the URL in the database after sync is stopped
      await updateHcfsServerUrl(polkadotAddress, trimmedUrl);

      const mnemonic = await getMnemonic();
      await initializeSync(polkadotAddress, mnemonic ?? undefined);

      setServerUrl(trimmedUrl);
      setCurrentUrl(trimmedUrl);
      setEditMode(false);
      triggerSyncPathRefresh((prev) => prev + 1);
      toast.success("HCFS server URL updated successfully", {
        description: "Sync has been restarted with the new server.",
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      toast.error("Failed to update server URL");
    } finally {
      setSaving(false);
    }
  };

  const toggleEditMode = () => {
    setEditMode(!editMode);
    setError(null);
    if (editMode) {
      setServerUrl(currentUrl);
    }
  };

  const hasUrlChanged = serverUrl.trim() !== currentUrl && serverUrl.trim() !== "";

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className="flex gap-6 w-full flex-col border border-grey-80 rounded-lg p-4 relative"
        >
          <div className="w-full flex flex-col">
            <div className="w-full">
              <RevealTextLine
                rotate
                reveal={inView}
                parentClassName="w-full"
                className="delay-300 w-full"
              >
                <div className="w-full flex justify-between gap-4">
                  <SectionHeader
                    Icon={Icons.CloudConnection}
                    title="HCFS Server"
                    subtitle="Configure the HCFS API server URL for file sync."
                  />
                  {!editMode && (
                    <IconButton
                      className="w-[146px] h-[42px]"
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
                <div className="space-y-1 text-grey-10 w-full flex flex-col">
                  <Label
                    htmlFor="hcfs-server-url"
                    className="text-sm font-medium text-grey-70"
                  >
                    Server URL
                  </Label>
                  <div className="relative flex items-start w-full">
                    <Icons.Globe className="size-6 absolute left-3 top-[28px] transform -translate-y-1/2 text-grey-60" />
                    <Input
                      id="hcfs-server-url"
                      placeholder="Enter HCFS server URL"
                      value={serverUrl}
                      onChange={(e) => {
                        setServerUrl(e.target.value);
                        setError(null);
                      }}
                      disabled={!editMode}
                      className="px-11 border-grey-80 h-14 text-grey-30 w-full
                        bg-transparent py-4 font-medium text-base rounded-lg duration-300 outline-none
                        hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus bg-white"
                    />
                  </div>
                  {error && (
                    <div className="flex text-error-70 text-sm font-medium mt-2 items-center gap-2">
                      <AlertCircle className="size-4 !relative" />
                      <span>{error}</span>
                    </div>
                  )}
                </div>
              </RevealTextLine>

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
                    disabled={saving || !hasUrlChanged}
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex items-center text-lg leading-6 font-medium">
                        {saving ? "Saving..." : "Save"}
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

export default HcfsServerSettings;
