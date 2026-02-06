import { useAtomValue } from "jotai";

import { P } from "@/components/ui/typography";
import { dashboardPageHeaderAtom } from "./dashboardAtoms";

const HeaderText = () => {
  const dashHeader = useAtomValue(dashboardPageHeaderAtom);

  const headerTextKey = dashHeader.mainText + dashHeader.subText;

  return (
    <div className="flex items-center gap-4">
      <div>
        <div className="flex items-center gap-x-2">
          <P
            size="xl"
            className="animate-fade-in-from-b-0.3 opacity-0"
            key={"t" + headerTextKey}
          >
            {dashHeader.mainText}
          </P>
          {dashHeader.infoTooltip && (
            <div className="animate-fade-in-from-b-0.3 opacity-0 flex items-center">
              {dashHeader.infoTooltip}
            </div>
          )}
        </div>
        {dashHeader.subText && (
          <P
            style={{
              animationDelay: "0.2s",
            }}
            size="md"
            key={headerTextKey}
            className="mt-0.5 text-grey-50 animate-fade-in-from-b-0.3 opacity-0"
          >
            {dashHeader.subText}
          </P>
        )}
      </div>
      {dashHeader.rightContent && (
        <div className="animate-fade-in-from-b-0.3 opacity-0 flex items-center">
          {dashHeader.rightContent}
        </div>
      )}
    </div>
  );
};
export default HeaderText;
