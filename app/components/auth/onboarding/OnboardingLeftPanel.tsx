import { InView } from "react-intersection-observer";
import BackgroundRings from "./BackgroundRings";
import LeftPanelItem from "./LeftPanelItem";
import { ONBOARDING_SCREENS } from "./onboardingData";

interface OnboardingLeftPanelProps {
  currentPanelIndex: number;
}

const OnboardingLeftPanel = ({
  currentPanelIndex
}: OnboardingLeftPanelProps) => {
  const currentPanel = ONBOARDING_SCREENS[currentPanelIndex];

  return (
    <InView key={currentPanelIndex}>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className="
            relative
            w-full
            h-full
            rounded-lg
            bg-primary-100
            overflow-hidden
            pt-8
          "
        >
          {/* Background layer */}
          <BackgroundRings />

          {/* Content */}
          <LeftPanelItem
            titleText={currentPanel.titleText}
            description={currentPanel.description}
            imagePath={currentPanel.imagePath}
            imageMarginBottom={currentPanel.imageMarginBottom}
            inView={inView}
            imagClassName={currentPanel.imageClassName}
          />
        </div>
      )}
    </InView>
  );
};

export default OnboardingLeftPanel;
