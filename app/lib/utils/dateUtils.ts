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
