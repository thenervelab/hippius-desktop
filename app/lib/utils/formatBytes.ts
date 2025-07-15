export function formatBytes(bytes: number, decimals: number = 2): string {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

export const formatBytesFromBigInt = (bytes: bigint, decimals = 2): string => {
  if (bytes === BigInt(0)) return "0 B";

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

  // Convert BigInt to number for math operations
  const bytesNum = Number(bytes);

  const i = Math.floor(Math.log(bytesNum) / Math.log(k));

  return parseFloat((bytesNum / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
};

// Unit conversion constants for FileSizeSelector
export const BYTE_UNITS = {
  KB: 1024,
  MB: 1024 * 1024,
  GB: 1024 * 1024 * 1024,
  TB: 1024 * 1024 * 1024 * 1024,
} as const;

export type ByteUnit = keyof typeof BYTE_UNITS;

// Convert bytes to a specific unit
export function bytesToUnit(bytes: number, unit: ByteUnit): number {
  return bytes / BYTE_UNITS[unit];
}

// Convert value in a specific unit to bytes
export function unitToBytes(value: number, unit: ByteUnit): number {
  return Math.round(value * BYTE_UNITS[unit]);
}

// Get max value for a unit given a byte limit
export function getMaxForUnit(maxBytes: number, unit: ByteUnit): number {
  return maxBytes / BYTE_UNITS[unit];
}
