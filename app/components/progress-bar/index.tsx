export const ProgressBar = ({ value = 0, segments = 5 }) => {
  const segPercent = 100 / segments;

  return (
    <div className="flex gap-[2px] w-[580px] h-3 bg-transparent overflow-hidden">
      {Array.from({ length: segments }).map((_, idx) => {
        const start = idx * segPercent;
        const end = (idx + 1) * segPercent;
        let fill = 0;
        if (value >= end) {
          fill = 1; 
        } else if (value > start) {
          fill = (value - start) / segPercent; 
        }
        return (
          <div
            key={idx}
            className="flex-1 border border-[#E3E3E3] bg-[#F4F4F4] h-full relative overflow-hidden"
          >
            {fill > 0 && (
              <div
                className="absolute left-0 top-0 h-full bg-[#3167DD] transition-all duration-300"
                style={{ width: `${fill * 100}%` }}
              ></div>
            )}
          </div>
        );
      })}
    </div>
  );
};
