import { ChartPoint } from "@/lib/types/chartTypes";
import { TooltipData } from "@visx/xychart";
import { formatBytes } from "@/app/lib/utils/formatBytes";

const StorageUsedTooltip: React.FC<{
  tooltipData?: TooltipData<ChartPoint>;
  timeRange?: string;
}> = ({ tooltipData, timeRange }) => {
  if (!tooltipData?.nearestDatum) return null;

  const { datum } = tooltipData.nearestDatum;

  // Format date display
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

  // Format the storage size using formatBytes (exact value from API)
  const formattedSize = formatBytes(Number(datum.balance));

  return (
    <div>
      <p className="mb-1 text-[10px] font-medium text-grey-60">
        {dateDisplay}
      </p>

      <div className="font-medium text-[10px] text-grey-10">
        <span className="mr-1">Storage Used:</span>
        <span>{formattedSize}</span>
      </div>
    </div>
  );
};

export default StorageUsedTooltip;
