import { Icons } from "../../ui";
import DetailsCard from "./DetailsCard";

type IpfsInfo = {
  ID?: string;
  Addresses?: string[];
  AgentVersion?: string;
  ProtocolVersion?: string;
};

interface DetailListProps {
  ipfsInfo: IpfsInfo | null;
  upload: string;
  download: string;
}

function shortId(id?: string) {
  if (!id || id.length <= 8) return id || "";
  return `${id.slice(0, 3)}...${id.slice(-3)}`;
}

export default function DetailList({
  ipfsInfo,
  upload,
  download,
}: DetailListProps) {
  const detailCards = [
    {
      id: "network-connections",
      icon: Icons.WifiSquare,
      title: "Network Connections",
      value: ipfsInfo?.Addresses?.length ?? "--",
      subtitle: "Active Network Connections",
      showInfo: false,
    },
    {
      id: "node-status",
      icon: Icons.ShieldTick,
      title: "Node Status",
      value:
        ipfsInfo === null ? "Loading..." : ipfsInfo.ID ? "Online" : "Offline",
      isOnline: ipfsInfo?.ID ? true : false,
      peerId: `${ipfsInfo?.ID ? shortId(ipfsInfo.ID) : "Loading..."}`,
      showStatus: true,
      showInfo: false,
    },
    {
      id: "upload-speed",
      icon: Icons.DocumentUpload,
      title: "Upload Speed",
      value: upload,
      showInfo: false,
    },
    {
      id: "download-speed",
      icon: Icons.DocumentDownload,
      title: "Download Speed",
      value: download,
      showInfo: false,
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
      {detailCards.map((card) => (
        <DetailsCard
          key={card.id}
          icon={card.icon}
          title={card.title}
          value={card.value}
          subtitle={card.subtitle}
          showStatus={card.showStatus}
          isOnline={card.isOnline}
          peerId={card.peerId}
          showInfo={card.showInfo}
        />
      ))}
    </div>
  );
}
