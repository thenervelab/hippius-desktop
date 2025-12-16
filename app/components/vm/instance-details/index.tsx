"use client";
import React, { useState, useEffect } from "react";
import { useParams, useSearchParams } from "next/navigation";
import InstanceHeader from "./instance-header";
import { MOCK_INSTANCES } from "../instances-table/mock-data";
import { Instance } from "../instances-table";
import { Loader } from "lucide-react";
import VirtualMachineInfo from "./virtual-machine-info";
import NetworksInfo from "./networks-info";
import VncConsole from "./vnc-console";
import ChangeImageModal from "./change-image-modal";
import { useDeleteInstance } from "../hooks/useDeleteInstance";
import { useStartStopInstance } from "../hooks/useStartStopInstance";
import { useRebootInstance } from "../hooks/useRebootInstance";
import { useReinstallInstance } from "../hooks/useReinstallInstance";

const InstanceDetails: React.FC = () => {
  const { instanceId } = useParams();
  const searchParams = useSearchParams();
  const [instanceData, setInstanceData] = useState<Instance | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<string>("Dashboard");
  const [openChangeImageModal, setOpenChangeImageModal] = useState(false);

  // Use delete instance hook with redirect
  const { handleDeleteInstance, DeleteInstanceModal } = useDeleteInstance({
    redirectOnDelete: true,
  });

  // Use start/stop instance hook
  const { handleStartStopInstance, StartStopConfirmModal } =
    useStartStopInstance();

  // Use reboot instance hook
  const { handleRebootInstance, RebootConfirmModal } = useRebootInstance();

  // Use reinstall instance hook
  const { handleReinstallInstance, ReinstallConfirmModal } =
    useReinstallInstance();

  useEffect(() => {
    const instance = MOCK_INSTANCES.find((inst) => inst.id === instanceId);

    setTimeout(() => {
      setInstanceData(instance || null);
      setLoading(false);
    }, 500);
  }, [instanceId]);

  useEffect(() => {
    const tab = searchParams.get("tab");
    if (tab === "vnc-console") {
      setActiveTab("VNC Console");
    }
  }, [searchParams]);

  const handleTabChange = (tabName: string) => {
    setActiveTab(tabName);
  };

  const handleChangeImage = () => {
    setOpenChangeImageModal(true);
  };

  const handleStartStop = () => {
    handleStartStopInstance(instanceData || undefined, instanceData?.status);
  };

  const handleReboot = () => {
    handleRebootInstance(instanceData || undefined);
  };

  const handleReinstall = () => {
    handleReinstallInstance(instanceData || undefined);
  };

  const handleImageChange = (data: {
    operatingSystem: string;
    image: string;
  }) => {
    console.log("Changing image to:", data);
    setOpenChangeImageModal(false);
  };

  if (loading) {
    return (
      <div className="w-full py-12 flex justify-center items-center">
        <div className="animate-spin">
          <Loader className="size-6 text-primary-50" />
        </div>
      </div>
    );
  }

  if (!instanceData) {
    return (
      <div className="w-full py-12">
        <div className="text-center">
          <h2 className="text-lg font-medium text-grey-20">
            Instance not found
          </h2>
          <p className="text-grey-60 mt-2">
            The instance you're looking for doesn't exist or has been deleted.
          </p>
        </div>
      </div>
    );
  }

  // Default network info if not available in instance data
  const networkInfo = instanceData.network || {
    ipv4: "10.0.0.254",
    sshLogin: "ssh ubuntu@hotmail.com",
    sshKey: "dubs",
  };

  return (
    <div className="w-full">
      <InstanceHeader
        instanceName={instanceData.name}
        instanceStatus={instanceData.status}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        onChangeImage={handleChangeImage}
        onDeleteInstance={handleDeleteInstance}
        onStartStop={handleStartStop}
        onReboot={handleReboot}
        onReinstall={handleReinstall}
      />

      {/* Display content based on activeTab */}
      <div className="animate-in fade-in duration-300">
        {activeTab === "Dashboard" ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
            <VirtualMachineInfo instance={instanceData} />
            <NetworksInfo networkInfo={networkInfo} />
          </div>
        ) : activeTab === "VNC Console" ? (
          <VncConsole instance={instanceData} />
        ) : null}
      </div>

      {/* Change Image Modal */}
      <ChangeImageModal
        open={openChangeImageModal}
        onClose={() => setOpenChangeImageModal(false)}
        onSubmit={handleImageChange}
      />

      {/* Delete Confirmation */}
      <DeleteInstanceModal />

      {/* Start/Stop Confirmation */}
      <StartStopConfirmModal />

      {/* Reboot Confirmation */}
      <RebootConfirmModal />

      {/* Reinstall Confirmation */}
      <ReinstallConfirmModal />
    </div>
  );
};

export default InstanceDetails;
