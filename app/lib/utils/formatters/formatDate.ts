export const formatDate = (input: Date | string | number): string => {
  let date: Date;

  if (input instanceof Date) {
    date = input;
  } else if (typeof input === "number") {
    // Handle Unix timestamps - if the number is less than 13 digits, it's likely in seconds
    // Convert to milliseconds by multiplying by 1000
    const timestamp = input.toString().length <= 10 ? input * 1000 : input;
    date = new Date(timestamp);
  } else if (typeof input === "bigint") {
    // Handle BigInt timestamps from Polkadot API
    const num = Number(input);
    const timestamp = num.toString().length <= 10 ? num * 1000 : num;
    date = new Date(timestamp);
  } else {
    date = new Date(input);
  }

  // Validate the date
  if (isNaN(date.getTime())) {
    return "Invalid Date";
  }

  const formatter = new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: undefined, // Uses user's local timezone
  });

  return formatter
    .format(date)
    .replace(",", "")
    .replace("AM", "am")
    .replace("PM", "pm");
};

export function formatDateWithouteTime(input: Date | string | number): string {
  const d = input instanceof Date ? input : new Date(input);

  // Validate the date
  if (isNaN(d.getTime())) {
    return "Invalid Date";
  }

  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${mm}/${dd}/${yy}`;
}
