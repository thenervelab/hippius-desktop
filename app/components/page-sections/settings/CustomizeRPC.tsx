import React, { useState, useEffect } from "react";
import {
  Icons,
  RevealTextLine,
  Input,
  CardButton,
  IconButton,
} from "@/components/ui";
import { toast } from "sonner";
import SectionHeader from "./SectionHeader";
import { Label } from "@/components/ui/label";
import { InView } from "react-intersection-observer";
import { AlertCircle, ShieldCheck } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import { Edit } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

// Function to format error messages in a more user-friendly way
const formatErrorMessage = (error: string): string => {
  if (
    error.includes("failed to lookup address information") ||
    error.includes("Failed to resolve IP addresses")
  ) {
    return "Unable to resolve hostname. Please check if the domain is correct.";
  }

  if (error.includes("connection refused")) {
    return "Connection refused. The server might be down or not accepting connections.";
  }

  if (error.includes("timed out")) {
    return "Connection timed out. The server might be too slow to respond or unreachable.";
  }

  if (error.includes("certificate") || error.includes("SSL")) {
    return "SSL/TLS certificate error. The connection is not secure or the certificate is invalid.";
  }

  if (error.includes("Invalid WSS endpoint format")) {
    return "Invalid endpoint format. The URL must start with ws:// or wss://.";
  }

  // Return original error if no specific formatting is needed
  return error;
};

const CustomizeRPC: React.FC = () => {
  const [rpcEndpoint, setRpcEndpoint] = useState("");
  const [currentEndpoint, setCurrentEndpoint] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [editMode, setEditMode] = useState(false);

  useEffect(() => {
    // Load the current RPC endpoint from the database
    const loadEndpoint = async () => {
      try {
        const endpoint = await invoke<string>("get_wss_endpoint");
        setRpcEndpoint(endpoint);
        setCurrentEndpoint(endpoint);
      } catch (err) {
        console.error("Failed to load RPC endpoint:", err);
        toast.error("Failed to load current RPC endpoint");
      }
    };

    loadEndpoint();
  }, []);

  const testEndpoint = async () => {
    if (!rpcEndpoint) {
      setError("Please enter an RPC endpoint");
      return false;
    }

    setError(null);
    setTesting(true);

    try {
      // Test the endpoint using the Tauri command
      await invoke("test_wss_endpoint_command", { endpoint: rpcEndpoint });
      setTesting(false);
      return true;
    } catch (err) {
      setTesting(false);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(formatErrorMessage(errorMessage));
      return false;
    }
  };

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    if (!rpcEndpoint) {
      setError("Please enter an RPC endpoint");
      return;
    }

    // No need to proceed if the endpoint is unchanged
    if (rpcEndpoint === currentEndpoint) {
      toast.info("No changes detected - endpoint is already set");
      return;
    }

    setTesting(true);
    const isValid = await testEndpoint();
    setTesting(false);

    if (isValid) {
      // Show confirmation dialog
      setShowConfirmDialog(true);
    }
  };

  const confirmAndUpdate = async () => {
    setSaving(true);
    try {
      await invoke("update_wss_endpoint_command", { endpoint: rpcEndpoint });

      toast.success("RPC endpoint updated successfully", {
        description: "Application will restart now to apply changes...",
      });

      // Give the toast time to be seen
      setTimeout(async () => {
        await relaunch();
      }, 2000);
    } catch (error) {
      toast.error("Failed to update RPC endpoint");
      console.error("Update failed:", error);
      setSaving(false);
      setShowConfirmDialog(false);
    }
  };

  // Toggle edit mode
  const toggleEditMode = () => {
    setEditMode(!editMode);
    setError(null);

    // If exiting edit mode, reset to current endpoint
    if (editMode) {
      setRpcEndpoint(currentEndpoint);
    }
  };

  // Check if the endpoint has been modified from current
  const hasEndpointChanged =
    rpcEndpoint !== currentEndpoint && rpcEndpoint.trim() !== "";

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
                    Icon={Icons.Box}
                    title="RPC Setting"
                    subtitle="Customize your connection by updating the blockchain RPC endpoint."
                    info="The RPC endpoint determines which blockchain network you connect to. By default, we use wss://rpc.hippius.network. Custom endpoints can provide better performance in specific regions or enable connection to test networks. Always ensure you're using a trusted RPC provider for security."
                  />
                  {!editMode && (
                    <IconButton
                      className="w-[146px] h-[42px]"
                      icon={Edit}
                      text={"Update RPC"}
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
                    htmlFor="rpc-endpoint"
                    className="text-sm font-medium text-grey-70"
                  >
                    RPC Endpoint
                  </Label>
                  <div className="relative flex items-start w-full">
                    <Icons.Key className="size-6 absolute left-3 top-[28px] transform -translate-y-1/2 text-grey-60" />
                    <Input
                      id="rpc-endpoint"
                      placeholder="Enter RPC endpoint"
                      value={rpcEndpoint}
                      onChange={(e) => {
                        setRpcEndpoint(e.target.value);
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
                    disabled={saving || testing || !hasEndpointChanged}
                    onClick={handleSave}
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex items-center text-lg leading-6 font-medium">
                        {testing
                          ? "Verifying..."
                          : saving
                            ? "Saving..."
                            : "Save"}
                      </span>
                    </div>
                  </CardButton>
                </RevealTextLine>
              </div>
            </form>
          </div>

          {/* Confirmation Dialog */}
          <Dialog.Root
            open={showConfirmDialog}
            onOpenChange={(open) => !open && setShowConfirmDialog(false)}
          >
            <Dialog.Portal>
              <Dialog.Overlay className="bg-black/40 fixed inset-0 flex items-center justify-center data-[state=open]:animate-fade-in-0.3 z-[60]" />
              <Dialog.Content className="fixed top-1/2 left-1/2 w-[90%] max-w-md -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg p-6 shadow-xl z-[70] animate-fade-in-0.2">
                <div className="flex justify-between items-center mb-5">
                  <Dialog.Title className="text-xl font-semibold text-grey-10 flex items-center gap-2">
                    <ShieldCheck className="text-primary-50 size-6" />
                    Confirm RPC Endpoint
                  </Dialog.Title>
                  <Dialog.Close asChild>
                    <button
                      onClick={() => setShowConfirmDialog(false)}
                      disabled={saving}
                      className="text-grey-50 hover:text-grey-30"
                    >
                      <Icons.CloseCircle className="size-6" />
                    </button>
                  </Dialog.Close>
                </div>

                <div className="mb-6 text-grey-10">
                  <p className="mb-4">
                    Changing the RPC endpoint will affect your connection to the
                    blockchain. The application will need to restart for changes
                    to take effect.
                  </p>

                  <div className="bg-grey-90 rounded-lg mb-4 border border-grey-80 p-4">
                    <div className="flex justify-between mb-3">
                      <span className="text-grey-50 font-semibold">
                        Current:
                      </span>
                      <span className="text-grey-10 break-all">
                        {currentEndpoint}
                      </span>
                    </div>

                    <div className="flex justify-between items-start">
                      <span className="text-grey-50 font-semibold">New:</span>
                      <span className="text-grey-10 break-all">
                        {rpcEndpoint}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end gap-3">
                  <button
                    onClick={() => setShowConfirmDialog(false)}
                    disabled={saving}
                    className="px-5 py-2.5 border border-grey-80 rounded-lg text-grey-10 hover:bg-grey-95 transition"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmAndUpdate}
                    disabled={saving}
                    className="px-5 py-2.5 bg-primary-50 text-white rounded-lg hover:bg-primary-40 transition disabled:opacity-50 flex items-center gap-2"
                  >
                    {saving ? (
                      <>
                        <span>Updating...</span>
                      </>
                    ) : (
                      "Update & Restart"
                    )}
                  </button>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </div>
      )}
    </InView>
  );
};

export default CustomizeRPC;
