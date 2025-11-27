import React from "react";
import Lock from "../../ui/icons/Lock";

const VPNStatusIndicator = () => {
  return (
    <div className="flex items-center justify-center gap-3  animate-in fade-in slide-in-from-top-2 duration-300">
      {/* Connected Part */}
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-2  rounded-lg ">
          <span className="p-1 rounded-full bg-success-70">
            <span className="block w-1.5 h-1.5 rounded-full bg-success-50"></span>
          </span>
        </span>
        <span className="font-medium text-[15px] leading-5 text-grey-10">
          Connected
        </span>
      </div>

      {/* Divider */}
      <div className="w-[1px] h-5 bg-grey-70" />

      {/* Encrypted Part */}
      <div className="flex items-center gap-2">
        <Lock className="w-3.5 h-3.5 text-grey-10" />
        <span className="font-medium text-[15px] leading-5 text-grey-10">
          Encrypted
        </span>
      </div>
    </div>
  );
};

export default VPNStatusIndicator;
