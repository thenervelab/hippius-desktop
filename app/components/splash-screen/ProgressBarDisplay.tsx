import { ProgressBar } from "@/components/progress-bar";
import { PHASE_CONTENT } from "./SplashContent";
import { progressAtom } from "./atoms";
import { useAtomValue } from "jotai";

const totalPhases = Object.keys(PHASE_CONTENT).length;

const ProgressBarDisplay: React.FC = () => {
  const progress = useAtomValue(progressAtom);
  return <ProgressBar value={progress} segments={totalPhases} fillClass="bg-[#3167DD]" pulseClass="animate-pulse" />;
};
export default ProgressBarDisplay;
