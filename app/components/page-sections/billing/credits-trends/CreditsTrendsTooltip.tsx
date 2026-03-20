import { TooltipData } from "@visx/xychart";
import { ChartPoint } from "@/lib/types/chartTypes";

const numberFmt = (val: number) => val.toFixed(10) || "0.00";

const CreditsTrendsTooltip: React.FC<{
  tooltipData?: TooltipData<ChartPoint>;
  timeRange?: string;
}> = ({ tooltipData, timeRange }) => {
  if (!tooltipData?.nearestDatum) return null;

  const { datum } = tooltipData.nearestDatum;

  // date line
  let dateDisplay = "";
  const date = new Date(datum.x);
  if (!isNaN(date.getTime())) {
    // Format based on time range
    if (timeRange === "last7days") {
      dateDisplay = date.toLocaleDateString("en-US", {
        weekday: "long",
        month: "short",
        day: "numeric",
      });
    } else {
      dateDisplay = date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }
  } else if (datum.bandLabel) {
    dateDisplay = datum.bandLabel;
  }

  return (
    <div className="">
      <p className="mb-1 text-[10px] font-medium text-grey-60">
        {dateDisplay}
      </p>

      {/* credit row */}
      <div className="flex items-center">
        <span className="inline-block w-2 h-2 rounded-full mr-1.5 bg-primary-40" />
        <div className="font-medium text-[10px] text-grey-10">
          <span className="mr-1">Credits:</span>
          <span>{numberFmt(datum.credit ?? 0)}</span>
        </div>
      </div>
    </div>
  );
};

export default CreditsTrendsTooltip;
