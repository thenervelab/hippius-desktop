import { Icons } from "@/components/ui";
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
      info: "Shows the number of active network addresses your IPFS node is listening on. Multiple addresses indicate better network connectivity and peer discovery.",
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
      info: "Indicates whether your IPFS node is running and connected to the network. When online, you can upload, download, and share files on the distributed network.",
    },
    {
      id: "upload-speed",
      icon: Icons.DocumentUpload,
      title: "Upload Speed",
      value: upload,
      info: "Real-time upload speed showing how fast data is being sent from your node to the IPFS network. This includes file uploads and data sharing with other peers.",
    },
    {
      id: "download-speed",
      icon: Icons.DocumentDownload,
      title: "Download Speed",
      value: download,
      info: "Real-time download speed showing how fast data is being received by your node from the IPFS network. This includes file downloads and data synchronization.",
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
          info={card.info}
        />
      ))}
    </div>
  );
}
