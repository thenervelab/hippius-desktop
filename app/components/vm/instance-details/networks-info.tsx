import React from "react";
import InfoPanel from "./info-panel";
import LabelWithIcon from "./label-with-icon";
import { Icons } from "../../ui";
import { VMInstanceDetailsResponse } from "@/app/lib/hooks/api/useVMInstanceDetails";
import Skeleton from "@/components/ui/skeleton";
import { CopyableCell } from "../../ui/alt-table";

interface NetworksInfoProps {
  instanceData?: VMInstanceDetailsResponse;
  isLoading: boolean;
}

const NetworksInfo: React.FC<NetworksInfoProps> = ({
  instanceData,
  isLoading,
}) => {
  return (
    <InfoPanel
      title="Networks"
      icon={<Icons.Cloud className="size-6 relative text-primary-50" />}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-y-6 gap-x-4">
        {/* Public IP */}
        <div className="">
          <LabelWithIcon
            icon={<Icons.CloudAdd className="size-4" />}
            label="Public IP"
          />
          {isLoading ? (
            <Skeleton className="!h-[26px] !w-[150px] mt-1" />
          ) : (
            <div className="text-grey-20 font-medium text-base mt-1">
              {instanceData?.public_ip || "—"}
            </div>
          )}
        </div>

        {/* Nebula IP */}
        <div className="">
          <LabelWithIcon
            icon={<Icons.CloudConnection className="size-4" />}
            label="Nebula IP"
          />
          {isLoading ? (
            <Skeleton className="!h-[26px] !w-[150px] mt-1" />
          ) : (
            <div className="text-grey-20 font-medium text-base mt-1">
              {instanceData?.nebula_ip || "—"}
            </div>
          )}
        </div>

        {/* SSH Public Key */}
        <div className="col-span-1 md:col-span-2">
          <LabelWithIcon
            icon={<Icons.ShieldSecurity className="size-4" />}
            label="SSH Public Key"
          />
          {isLoading ? (
            <Skeleton className="!h-[26px] !w-[200px] mt-2" />
          ) : (
            <CopyableCell
              title="Copy Public Key"
              toastMessage="Public Key Copied Successfully!"
              copyAbleText={
                instanceData?.ssh_public_key ? instanceData.ssh_public_key : "—"
              }
              numberOfCharactersFromStartAndEnd={30}
              className=" w-full text-grey-20 font-medium"
              copyIconClassName="text-grey-50 p-1 bg-grey-90 rounded w-6 h-6"
              checkIconClassName="text-grey-50 p-1 bg-grey-90 rounded w-6 h-6"
            />
          )}
        </div>
      </div>
    </InfoPanel>
  );
};

export default NetworksInfo;
