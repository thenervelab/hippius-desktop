import { NodeMetric } from "../types";
import { lerp } from "./lerp";
import { parseGeolocation } from "./parseGeolocaiton";

const LON_OFFSET = 0.2;
const LAT_OFFSET = 0.2;
const MAX_ATTEMPTS = 10;

export const offsetNodesInSameLocation = (
  nodes: NodeMetric[],
  threshold: number
) => {
  const filteredNodes = nodes.filter((n) => !!n.geolocation);
  const nodesMap = filteredNodes.reduce(
    (acc, curr) => {
      acc[curr.miner_id] = curr;
      return acc;
    },
    {} as Record<NodeMetric["miner_id"], NodeMetric>
  );

  const geolocationMap: Record<string, NodeMetric[]> = {};
  const usedGeolocations = new Set<string>();

  filteredNodes.forEach((node) => {
    const geoKey = node.geolocation!;
    usedGeolocations.add(geoKey);

    if (!geolocationMap[geoKey]) {
      geolocationMap[geoKey] = [];
    }
    geolocationMap[geoKey].push(node);
  });

  const nodesWithUpdatedLocations: Record<NodeMetric["miner_id"], NodeMetric> =
    {};
  const locationsAndNodesToUpdate = Object.entries(geolocationMap).filter(
    ([, nodes]) => nodes.length < threshold
  );

  locationsAndNodesToUpdate.forEach(([loc, nodesToUpdate]) => {
    const { latitude, longitude } = parseGeolocation(loc);

    nodesToUpdate.forEach((n, i) => {
      let newGeoLocation: string | null = null;
      let attempts = 0;

      while (attempts < MAX_ATTEMPTS) {
        const newLat = latitude + lerp(-LAT_OFFSET, LAT_OFFSET, Math.random());
        const newLon = longitude + lerp(-LON_OFFSET, LON_OFFSET, Math.random());
        const candidate = `${newLat.toFixed(6)},${newLon.toFixed(6)}`;

        if (!usedGeolocations.has(candidate)) {
          newGeoLocation = candidate;
          usedGeolocations.add(candidate);
          break;
        }

        attempts++;
      }

      // Fallback if all attempts failed (very unlikely unless too many nodes at the same location)
      if (!newGeoLocation) {
        const fallback = `${latitude + i * 0.0001},${longitude + i * 0.0001}`;
        newGeoLocation = fallback;
        usedGeolocations.add(fallback);
      }

      n.geolocation = newGeoLocation;
      nodesWithUpdatedLocations[n.miner_id] = n;
    });
  });

  return Object.values({ ...nodesMap, ...nodesWithUpdatedLocations });
};
