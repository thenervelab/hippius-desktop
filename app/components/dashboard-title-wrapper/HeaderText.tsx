import { useAtomValue } from "jotai";

import { P } from "@/components/ui/typography";
import { dashboardPageHeaderAtom } from "./dashboardAtoms";

const HeaderText = () => {
  const dashHeader = useAtomValue(dashboardPageHeaderAtom);

  const headerTextKey = dashHeader.mainText + dashHeader.subText;

  return (
    <div>
      <P
        size="xl"
        className="animate-fade-in-from-b-0.3 opacity-0"
        key={"t" + headerTextKey}
      >
        {dashHeader.mainText}
      </P>
      {dashHeader.subText && (
        <P
          style={{
            animationDelay: "0.2s",
          }}
          size="md"
          key={headerTextKey}
          className="mt-0.5 text-grey-60 animate-fade-in-from-b-0.3 opacity-0"
        >
          {dashHeader.subText}
        </P>
      )}
    </div>
  );
};
export default HeaderText;
