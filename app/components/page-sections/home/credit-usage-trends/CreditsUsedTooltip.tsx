import { ChartPoint } from "@/app/lib/utils/getFormatDataForCreditsUsageChart";
import { TooltipData } from "@visx/xychart";

const CreditUsedTooltip: React.FC<{
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

  // Format the balance with number formatting
  const formattedBalance = datum.balance.toFixed(6) || "0.00";

  return (
    <div>
      <p className="mb-1 text-[10px] font-medium text-gray-500">
        {dateDisplay}
      </p>

      <div className="font-medium text-[10px] text-grey-10">
        <span className="mr-1">Credits:</span>
        <span>{formattedBalance}</span>
      </div>
    </div>
  );
};

export default CreditUsedTooltip;
