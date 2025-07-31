import React from "react";

const BackgroundRings = () => {
  return (
    <div className="absolute inset-0 w-full h-full overflow-hidden pointer-events-none">
      {/* top‑right ring */}
      <div
        className="
      absolute top-0 right-0
      -translate-y-1/2 translate-x-1/2
      w-[505px] h-[505px]
      rounded-full
      border-[162px] border-primary-90
      z-3
    "
      />

      {/* bottom‑left ring */}
      <div
        className="
      absolute bottom-11 left-0
      -translate-x-1/2 translate-y-1/2
      w-[505px] h-[505px]
      rounded-full
      border-[162px] border-primary-90
      z-3
    "
      />
    </div>
  );
};

export default BackgroundRings;
