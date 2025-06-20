"use client";

import { useEffect } from "react";

import { useGraphSheet } from "@/app/lib/hooks";

import Graphsheet from "./Graphsheet";

import { GraphsheetData } from "@/app/lib/hooks/use-graphsheet/types";
import { GraphsheetSharedProps } from "./types";

const GraphSheetContainer: React.FC<
  { onLoad?: () => void } & Partial<GraphsheetData> & GraphsheetSharedProps
> = ({ onLoad, ...rest }) => {
  const { loaded, ...useGraphRestProps } = useGraphSheet(rest);

  useEffect(() => {
    if (loaded && onLoad) {
      onLoad();
    }
  }, [loaded, onLoad]);
  return (
    <Graphsheet
      loaded={loaded}
      className={rest.className}
      {...useGraphRestProps}
    />
  );
};

export default GraphSheetContainer;
