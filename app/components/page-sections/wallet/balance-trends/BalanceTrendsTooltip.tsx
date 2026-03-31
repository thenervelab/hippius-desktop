// BalanceTrendsTooltip.tsx
import { TooltipData } from "@visx/xychart";
import { ChartPoint } from "@/lib/types/chartTypes";

const numberFmt = (val: number) => val.toFixed(10) || "0.00";

const BalanceTrendsTooltip: React.FC<{
  tooltipData?: TooltipData<ChartPoint>;
}> = ({ tooltipData }) => {
  if (!tooltipData?.nearestDatum) return null;

  const { datum } = tooltipData.nearestDatum;

  // date line
  const date = new Date(datum.x);
  const dateDisplay =
    datum.bandLabel ??
    (!isNaN(date.getTime())
      ? date.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "");

  return (
    <div className="">
      <p className="mb-1 text-[0.625rem] font-medium text-gray-500">
        {dateDisplay}
      </p>

      {/* balance row */}
      <div className="flex items-center">
        <span className="inline-block w-2 h-2 rounded-full mr-1.5 bg-primary-40" />
        <div className="font-medium text-[0.625rem] text-grey-10">
          <span className="mr-1">Balance:</span>
          <span>{numberFmt(datum.balance)}</span>
        </div>
      </div>
    </div>
  );
};

export default BalanceTrendsTooltip;
