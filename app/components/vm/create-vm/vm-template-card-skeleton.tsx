import React from "react";
import { Skeleton } from "../../ui";

const VMTemplateCardSkeleton: React.FC = () => {
  return (
    <div className="bg-white border border-grey-80 rounded-lg overflow-hidden flex flex-col gap-4 p-0">
      {/* Header */}
      <div className="bg-white border-b border-grey-80 flex gap-2 items-center pl-4 pr-3 py-2.5">
        <Skeleton variant="circle" width="1.25rem" height="1.25rem" />
        <Skeleton height="1.5rem" width="60%" />
      </div>

      {/* Content */}
      <div className="flex flex-col gap-2 px-4 pb-4">
        {/* RAM and Cores */}
        <div className="flex items-start w-full gap-4">
          {/* RAM */}
          <div className="flex-1 flex flex-col gap-2">
            <div className="flex gap-1 items-center">
              <Skeleton variant="circle" width="1rem" height="1rem" />
              <Skeleton height="1.375rem" width="2.5rem" />
            </div>
            <Skeleton height="1.25rem" width="70%" />
          </div>

          {/* Cores */}
          <div className="flex-1 flex flex-col gap-2">
            <div className="flex gap-1 items-center">
              <Skeleton variant="circle" width="1rem" height="1rem" />
              <Skeleton height="1.375rem" width="3.125rem" />
            </div>
            <Skeleton height="1.25rem" width="70%" />
          </div>
        </div>

        {/* Other Specifications */}
        <div className="flex flex-col gap-2 w-full">
          <div className="flex gap-1 items-center">
            <Skeleton variant="circle" width="1rem" height="1rem" />
            <Skeleton height="1.375rem" width="8.75rem" />
          </div>
          <Skeleton height="1.25rem" width="50%" />
        </div>

        {/* Price */}
        <div className="flex flex-col gap-2 w-full">
          <div className="flex gap-1 items-center">
            <Skeleton variant="circle" width="1rem" height="1rem" />
            <Skeleton height="1.375rem" width="3.125rem" />
          </div>
          <Skeleton height="1.25rem" width="60%" />
        </div>
      </div>
    </div>
  );
};

export default VMTemplateCardSkeleton;
