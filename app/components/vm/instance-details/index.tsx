"use client";
import React, { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import InstanceHeader from "./instance-header";
import VirtualMachineInfo from "./virtual-machine-info";
import NetworksInfo from "./networks-info";
import VncConsole from "./vnc-console";
import ChangeImageModal from "./change-image-modal";
import { useDeleteInstance } from "../hooks/useDeleteInstance";
import { useStartStopInstance } from "../hooks/useStartStopInstance";
import { useRebootInstance } from "../hooks/useRebootInstance";
import { useReinstallInstance } from "../hooks/useReinstallInstance";
import useVMInstanceDetails from "@/app/lib/hooks/api/useVMInstanceDetails";

const InstanceDetails: React.FC = () => {
  const searchParams = useSearchParams();
  const instanceId = searchParams.get("instanceId");
  const [activeTab, setActiveTab] = useState<string>("Dashboard");
  const [openChangeImageModal, setOpenChangeImageModal] = useState(false);

  // Fetch instance details from API
  const {
    data: instanceData,
    isLoading: isLoading,
    isFetching: isFetching,
    error,
    refetch,
  } = useVMInstanceDetails(instanceId as string);
  const loading = isLoading || isFetching;
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
    if (!instanceData) return;
    const instance = {
      id: instanceData.id,
      uuid: instanceData.uuid,
      name: instanceData.name,
      status: instanceData.status,
      flavor: instanceData.flavor.name,
      image: instanceData.image,
      public_ip: instanceData.public_ip,
      nebula_ip: instanceData.nebula_ip,
      created_at: instanceData.created_at,
    };
    handleStartStopInstance(instance, instanceData.status);
  };

  const handleReboot = () => {
    if (!instanceData) return;
    const instance = {
      id: instanceData.id,
      uuid: instanceData.uuid,
      name: instanceData.name,
      status: instanceData.status,
      flavor: instanceData.flavor.name,
      image: instanceData.image,
      public_ip: instanceData.public_ip,
      nebula_ip: instanceData.nebula_ip,
      created_at: instanceData.created_at,
    };
    handleRebootInstance(instance);
  };

  const handleReinstall = () => {
    if (!instanceData) return;
    const instance = {
      id: instanceData.id,
      uuid: instanceData.uuid,
      name: instanceData.name,
      status: instanceData.status,
      flavor: instanceData.flavor.name,
      image: instanceData.image,
      public_ip: instanceData.public_ip,
      nebula_ip: instanceData.nebula_ip,
      created_at: instanceData.created_at,
    };
    handleReinstallInstance(instance);
  };

  const handleImageChange = (data: {
    operatingSystem: string;
    image: string;
  }) => {
    console.log("Changing image to:", data);
    setOpenChangeImageModal(false);
  };

  if (error) {
    return (
      <div className="w-full py-12">
        <div className="text-center">
          <h2 className="text-lg font-medium text-grey-20">
            Failed to load instance
          </h2>
          <p className="text-grey-60 mt-2">
            {error instanceof Error ? error.message : "An error occurred"}
          </p>
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
            The instance you&apos;re looking for doesn&apos;t exist or has been
            deleted.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full">
      <InstanceHeader
        instanceName={instanceData.name}
        instanceStatus={instanceData.status}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        onChangeImage={handleChangeImage}
        onDeleteInstance={() =>
          handleDeleteInstance({
            id: instanceData.id,
            uuid: instanceData.uuid,
            name: instanceData.name,
            status: instanceData.status,
            flavor: instanceData.flavor.name,
            image: instanceData.image,
            public_ip: instanceData.public_ip,
            nebula_ip: instanceData.nebula_ip,
            created_at: instanceData.created_at,
          })
        }
        onStartStop={handleStartStop}
        onReboot={handleReboot}
        onReinstall={handleReinstall}
        onRefresh={() => refetch()}
      />

      {/* Display content based on activeTab */}
      <div className="animate-in fade-in duration-300">
        {activeTab === "Dashboard" ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
            <VirtualMachineInfo
              instanceData={instanceData}
              isLoading={loading}
            />
            <NetworksInfo instanceData={instanceData} isLoading={loading} />
          </div>
        ) : activeTab === "VNC Console" ? (
          <VncConsole
            instance={{
              id: instanceData.id,
              uuid: instanceData.uuid,
              name: instanceData.name,
              status: instanceData.status,
              flavor: instanceData.flavor.name,
              image: instanceData.image,
              public_ip: instanceData.public_ip,
              nebula_ip: instanceData.nebula_ip,
              created_at: instanceData.created_at,
            }}
          />
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
