import React from "react";
import InfoPanel from "./info-panel";
import LabelWithIcon from "./label-with-icon";
import CopyableText from "../../ui/CopyableText";
import { Icons } from "../../ui";
import { ShieldTick } from "../../ui/icons";

interface NetworksInfoProps {
  networkInfo: {
    ipv4: string;
    sshLogin: string;
    sshKey: string;
  };
}

const NetworksInfo: React.FC<NetworksInfoProps> = ({ networkInfo }) => {
  return (
    <InfoPanel
      title="Networks"
      icon={<Icons.Cloud className="size-6 relative text-primary-50" />}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-y-6 gap-x-4">
        {/* Internet Protocol */}
        <div className="">
          <LabelWithIcon
            icon={<Icons.CloudAdd className="size-4" />}
            label="Internet Protocol"
          />
          <CopyableText
            value={networkInfo.ipv4}
            displayMode="truncate"
            textClassName="text-grey-20 font-medium"
            iconClassName="text-grey-50 p-1 bg-grey-90 rounded w-6 h-6"
            maxWidth="w-full"
          />
        </div>

        {/* Login Information */}
        <div className="">
          <LabelWithIcon
            icon={<ShieldTick className="size-4" />}
            label="Login Information"
          />

          <CopyableText
            value={networkInfo.sshLogin}
            displayMode="truncate"
            textClassName="text-grey-20 font-medium"
            iconClassName="text-grey-50 p-1 bg-grey-90 rounded w-6 h-6"
            maxWidth="w-full"
          />
        </div>
        <div>
          <LabelWithIcon
            icon={<Icons.ShieldSecurity className="size-4" />}
            label="SSH Key"
          />
          <div className="text-grey-10 font-semibold text-base mt-2">
            {networkInfo.sshKey}
          </div>
        </div>
      </div>
    </InfoPanel>
  );
};

export default NetworksInfo;
