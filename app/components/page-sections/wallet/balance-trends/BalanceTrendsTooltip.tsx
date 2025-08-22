// BalanceTrendsTooltip.tsx
import { TooltipData } from "@visx/xychart";
import { ChartPoint } from "@/app/lib/utils/getFormatDataForAccountsChart";

const numberFmt = (val: number) => val.toFixed(10) || "0.00";

const BalanceTrendsTooltip: React.FC<{
  tooltipData?: TooltipData<ChartPoint>;
}> = ({ tooltipData }) => {
  if (!tooltipData?.nearestDatum) return null;

  const { datum } = tooltipData.nearestDatum;

  // date line
  const dateDisplay =
    datum.bandLabel ??
    (datum.x instanceof Date
      ? datum.x.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
      : "");

  return (
    <div className="">
      <p className="mb-1 text-[10px] font-medium text-gray-500">
        {dateDisplay}
      </p>

      {/* balance row */}
      <div className="flex items-center">
        <span className="inline-block w-2 h-2 rounded-full mr-1.5 bg-primary-40" />
        <div className="font-medium text-[10px] text-grey-10">
          <span className="mr-1">Balance:</span>
          <span>{numberFmt(datum.balance)}</span>
        </div>
      </div>
    </div>
  );
};

export default BalanceTrendsTooltip;
