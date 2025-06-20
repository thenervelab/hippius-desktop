export const formatUptime = (mins: number): string => {
  const Y = 525600,
    M = 43200,
    D = 1440,
    H = 60;
  let rem = mins;
  const years = Math.floor(rem / Y);
  rem %= Y;
  const months = Math.floor(rem / M);
  rem %= M;
  const days = Math.floor(rem / D);
  rem %= D;
  const hours = Math.floor(rem / H);
  rem %= H;
  const segments = [
    years && `${years}y`,
    months && `${months}m`,
    days && `${days}d`,
    hours && `${hours}h`,
    rem && `${rem}m`,
  ].filter(Boolean);
  return segments.join(" ") || "0m";
};
