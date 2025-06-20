export const formatTimeDiff = (ts: number | string): string => {
    let timestampMs: number;

    if (typeof ts === "string") {
        // Try parsing ISO string or numeric string
        const parsed = Date.parse(ts);
        if (isNaN(parsed)) return "invalid date";
        timestampMs = parsed;
    } else if (typeof ts === "number") {
        // Assume seconds if 10 digits or less, otherwise ms
        timestampMs = ts < 1e12 ? ts * 1000 : ts;
    } else {
        return "invalid timestamp";
    }

    const diffRaw = Date.now() - timestampMs;
    const isFuture = diffRaw < 0;
    const diffMs = Math.abs(diffRaw);

    const sec = 1000;
    const min = 60 * sec;
    const hr = 60 * min;
    const day = 24 * hr;
    const month = 30 * day;
    const year = 12 * month;

    const years = Math.floor(diffMs / year);
    const months = Math.floor(diffMs / month);
    const days = Math.floor(diffMs / day);
    const hours = Math.floor(diffMs / hr);
    const minutes = Math.floor(diffMs / min);
    const seconds = Math.floor(diffMs / sec);

    let label: string;
    if (years >= 1) label = `${years} year${years > 1 ? "s" : ""}`;
    else if (months >= 1) label = `${months} month${months > 1 ? "s" : ""}`;
    else if (days >= 1) label = `${days} day${days > 1 ? "s" : ""}`;
    else if (hours >= 1) label = `${hours} hour${hours > 1 ? "s" : ""}`;
    else if (minutes >= 1) label = `${minutes} min${minutes > 1 ? "s" : ""}`;
    else if (seconds >= 1) label = `${seconds} sec${seconds > 1 ? "s" : ""}`;
    else return "just now";

    return isFuture ? `in ${label}` : `${label} ago`;
};