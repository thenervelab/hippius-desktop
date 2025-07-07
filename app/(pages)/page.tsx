"use client";
// import {
//   BarChart3,
//   CheckCircle,
//   Upload,
//   Download,
//   Info,
//   FileText,
// } from "lucide-react";
import { useEffect } from "react";
import DashboardTitleWrapper from "../components/dashboard-title-wrapper";
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
// import IpfsTest from "@/components/upload-download";

// type IpfsInfo = {
//   ID?: string;
//   Addresses?: string[];
//   AgentVersion?: string;
//   ProtocolVersion?: string;
//   // [key: string]: any;
// };

// function shortId(id?: string) {
//   if (!id || id.length <= 8) return id || "";
//   return `${id.slice(0, 8)}........${id.slice(-8)}`;
// }

// function useIpfsInfo() {
//   const [ipfsInfo, setIpfsInfo] = useState<IpfsInfo | null>(null);

//   useEffect(() => {
//     fetch("http://127.0.0.1:5001/api/v0/id", { method: "POST" })
//       .then((res) => res.json())
//       .then(setIpfsInfo)
//       .catch(() => setIpfsInfo(null));
//   }, []);

//   return ipfsInfo;
// }

export default function Home() {
  const { polkadotAddress } = useWalletAuth();
  // const ipfsInfo = useIpfsInfo();

  useEffect(() => {
    if (polkadotAddress) {
      invoke("start_user_profile_sync_tauri", { accountId: polkadotAddress });
      invoke("start_folder_sync_tauri", { accountId: polkadotAddress });
    }
  }, [polkadotAddress]);

  return (
    <DashboardTitleWrapper mainText="">
      <div className="flex flex-col space-y-6">
        <section>
          <h1 className="text-2xl font-semibold mb-1">Welcome to Hippius</h1>
          <p className="text-gray-500">
            Monitor your IPFS node status and performance
          </p>
        </section>

        {/* Stats Cards */}
        {/* <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white p-4 rounded-lg border border-gray-100 shadow-sm">
            <div className="flex justify-between items-center">
              <div className="w-8 h-8 bg-blue-50 rounded-md flex items-center justify-center">
                <BarChart3 size={20} className="text-blue-600" />
              </div>
              <Info size={16} className="text-gray-300" />
            </div>
            <div className="mt-3">
              <p className="text-sm font-medium text-gray-500">
                Network Connections
              </p>
              <div className="flex items-baseline mt-1">
                <span className="text-2xl font-bold">
                  {ipfsInfo?.Addresses?.length ?? "—"}
                </span>
                <span className="ml-2 text-xs text-gray-500">
                  Active Network Connections
                </span>
              </div>
            </div>
          </div>

          <div className="bg-white p-4 rounded-lg border border-gray-100 shadow-sm">
            <div className="flex justify-between items-center">
              <div className="w-8 h-8 bg-blue-50 rounded-md flex items-center justify-center">
                <CheckCircle size={20} className="text-blue-600" />
              </div>
              <Info size={16} className="text-gray-300" />
            </div>
            <div className="mt-3">
              <p className="text-sm font-medium text-gray-500">Node Status</p>
              <div className="flex items-center mt-1">
                <div className="flex items-center">
                  <div className="w-2 h-2 bg-green-500 rounded-full mr-2"></div>
                  <span className="text-2xl font-bold">Online</span>
                </div>
                <span className="ml-4 text-xs text-gray-500">
                  Peer ID: {ipfsInfo?.ID ? shortId(ipfsInfo.ID) : "Loading..."}
                </span>
              </div>
            </div>
          </div>

          <div className="bg-white p-4 rounded-lg border border-gray-100 shadow-sm">
            <div className="flex justify-between items-center">
              <div className="w-8 h-8 bg-blue-50 rounded-md flex items-center justify-center">
                <Upload size={20} className="text-blue-600" />
              </div>
              <Info size={16} className="text-gray-300" />
            </div>
            <div className="mt-3">
              <p className="text-sm font-medium text-gray-500">Upload Speed</p>
              <div className="flex items-baseline mt-1">
                <span className="text-2xl font-bold">4.1</span>
                <span className="ml-3 text-xs text-green-500">
                  20% increase in 24 hours
                </span>
              </div>
            </div>
          </div>

          <div className="bg-white p-4 rounded-lg border border-gray-100 shadow-sm">
            <div className="flex justify-between items-center">
              <div className="w-8 h-8 bg-blue-50 rounded-md flex items-center justify-center">
                <Download size={20} className="text-blue-600" />
              </div>
              <Info size={16} className="text-gray-300" />
            </div>
            <div className="mt-3">
              <p className="text-sm font-medium text-gray-500">
                Download Speed
              </p>
              <div className="flex items-baseline mt-1">
                <span className="text-2xl font-bold">4.1</span>
                <span className="ml-3 text-xs text-red-500">
                  20% decrease in 24 hours
                </span>
              </div>
            </div>
          </div>
        </div> */}

        {/* IPFS Upload/Download Test */}
        {/* <section>
        <h2 className="text-xl font-semibold mb-2">IPFS Encrypted Upload/Download Test</h2>
        <IpfsTest />
      </section> */}

      </div>
    </DashboardTitleWrapper>
  );
}
