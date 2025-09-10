// Number input (SI: KB, MB, GB ... = 1000^n)
export function formatBytes(bytes: number, decimals: number = 2): string {
  if (bytes === 0) return "0 B";

  const k = 1000;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

  const i = Math.min(
    sizes.length - 1,
    Math.floor(Math.log(bytes) / Math.log(k))
  );

  const value = bytes / Math.pow(k, i);
  return `${parseFloat(value.toFixed(dm))} ${sizes[i]}`;
}

// BigInt input (SI: KB, MB, GB ... = 1000^n) without BigInt literals
// Works with target < ES2020 as long as runtime supports BigInt.
export const formatBytesFromBigInt = (bytes: bigint, decimals = 2): string => {
  if (bytes === BigInt(0)) return "0 B";

  const k = BigInt(1000);
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

  // Find unit index using integer math to avoid precision loss
  let i = 0;
  let tmp = bytes;
  while (tmp >= k && i < sizes.length - 1) {
    tmp = tmp / k;
    i++;
  }

  // pow for BigInt (no literals)
  const pow = (base: bigint, exp: number): bigint => {
    let r = BigInt(1);
    for (let j = 0; j < exp; j++) r *= base;
    return r;
  };

  const unitDiv = pow(k, i); // 1000^i
  const scale = pow(BigInt(10), dm); // 10^dm
  const scaled = (bytes * scale) / unitDiv; // integer scaled value

  // Convert scaled integer to fixed-point string
  const s = scaled.toString();
  let out: string;
  if (dm === 0) {
    out = s;
  } else if (s.length <= dm) {
    out = "0." + "0".repeat(dm - s.length) + s;
  } else {
    out = s.slice(0, s.length - dm) + "." + s.slice(s.length - dm);
  }

  // Trim trailing zeros and trailing dot
  out = out.replace(/\.?0+$/, "");
  return `${out} ${sizes[i]}`;
};

// Unit conversion constants (SI: 1000-based)
export const BYTE_UNITS = {
  KB: 1000,
  MB: 1000 * 1000,
  GB: 1000 * 1000 * 1000,
  TB: 1000 * 1000 * 1000 * 1000,
} as const;

export type ByteUnit = keyof typeof BYTE_UNITS;

// Convert bytes to a specific SI unit
export function bytesToUnit(bytes: number, unit: ByteUnit): number {
  return bytes / BYTE_UNITS[unit];
}

// Convert value in a specific SI unit to bytes
export function unitToBytes(value: number, unit: ByteUnit): number {
  return Math.round(value * BYTE_UNITS[unit]);
}

// Get max value for a unit given a byte limit (SI)
export function getMaxForUnit(maxBytes: number, unit: ByteUnit): number {
  return maxBytes / BYTE_UNITS[unit];
}
