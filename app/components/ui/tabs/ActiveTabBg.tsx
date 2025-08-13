import React from "react";
import { Graphsheet } from "..";

interface ActiveTabBgProps {
  mainGroup: boolean;
}

const ActiveTabBg: React.FC<ActiveTabBgProps> = ({ mainGroup }) => (
  <div className="absolute w-full h-full right-0 left-0">
    <Graphsheet
      majorCell={{
        lineColor: [31, 80, 189, 1.0],
        lineWidth: 2,
        cellDim: 40,
      }}
      minorCell={{
        lineColor: [49, 103, 211, 1.0],
        lineWidth: 1,
        cellDim: 5,
      }}
      className="absolute w-full h-full top-0 bottom-0 left-0 opacity-20"
    />
    <div className="absolute w-full h-full">
      {mainGroup && (
        <>
          <div className="size-1.5 border border-primary-50 border-r-0 border-b-0 absolute left-0 top-0" />
          <div className="size-1.5 border border-primary-50 border-r-0 border-t-0 absolute left-0 bottom-0" />
        </>
      )}
      <div className="size-1.5 border border-primary-50 border-l-0 border-t-0 absolute right-0 bottom-0" />
      <div className="size-1.5 border border-primary-50 border-l-0 border-b-0 absolute right-0 top-0" />
    </div>
  </div>
);

export default ActiveTabBg;
