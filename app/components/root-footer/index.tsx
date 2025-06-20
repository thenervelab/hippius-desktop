"use client";

import { InView } from "react-intersection-observer";

const RootFooter: React.FC = () => (
  <InView triggerOnce threshold={0.3}>
    {({ ref }) => (
      <div
        ref={ref}
        className="border-t border-gray-200 py-3 px-6 text-xs text-gray-500 flex items-center justify-between"
      >
        <div>© 2024 Hippius. All rights reserved.</div>
        <div>Version 0.4.13</div>
      </div>
    )}
  </InView>
);

export default RootFooter;
