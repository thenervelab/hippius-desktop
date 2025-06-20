"use client";

import {
  AbstractIconWrapper,
  GoBackButton,
  Graphsheet,
  Icons,
  P,
} from "@/components/ui";

export type ResourceType = "node" | "miner" | "account" | "CID";

export interface ResourceDetailsErrorProps {
  errorType: "not-found" | "unknown";
  resourceType: ResourceType;
  backUrl: string;
}

const getErrorMessage = (
  errorType: "not-found" | "unknown",
  resourceType: ResourceType
) => {
  if (errorType === "not-found") {
    return resourceType === "CID"
      ? `${resourceType} not found`
      : "No data found.";
  }

  return resourceType === "CID"
    ? `Error tracking ${resourceType}`
    : "Sorry, An Error Occurred";
};

// Helper function for detailed error messages
const getDetailedErrorMessage = (
  errorType: "not-found" | "unknown",
  resourceType: ResourceType
) => {
  if (errorType === "unknown") {
    return resourceType === "CID"
      ? `An error occurred while tracking this ${resourceType}`
      : `An error occurred while fetching this ${resourceType.toLowerCase()}'s data`;
  }

  return resourceType === "CID"
    ? `There is no data available for this ${resourceType} at this time`
    : `There is no data available for this ${resourceType.toLowerCase()} at this time`;
};

const ResourceDetailsError: React.FC<ResourceDetailsErrorProps> = ({
  errorType,
  resourceType,
  backUrl,
}) => {
  return (
    <div className="px-6 flex justify-center items-center">
      <div className="py-6 w-full max-w-content-max">
        <GoBackButton href={backUrl} />

        <div className="py-40 flex relative flex-col items-center gap-y-2 animate-fade-in-0.5">
          <div className="absolute w-full top-0 h-full">
            <Graphsheet
              className="absolute right-0 left-0 top-0 w-full h-full"
              majorCell={{
                lineColor: [232, 237, 248, 1.0],
                lineWidth: 2,
                cellDim: 200,
              }}
              minorCell={{
                lineColor: [251, 252, 254, 1],
                lineWidth: 1,
                cellDim: 15,
              }}
            />
            <div className="bg-large-white-cloud-gradient absolute w-full h-full" />
          </div>
          <AbstractIconWrapper className="size-8 relative">
            {errorType === "not-found" && (
              <Icons.Search className="text-primary-50 size-6 absolute" />
            )}
            {errorType === "unknown" && (
              <Icons.OctagonAlert className="text-primary-50 size-6 absolute" />
            )}
          </AbstractIconWrapper>

          <P className="relative">{getErrorMessage(errorType, resourceType)}</P>

          <P
            size="sm"
            className="max-w-[300px] text-center relative text-grey-60"
          >
            {getDetailedErrorMessage(errorType, resourceType)}
          </P>
        </div>
      </div>
    </div>
  );
};

export default ResourceDetailsError;
