import React, { useState } from "react";
import { Icons, RevealTextLine, Input, CardButton } from "@/components/ui";
import { toast } from "sonner";
import SectionHeader from "./SectionHeader";
import { Label } from "@/components/ui/label";
import { InView } from "react-intersection-observer";
import { WSS_ENDPOINT } from "@/app/config/constants";

const CustomizeRPC: React.FC = () => {
  const [rpcEndpoint, setRpcEndpoint] = useState(WSS_ENDPOINT);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!rpcEndpoint) {
      toast.error("Please enter an RPC endpoint");
      return;
    }

    setSaving(true);
    try {
      // Here you would add logic to save the RPC endpoint
      await new Promise((resolve) => setTimeout(resolve, 500));
      toast.success("RPC endpoint saved successfully");
    } catch (error) {
      toast.error("Failed to save RPC endpoint");
      console.error("Save failed:", error);
    } finally {
      setSaving(false);
    }
  };

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
                <SectionHeader
                  Icon={Icons.Box}
                  title="RPC Setting"
                  subtitle="Customize your connection by updating the blockchain RPC endpoint."
                  info="The RPC endpoint determines which blockchain network you connect to. By default, we use wss://rpc.hippius.network. Custom endpoints can provide better performance in specific regions or enable connection to test networks. Always ensure you're using a trusted RPC provider for security."
                />
              </RevealTextLine>
            </div>
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
                  RPC End Point
                </Label>
                <div className="relative flex items-start w-full">
                  <Icons.Key className="size-6 absolute left-3 top-[28px] transform -translate-y-1/2 text-grey-60" />
                  <Input
                    id="rpc-endpoint"
                    placeholder="Enter RPC endpoint"
                    value={rpcEndpoint}
                    onChange={(e) => setRpcEndpoint(e.target.value)}
                    className="px-11 border-grey-80 h-14 text-grey-30 w-full
            bg-transparent py-4 font-medium text-base rounded-lg duration-300 outline-none 
            hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus bg-white"
                  />
                </div>
              </div>
            </RevealTextLine>
            <div className="flex justify-start mt-6">
              <RevealTextLine
                rotate
                reveal={inView}
                className="delay-300 w-full"
              >
                <CardButton
                  className="max-w-[160px] h-[60px]"
                  variant="dialog"
                  disabled={saving}
                  loading={saving}
                  onClick={handleSave}
                >
                  <div className="flex items-center gap-2">
                    <span className="flex items-center text-lg leading-6 font-medium">
                      {saving ? "Saving..." : "Save"}
                    </span>
                  </div>
                </CardButton>
              </RevealTextLine>
            </div>
          </div>
        </div>
      )}
    </InView>
  );
};

export default CustomizeRPC;
