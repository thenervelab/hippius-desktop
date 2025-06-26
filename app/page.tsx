"use client";
import { Metadata } from "next";
import { createMetadata } from "@/lib/utils";
import {
  BarChart3,
  CheckCircle,
  Upload,
  Download,
  Info,
  FileText,
} from "lucide-react";
import BlockchainStats from "@/components/blockchain-stats";
import SearchBar from "@/components/search-bar";
import { Icons } from "./components/ui";

export default async function Home() {
  return (
    <div className="flex flex-col space-y-6">
      <BlockchainStats />
      <SearchBar />

      <section>
        <h1 className="text-2xl font-semibold mb-1">Welcome to Hippius</h1>
        <p className="text-gray-500">
          Monitor your IPFS node status and performance
        </p>
      </section>
      <Icons.CentralizedDataBase className="h-[156px] w-[225px]" />

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
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
              <span className="text-2xl font-bold">413</span>
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
                Peer ID: 441.013
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
            <p className="text-sm font-medium text-gray-500">Download Speed</p>
            <div className="flex items-baseline mt-1">
              <span className="text-2xl font-bold">4.1</span>
              <span className="ml-3 text-xs text-red-500">
                20% decrease in 24 hours
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Charts Section */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Credit Usage Chart */}
        <div className="bg-white p-5 rounded-lg border border-gray-100 shadow-sm">
          <div className="flex justify-between items-center mb-4">
            <div className="flex items-center">
              <div className="w-6 h-6 bg-blue-50 rounded-full flex items-center justify-center mr-2">
                <span className="text-blue-600 text-sm">$</span>
              </div>
              <h3 className="font-medium">Credit Usage</h3>
            </div>
            <div className="text-sm bg-gray-50 px-3 py-1 rounded">
              This Week
            </div>
          </div>
          <div>
            <div className="mb-2">
              <div className="text-sm text-gray-500">Total Credits Used</div>
              <div className="text-2xl font-bold">413,0000</div>
            </div>
            <div className="h-48 bg-gray-50 flex items-center justify-center">
              <span className="text-gray-400">Credit Usage Chart Here</span>
            </div>
          </div>
        </div>

        {/* Storage Usage Chart */}
        <div className="bg-white p-5 rounded-lg border border-gray-100 shadow-sm">
          <div className="flex justify-between items-center mb-4">
            <div className="flex items-center">
              <div className="w-6 h-6 bg-blue-50 rounded-full flex items-center justify-center mr-2">
                <span className="text-blue-600 text-sm">S</span>
              </div>
              <h3 className="font-medium">Storage Usage</h3>
            </div>
            <div className="text-sm bg-gray-50 px-3 py-1 rounded">
              This Week
            </div>
          </div>
          <div className="flex items-center justify-center h-48">
            <div className="text-center">
              <div className="text-4xl font-bold">20</div>
              <div className="text-xs text-gray-500">Total Files</div>
              <div className="text-xs text-gray-500">0.01 MB</div>
              <div className="mt-2 text-gray-400">
                Storage Usage Pie Chart Here
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Files */}
      <div>
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-medium text-lg">Recent Files</h3>
          <div className="flex space-x-2">
            <button className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm">
              Upload File
            </button>
          </div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Name
                </th>
                <th className="py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Size
                </th>
                <th className="py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Date Accessed
                </th>
                <th className="py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Location
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              <tr>
                <td className="px-4 py-4 whitespace-nowrap">
                  <div className="flex items-center">
                    <FileText size={16} className="text-blue-500 mr-2" />
                    <span className="text-sm font-medium">
                      The IPFS Whitepaper.pdf
                    </span>
                  </div>
                </td>
                <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-500">
                  1.2 MB
                </td>
                <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-500">
                  06/23/24 3:41 PM
                </td>
                <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-500">
                  /Documents/
                </td>
              </tr>
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-12 text-center text-gray-500"
                >
                  No more files to display
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
