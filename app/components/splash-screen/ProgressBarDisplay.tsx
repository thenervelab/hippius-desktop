import { useAtomValue } from "jotai";
import { ProgressBar } from "@/components/progress-bar";
import { PHASE_CONTENT } from "./SplashContent";
import { progressAtom } from "./atoms";

const contentArr = Object.values(PHASE_CONTENT);

const ProgressBarDisplay: React.FC = () => {
  const progress = useAtomValue(progressAtom);
  return <ProgressBar value={progress} segments={contentArr.length - 1} />;
};
export default ProgressBarDisplay;
