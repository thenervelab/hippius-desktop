

export const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export const getQuarterDateLabels=(referenceDate = new Date(), gap = 10)=> {
  const q = Math.floor(referenceDate.getMonth() / 3);
  const startMonth = q * 3;
  const labels: string[] = [];

  for (let m = startMonth; m < startMonth + 3; m++) {
    const daysInMonth = new Date(
      referenceDate.getFullYear(),
      m + 1,
      0
    ).getDate();
    for (let day = 1; day <= daysInMonth; day += gap) {
      labels.push(`${MONTHS[m]} ${String(day).padStart(2, "0")}`);
    }
    if (
      labels[labels.length - 1] !==
      `${MONTHS[m]} ${String(daysInMonth).padStart(2, "0")}`
    ) {
      labels.push(`${MONTHS[m]} ${String(daysInMonth).padStart(2, "0")}`);
    }
  }
  return labels;
}