// import { useAtomValue } from "jotai";
// import { dashboardPageHeaderAtom } from "@/global-state/ui";
import { P } from "@/components/ui/typography";

const HeaderText = () => {
  //   const dashHeader = useAtomValue(dashboardPageHeaderAtom);

  const dashHeader = {
    mainText: "Wallet",
    subText: "",
  };
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
