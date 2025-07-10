import { ChartPoint } from "@/app/lib/utils/getFormatDataForCreditsUsageChart";
import { TooltipData } from "@visx/xychart";
import { formatBytes } from "@/app/lib/utils/formatBytes";

const StorageUsedTooltip: React.FC<{
  tooltipData?: TooltipData<ChartPoint>;
}> = ({ tooltipData }) => {
  if (!tooltipData?.nearestDatum) return null;

  const { datum } = tooltipData.nearestDatum;

  // Format date display
  let dateDisplay = "";
  if (datum.bandLabel) {
    dateDisplay = datum.bandLabel;
  } else if (datum.x instanceof Date) {
    dateDisplay = datum.x.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  // Format the storage size using formatBytes
  const formattedSize = formatBytes(Number(datum.balance));

  return (
    <div>
      <p className="mb-1 text-[10px] font-medium text-gray-500">
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
