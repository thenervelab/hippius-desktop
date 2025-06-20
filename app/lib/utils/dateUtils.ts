export function formatUploadDate(dateString: string | number): string {
  const date = new Date(dateString);
  const day = date.getDate(); // D
  const month = (date.getMonth() + 1).toString().padStart(2, "0"); // MM
  const year = date.getFullYear(); // YYYY

  let hours = date.getHours(); // Get hours in local time (0-23)
  const minutes = date.getMinutes().toString().padStart(2, "0"); // MM
  const ampm = hours >= 12 ? "PM" : "AM";

  hours = hours % 12;
  hours = hours ? hours : 12; // Convert hour '0' (midnight) to '12' for H format (1-12)

  return `${day}-${month}-${year} at ${hours}:${minutes} ${ampm}`;
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
