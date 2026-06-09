/**
 * Format a Date / ISO string / Unix timestamp as `DD/MM/YYYY H:MM am/pm`
 * in the user's local timezone.
 */
export const formatDate = (input: Date | string | number | bigint): string => {
  let date: Date;

  if (input instanceof Date) {
    date = input;
  } else if (typeof input === "number") {
    // Unix timestamp — treat ≤10-digit numbers as seconds.
    const timestamp = input.toString().length <= 10 ? input * 1000 : input;
    date = new Date(timestamp);
  } else if (typeof input === "bigint") {
    // BigInt timestamps from Polkadot API.
    const num = Number(input);
    const timestamp = num.toString().length <= 10 ? num * 1000 : num;
    date = new Date(timestamp);
  } else {
    date = new Date(input);
  }

  if (isNaN(date.getTime())) return "Invalid Date";

  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = String(date.getFullYear());

  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12 || 12;

  return `${dd}/${mm}/${yyyy} ${hours}:${minutes} ${ampm}`;
};
