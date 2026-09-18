import React from "react";

/**
 * The separator between a drive row's facts (size · files · date).
 *
 * Shared by the drive list and the "Shared with me" list: the two render the
 * same row of facts, and a second copy of a three-pixel dot is a second thing
 * to keep in step for no benefit.
 */
export const RowDot = () => (
  <span
    aria-hidden="true"
    className="w-[3px] h-[3px] rounded-full bg-[#9D9D9D] dark:bg-[#5a5a5a] flex-shrink-0"
  />
);
