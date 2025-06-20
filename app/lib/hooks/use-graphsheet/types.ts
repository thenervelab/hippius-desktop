import { Rgba } from "@/app/lib/types";

type CellData = {
  lineColor: Rgba;
  lineWidth: number;
  cellDim: number;
};

export type GraphsheetData = {
  majorCell: CellData;
  minorCell: CellData;
};
