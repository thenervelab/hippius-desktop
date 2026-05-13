/**
 * Normalises an ISO-8601 date string to milliseconds since epoch.
 * Handles fractional seconds of any length (e.g. `.740567Z`).
 * Returns `null` for undefined / un-parseable input.
 */
export const normalizeIsoToMillis = (iso?: string): number | null => {
  if (!iso) return null;
  const s = iso.trim();

  const direct = Date.parse(s);
  if (!Number.isNaN(direct)) return direct;

  // Normalize fraction to 3 digits (ms)
  const m = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.(\d+))?Z$/);
  if (!m) return null;
  const base = m[1];
  const frac = (m[3] ?? "").padEnd(3, "0").slice(0, 3);
  const safeIso = frac ? `${base}.${frac}Z` : `${base}.000Z`;
  const t = Date.parse(safeIso);
  return Number.isNaN(t) ? null : t;
};

/**
 * Formats a date to compact format: DD/MM/YYYY H:MM am/pm
 * @param date - Date object to format
 * @returns Formatted date string like "22/09/2025 4:59 pm"
 */
export function formatCompactDate(date: Date): string {
  const day = date.getDate().toString().padStart(2, "0"); // DD
  const month = (date.getMonth() + 1).toString().padStart(2, "0"); // MM
  const year = date.getFullYear().toString(); // YYYY

  let hours = date.getHours(); // Get hours in 24-hour format
  const minutes = date.getMinutes().toString().padStart(2, "0"); // MM
  const ampm = hours >= 12 ? "pm" : "am";

  hours = hours % 12;
  hours = hours ? hours : 12; // Convert hour '0' (midnight) to '12'

  return `${day}/${month}/${year} ${hours}:${minutes} ${ampm}`;
}

export function formatUploadDate(dateString: string | number): string {
  const date = new Date(dateString);
  const day = date.getDate().toString().padStart(2, "0"); // DD
  const month = (date.getMonth() + 1).toString().padStart(2, "0"); // MM
  const year = date.getFullYear(); // YYYY

  let hours = date.getHours(); // Get hours in local time (0-23)
  const minutes = date.getMinutes().toString().padStart(2, "0"); // MM
  const ampm = hours >= 12 ? "PM" : "AM";

  hours = hours % 12;
  hours = hours ? hours : 12; // Convert hour '0' (midnight) to '12' for H format (1-12)

  return `${day}/${month}/${year} at ${hours}:${minutes} ${ampm}`;
}

/**
 * Gets the ordinal suffix for a number (st, nd, rd, th)
 */
function getOrdinalSuffix(day: number): string {
  if (day > 3 && day < 21) return "th";

  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

/**
 * Parses an ISO date string and returns formatted date and time parts
 * @param isoDateString - Date string in ISO format (e.g., '2025-06-03T06:47:28.740567Z')
 * @returns Object with formatted date and time strings
 */
export function parseDateAndTime(isoDateString: string): {
  date: string;
  time: string;
} {
  const date = new Date(isoDateString);

  // Format date like "26th of May, 2025"
  const day = date.getDate();
  const suffix = getOrdinalSuffix(day);
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const month = monthNames[date.getMonth()];
  const year = date.getFullYear();
  const formattedDate = `${day}${suffix} of ${month}, ${year}`;

  // Format time like "4:13:24 PM"
  let hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";

  hours = hours % 12;
  hours = hours ? hours : 12; // Convert hour '0' (midnight) to '12'

  const formattedTime = `${hours}:${minutes}:${seconds} ${ampm}`;

  return {
    date: formattedDate,
    time: formattedTime,
  };
}
