"use client";

import React from "react";
import { toast } from "sonner";
import InfoPanel from "./info-panel";
import { Button, Icons } from "../../ui";
import { CopyableCell } from "../../ui/alt-table";
import Skeleton from "@/components/ui/skeleton";
import { useVpn } from "@/app/lib/hooks/useVpn";
import { tauriErrorMessage } from "@/app/lib/utils/dispatchTauriError";

// The default service to forward when connecting to a VM. SSH is the common
// case; a richer UI (port picker) is a follow-up. Kept here, not in the hook,
// because it is a presentation default.
const SSH_PORT = 22;

const ACTION_BUTTON_CLASS =
  "h-[33px] flex-1 gap-[8px] rounded-[7px] border border-grey-dark-100 bg-grey-light-100 px-[20px] text-[14px] font-medium leading-[20px] tracking-[-0.28px] text-black-700 hover:bg-grey-90 dark:border-black-300 dark:bg-black-500 dark:text-grey-light-300 dark:hover:bg-black-400";

interface VmVpnConnectProps {
  /** The VM's overlay address (the `nebula_ip` successor), or null if absent. */
  overlayAddress?: string | null;
  isLoading?: boolean;
}

/**
 * Per-VM "Connect via VPN" control. Opt-in and VM-scoped: connecting joins the
 * NetBird overlay as a userspace peer and opening a connection returns a
 * `127.0.0.1:<port>` endpoint that tunnels to this VM — the app's regular
 * traffic is never affected. Rendered only behind `VM_VPN_ENABLED`.
 */
const VmVpnConnect: React.FC<VmVpnConnectProps> = ({ overlayAddress, isLoading }) => {
  const { view, busy, endpoints, connect, disconnect, openConnection } = useVpn();

  const target = overlayAddress ? { address: overlayAddress, port: SSH_PORT } : null;
  const endpoint = target ? endpoints[`${target.address}:${target.port}`] : undefined;

  const handleConnect = async () => {
    try {
      await connect();
    } catch (err) {
      toast.error(`Could not connect to the VPN: ${tauriErrorMessage(err)}`);
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnect();
    } catch (err) {
      toast.error(`Could not disconnect: ${tauriErrorMessage(err)}`);
    }
  };

  const handleOpen = async () => {
    if (!target) return;
    try {
      await openConnection(target);
      toast.success("VPN connection ready");
    } catch (err) {
      toast.error(`Could not open the VM connection: ${tauriErrorMessage(err)}`);
    }
  };

  return (
    <InfoPanel
      label="VPN"
      icon={<Icons.Cloud className="size-[18px]" />}
      bodyClassName="py-[10px] flex flex-col gap-[10px]"
    >
      {isLoading ? (
        <Skeleton className="!h-[20px] !w-[200px] dark:!bg-black-300" />
      ) : (
        <>
          <p className="text-[13px] font-medium leading-[18px] text-grey-dark-800 dark:text-grey-dark-500">
            {view.message}
          </p>

          {endpoint && (
            <CopyableCell
              title="Copy local endpoint"
              toastMessage="Local endpoint copied"
              copyAbleText={`${endpoint.host}:${endpoint.port}`}
              className="w-full text-[14px] font-medium leading-[22px] tracking-[-0.28px] text-black-700 dark:text-grey-light-300"
              textColor="text-black-700 dark:text-grey-light-300"
              copyIconClassName="text-grey-dark-800 dark:text-grey-dark-600 p-1 bg-grey-light-500 dark:bg-black-400 rounded w-6 h-6"
              checkIconClassName="text-grey-dark-800 dark:text-grey-dark-600 p-1 bg-grey-light-500 dark:bg-black-400 rounded w-6 h-6"
            />
          )}

          <div className="flex w-full gap-[12px]">
            {view.canConnect && (
              <Button
                variant="defaultStable"
                size="noStyle"
                className={ACTION_BUTTON_CLASS}
                disabled={busy || view.phase === "unsupported"}
                onClick={handleConnect}
              >
                <Icons.Cloud className="size-4" />
                Connect VPN
              </Button>
            )}

            {view.canOpen && (
              <Button
                variant="defaultStable"
                size="noStyle"
                className={ACTION_BUTTON_CLASS}
                disabled={busy || !target}
                title={target ? undefined : "This VM has no overlay address yet"}
                onClick={handleOpen}
              >
                <Icons.FileKey className="size-4" />
                Open Connection
              </Button>
            )}

            {view.canDisconnect && (
              <Button
                variant="defaultStable"
                size="noStyle"
                className={ACTION_BUTTON_CLASS}
                disabled={busy}
                onClick={handleDisconnect}
              >
                Disconnect
              </Button>
            )}
          </div>
        </>
      )}
    </InfoPanel>
  );
};

export default VmVpnConnect;
