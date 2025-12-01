const ProgressDisplay: React.FC = () => {
  // const progress = useAtomValue(progressAtom);
  const roundedProgress = Math.round(100);
  return (
    <span className="font-digital font-normal text-[#3167DD] text-[34px] leading-[40px] overflow-hidden">
      {roundedProgress}%
    </span>
  );
};

export default ProgressDisplay;
