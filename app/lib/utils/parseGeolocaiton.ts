export const parseGeolocation = (
  geoString: string
): { latitude: number; longitude: number } => {
  const parts = geoString.split(",").map((part) => parseFloat(part.trim()));

  if (parts.length !== 2 || parts.some(isNaN)) {
    throw new Error(
      'Invalid geolocation format. Expected format: "latitude,longitude"'
    );
  }

  return {
    latitude: parts[0],
    longitude: parts[1],
  };
};
