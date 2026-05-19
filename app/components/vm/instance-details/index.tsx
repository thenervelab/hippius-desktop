"use client";
import React, { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import InstanceHeader from "./instance-header";
import VirtualMachineInfo from "./virtual-machine-info";
import NetworksInfo from "./networks-info";
import VncConsole from "./vnc-console";
import useVMInstanceDetails from "@/app/lib/hooks/api/useVMInstanceDetails";
import NoEntriesFound from "../../ui/NoEntriesFound";

const InstanceDetails: React.FC = () => {
  const searchParams = useSearchParams();
  const instanceId = searchParams.get("instanceId");
  const [activeTab, setActiveTab] = useState<string>("Dashboard");

  // Fetch instance details from API
  const {
    data: instanceData,
    isLoading: isLoading,
    isFetching: isFetching,
    error,
    refetch,
  } = useVMInstanceDetails(instanceId as string);
  const loading = isLoading || isFetching;

  useEffect(() => {
    const tab = searchParams.get("tab");
    if (tab === "console") {
      setActiveTab("Console");
    }
  }, [searchParams]);

  const handleTabChange = (tabName: string) => {
    setActiveTab(tabName);
  };

  if (error) {
    return (
      <NoEntriesFound
        title="Failed to load instance"
        description={
          error instanceof Error ? error.message : "An error occurred"
        }
      />
    );
  }

  // Only show "not found" after loading is complete and there's no data
  if (!loading && !instanceData) {
    return (
      <NoEntriesFound
        title="Instance not found"
        description="The instance you're looking for doesn't exist or has been deleted."
      />
    );
  }

  return (
    <div className="w-full">
      <InstanceHeader
        instanceName={instanceData?.name}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        isLoading={loading}
        onRefresh={() => refetch()}
        isRefetching={isFetching}
      />

      {/* Display content based on activeTab */}
      <div className="animate-in fade-in duration-300">
        {activeTab === "Dashboard" ? (
          <div className="grid grid-cols-1 @md:grid-cols-2 gap-4 items-start">
            <VirtualMachineInfo
              instanceData={instanceData}
              isLoading={loading}
              onRefresh={() => refetch()}
            />
            <NetworksInfo instanceData={instanceData} isLoading={loading} />
          </div>
        ) : activeTab === "Console" ? (
          <VncConsole
            instance={
              instanceData
                ? {
                    id: instanceData.id,
                    uuid: instanceData.uuid,
                    name: instanceData.name,
                    status: instanceData.status,
                    flavor: instanceData.flavor.name,
                    image: instanceData.image,
                    public_ip: instanceData.public_ip,
                    nebula_ip: instanceData.nebula_ip || null,
                    created_at: instanceData.created_at,
                  }
                : undefined
            }
            isLoading={loading}
          />
        ) : null}
      </div>
    </div>
  );
};

export default InstanceDetails;
