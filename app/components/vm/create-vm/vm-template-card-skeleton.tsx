import React from "react";
import { Skeleton } from "../../ui";

const VMTemplateCardSkeleton: React.FC = () => {
  return (
    <div className="bg-white border border-grey-80 rounded-lg overflow-hidden flex flex-col gap-4 p-0">
      {/* Header */}
      <div className="bg-white border-b border-grey-80 flex gap-2 items-center pl-4 pr-3 py-2.5">
        <Skeleton variant="circle" width="20px" height="20px" />
        <Skeleton height="24px" width="60%" />
      </div>

      {/* Content */}
      <div className="flex flex-col gap-2 px-4 pb-4">
        {/* RAM and Cores */}
        <div className="flex items-start w-full gap-4">
          {/* RAM */}
          <div className="flex-1 flex flex-col gap-2">
            <div className="flex gap-1 items-center">
              <Skeleton variant="circle" width="16px" height="16px" />
              <Skeleton height="22px" width="40px" />
            </div>
            <Skeleton height="20px" width="70%" />
          </div>

          {/* Cores */}
          <div className="flex-1 flex flex-col gap-2">
            <div className="flex gap-1 items-center">
              <Skeleton variant="circle" width="16px" height="16px" />
              <Skeleton height="22px" width="50px" />
            </div>
            <Skeleton height="20px" width="70%" />
          </div>
        </div>

        {/* Other Specifications */}
        <div className="flex flex-col gap-2 w-full">
          <div className="flex gap-1 items-center">
            <Skeleton variant="circle" width="16px" height="16px" />
            <Skeleton height="22px" width="140px" />
          </div>
          <Skeleton height="20px" width="50%" />
        </div>

        {/* Price */}
        <div className="flex flex-col gap-2 w-full">
          <div className="flex gap-1 items-center">
            <Skeleton variant="circle" width="16px" height="16px" />
            <Skeleton height="22px" width="50px" />
          </div>
          <Skeleton height="20px" width="60%" />
        </div>
      </div>
    </div>
  );
};

export default VMTemplateCardSkeleton;
