import { NodeMetric } from "@/lib/types";

export const getLocationText = (node: NodeMetric) => {
  const locationDetails = { city: "", country: "" };

  // TODO - Speak to BE devs about this null thing

  if (
    node.network_city &&
    node.network_city.toLowerCase() !== "unknown" &&
    node.network_city.toLowerCase() !== "null" &&
    node.network_city.toLowerCase() !== "null,"
  ) {
    locationDetails.city = node.network_city;
  }

  if (
    node.network_country &&
    node.network_country.toLowerCase() !== "unknown" &&
    node.network_country.toLowerCase() !== "null" &&
    node.network_country.toLowerCase() !== "null,"
  ) {
    locationDetails.country = node.network_country;
  }

  if (locationDetails.city || locationDetails.country) {
    return Object.values(locationDetails)
      .filter((v) => !!v)
      .join(", ");
  }

  return "Unknown";
};
