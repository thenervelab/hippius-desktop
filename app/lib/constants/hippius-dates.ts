const HIPPIUS_CREATION_DATE = new Date(2025, 2, 11);
HIPPIUS_CREATION_DATE.setHours(0, 0, 0, 0);

export function getHippiusCreationDate(): Date {
  return new Date(HIPPIUS_CREATION_DATE.getTime());
}
