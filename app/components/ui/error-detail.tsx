"use client";

import {
  AbstractIconWrapper,
  GoBackButton,
  Graphsheet,
  Icons,
  P,
} from "@/components/ui";

const ErrorDetail: React.FC<{ errorType: "not-found" | "unknown", backLink: string }> = ({
  errorType,
  backLink
}) => {
  return (
    <div className="px-6 flex justify-center items-center">
      <div className="py-6 w-full max-w-content-max">
        <GoBackButton href={backLink} />

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

          <P className="relative">
            {errorType === "not-found" && "No data found."}
            {errorType === "unknown" && "Sorry, An Error Occured"}
          </P>

          <P
            size="sm"
            className="max-w-[300px] text-center relative text-grey-60"
          >
            {errorType === "unknown" &&
              "An error occurred while fetching this block's data"}
            {errorType === "not-found" &&
              "There is no data available for this block at this time"}
          </P>
        </div>
      </div>
    </div>
  );
};

export default ErrorDetail;
