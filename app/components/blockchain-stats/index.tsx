"use client";

import { Database, ChevronDown } from "lucide-react";

const BlockchainStats: React.FC = () => {
  return (
    <div className="flex space-x-4 mb-6">
      <div className="flex items-center space-x-2">
        <Database size={16} className="text-gray-500" />
        <span className="text-xs text-gray-500">Storage:</span>
        <span className="text-xs bg-gray-100 px-2 py-1 rounded-full">189 Peers</span>
      </div>
      
      <div className="flex items-center space-x-2">
        <span className="text-xs text-gray-500">Blockchain:</span>
        <span className="text-xs bg-gray-100 px-2 py-1 rounded-full">189 Peers</span>
      </div>
      
      <div className="flex items-center space-x-2">
        <span className="text-xs text-gray-500">Block Number:</span>
        <span className="text-xs bg-gray-100 px-2 py-1 rounded-full">41413001</span>
      </div>
    </div>
  );
};

export default BlockchainStats;
