import React from "react";
import { Skeleton } from "../../ui";

const VMTemplateCardSkeleton: React.FC = () => {
  return (
    <div className="bg-grey-light-100 border border-grey-dark-100 rounded-[8px] overflow-hidden flex flex-col items-center gap-[14px] pb-[8px] dark:bg-black-600 dark:border-black-300">
      {/* Header */}
      <div className="bg-grey-light-300 border-b-[0.884px] border-grey-dark-100 shadow-[0px_0.884px_0px_0px_white] flex gap-[8px] items-center px-[8px] py-[8.842px] w-full dark:bg-black-primary-bg dark:border-black-300 dark:shadow-[0px_0.884px_0px_0px_rgba(255,255,255,0.06)]">
        <Skeleton variant="circle" width="18px" height="18px" />
        <Skeleton height="20px" width="60%" />
      </div>

      {/* Content */}
      <div className="flex flex-col gap-[12px] px-[8px] w-full">
        {/* RAM and Cores */}
        <div className="flex items-start w-full">
          {/* RAM */}
          <div className="flex-1 flex flex-col gap-[1.768px] min-w-0">
            <div className="flex gap-[3.537px] items-center">
              <Skeleton variant="circle" width="14px" height="14px" />
              <Skeleton height="19px" width="36px" />
            </div>
            <Skeleton height="17px" width="70%" />
          </div>

          {/* Cores */}
          <div className="flex-1 flex flex-col gap-[1.768px] min-w-0">
            <div className="flex gap-[3.537px] items-center">
              <Skeleton variant="circle" width="14px" height="14px" />
              <Skeleton height="19px" width="44px" />
            </div>
            <Skeleton height="17px" width="70%" />
          </div>
        </div>

        {/* Other Specifications */}
        <div className="flex flex-col gap-[1.768px] w-full">
          <div className="flex gap-[3.537px] items-center">
            <Skeleton variant="circle" width="14px" height="14px" />
            <Skeleton height="19px" width="128px" />
          </div>
          <Skeleton height="17px" width="50%" />
        </div>

        {/* Price */}
        <div className="flex flex-col gap-[1.768px] w-full">
          <div className="flex gap-[3.537px] items-center">
            <Skeleton variant="circle" width="14px" height="14px" />
            <Skeleton height="19px" width="44px" />
          </div>
          <Skeleton height="17px" width="60%" />
        </div>
      </div>
    </div>
  );
};

export default VMTemplateCardSkeleton;
