import React, { useState, useEffect } from "react";
import { toast } from "sonner";
import { InView } from "react-intersection-observer";
import { AlertCircle, ShieldCheck } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import { Icons } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { SettingsCard } from "./SettingsCard";
import { cn } from "@/lib/utils";

// User-facing rewrite of low-level transport errors from the Rust side.
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
  return error;
};

const CustomizeRPC: React.FC = () => {
  const [rpcEndpoint, setRpcEndpoint] = useState("");
  const [currentEndpoint, setCurrentEndpoint] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);

  useEffect(() => {
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
    setError(null);
    setTesting(true);
    try {
      await invoke("test_rpc_endpoint_command", { endpoint: rpcEndpoint });
      setTesting(false);
      return true;
    } catch (err) {
      setTesting(false);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(formatErrorMessage(errorMessage));
      return false;
    }
  };

  const handleSave = async () => {
    if (!rpcEndpoint) {
      setError("Please enter an RPC endpoint");
      return;
    }
    if (rpcEndpoint === currentEndpoint) {
      toast.info("No changes detected - endpoint is already set");
      return;
    }
    const isValid = await testEndpoint();
    if (isValid) setShowConfirmDialog(true);
  };

  const handleCancel = () => {
    setRpcEndpoint(currentEndpoint);
    setError(null);
  };

  const confirmAndUpdate = async () => {
    setSaving(true);
    try {
      await invoke("update_wss_endpoint_command", { endpoint: rpcEndpoint });
      toast.success("RPC endpoint updated successfully", {
        description: "Application will restart now to apply changes...",
      });
      setTimeout(async () => {
        await relaunch();
      }, 2000);
    } catch (err) {
      toast.error("Failed to update RPC endpoint");
      console.error("Update failed:", err);
      setSaving(false);
      setShowConfirmDialog(false);
    }
  };

  const hasEndpointChanged =
    rpcEndpoint !== currentEndpoint && rpcEndpoint.trim() !== "";
  const busy = saving || testing;

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div ref={ref} className="flex flex-col gap-4">
          {/* RPC Endpoint card */}
          <div
            className={cn(
              "transition-all duration-500 ease-out",
              inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
            )}
          >
            <SettingsCard label="RPC Endpoint">
              <div className="px-4 py-3">
                <input
                  id="rpc-endpoint"
                  type="text"
                  value={rpcEndpoint}
                  onChange={(e) => {
                    setRpcEndpoint(e.target.value);
                    setError(null);
                  }}
                  placeholder="wss://rpc.hippius.network"
                  disabled={busy}
                  className={cn(
                    "w-full px-3 py-2 rounded-[6px] border text-sm font-medium outline-none transition-colors",
                    "bg-white border-grey-dark-100 text-grey-10 placeholder:text-grey-60",
                    "focus:border-primary-50 focus:ring-2 focus:ring-primary-50/20",
                    "dark:bg-black-700 dark:border-black-300 dark:text-white dark:placeholder:text-grey-dark-500 dark:focus:border-primary-brand-dark dark:focus:ring-primary-brand-dark/20",
                    "disabled:opacity-60 disabled:cursor-not-allowed"
                  )}
                />
                {error && (
                  <div className="flex items-center gap-2 mt-2 text-sm font-medium text-error-70 dark:text-error-50">
                    <AlertCircle className="size-4 flex-shrink-0" />
                    <span>{error}</span>
                  </div>
                )}
              </div>
            </SettingsCard>
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
              disabled={busy || !hasEndpointChanged}
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
              disabled={busy || !hasEndpointChanged}
              loading={busy}
              className={cn(
                "h-[30px] px-3 py-[10px] gap-[10px] rounded-[6px] border text-sm font-medium",
                "border-[#3167DD] bg-[#3167DD] text-white",
                "hover:bg-[#2454c4] hover:border-[#2454c4]",
                "dark:border-[#3167DD] dark:bg-[#3167DD] dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]"
              )}
            >
              {testing ? "Verifying..." : saving ? "Saving..." : "Save Changes"}
            </Button>
          </div>

          {/* Confirmation dialog */}
          <Dialog.Root
            open={showConfirmDialog}
            onOpenChange={(open) => !open && setShowConfirmDialog(false)}
          >
            <Dialog.Portal>
              <Dialog.Overlay className="bg-black/40 fixed inset-0 z-[60] data-[state=open]:animate-fade-in-0.3" />
              <Dialog.Content className="fixed top-1/2 left-1/2 w-[90%] max-w-md -translate-x-1/2 -translate-y-1/2 bg-white dark:bg-black-600 rounded-lg p-6 shadow-xl z-[70] animate-fade-in-0.2 border border-grey-dark-100 dark:border-black-300">
                <div className="flex justify-between items-center mb-5">
                  <Dialog.Title className="text-xl font-semibold text-grey-10 dark:text-white flex items-center gap-2">
                    <ShieldCheck className="text-primary-50 size-6" />
                    Confirm RPC Endpoint
                  </Dialog.Title>
                  <Dialog.Close asChild>
                    <button
                      onClick={() => setShowConfirmDialog(false)}
                      disabled={saving}
                      className="text-grey-50 hover:text-grey-30 dark:text-grey-dark-500 dark:hover:text-white"
                    >
                      <Icons.CloseCircle className="size-6" />
                    </button>
                  </Dialog.Close>
                </div>

                <div className="mb-6 text-grey-10 dark:text-grey-dark-700">
                  <p className="mb-4">
                    Changing the RPC endpoint will affect your connection to the
                    blockchain. The application will need to restart for changes
                    to take effect.
                  </p>
                  <div className="rounded-lg mb-4 border border-grey-80 dark:border-black-300 p-4 bg-grey-light-300 dark:bg-black-primary-bg">
                    <div className="flex justify-between mb-3">
                      <span className="text-grey-50 dark:text-grey-dark-500 font-semibold">
                        Current:
                      </span>
                      <span className="text-grey-10 dark:text-white break-all text-right ml-2">
                        {currentEndpoint}
                      </span>
                    </div>
                    <div className="flex justify-between items-start">
                      <span className="text-grey-50 dark:text-grey-dark-500 font-semibold">
                        New:
                      </span>
                      <span className="text-grey-10 dark:text-white break-all text-right ml-2">
                        {rpcEndpoint}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end gap-3">
                  <Button
                    variant="defaultStable"
                    size="auto"
                    onClick={() => setShowConfirmDialog(false)}
                    disabled={saving}
                    className={cn(
                      "h-[30px] px-3 py-2 gap-[7px] rounded-[6px] border text-sm font-medium",
                      "border-grey-dark-100 bg-[#FEFEFE] text-[#4F4F4F]",
                      "hover:bg-[#F5F5F5] hover:rounded-[6px]",
                      "dark:border-black-300 dark:bg-black-600 dark:text-grey-dark-700 dark:hover:bg-black-500"
                    )}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    size="auto"
                    onClick={confirmAndUpdate}
                    disabled={saving}
                    loading={saving}
                    className={cn(
                      "h-[30px] px-3 py-[10px] gap-[10px] rounded-[6px] border text-sm font-medium",
                      "border-[#3167DD] bg-[#3167DD] text-white",
                      "hover:bg-[#2454c4] hover:border-[#2454c4]",
                      "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]"
                    )}
                  >
                    {saving ? "Updating..." : "Update & Restart"}
                  </Button>
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
