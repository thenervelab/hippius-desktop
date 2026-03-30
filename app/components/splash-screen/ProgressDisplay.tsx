import { useAtomValue } from "jotai";
import { progressAtom } from "./atoms";

const ProgressDisplay: React.FC = () => {
  const progress = useAtomValue(progressAtom);
  const roundedProgress = Math.round(progress);

  return (
    <span className="font-digital font-normal text-[#3167DD] text-[2.125rem] leading-[2.5rem] overflow-hidden tabular-nums">
      {roundedProgress}%
    </span>
  );
};

export default ProgressDisplay;
