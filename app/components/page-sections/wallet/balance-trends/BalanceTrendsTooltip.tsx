import { TooltipData } from "@visx/xychart";
import { ChartPoint } from "@/app/lib/utils/getFormatDataForAccountsChart";

const BalanceTrendsTooltip: React.FC<{
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
  const formattedBalance = datum.balance.toFixed(10) || "0.00";

  return (
    <div>
      <p className="mb-2 text-grey-70 font-medium text-sm">{dateDisplay}</p>
      <div className="flex text-xs flex-col gap-y-3">
        <div>
          Balance:{" "}
          <span className="text-primary-40 font-semibold">
            {formattedBalance}
          </span>
        </div>
      </div>
    </div>
  );
};

export default BalanceTrendsTooltip;
