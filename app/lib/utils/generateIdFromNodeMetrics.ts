import { createHash } from "crypto"; // Node.js or some bundlers support this
import { NodeMetric } from "../types";

export function generateIdFromNodeMetrics(nodes: NodeMetric[]): string {
  const sorted = nodes.map((n) => n.miner_id).sort(); // ensure order doesn't matter
  const joined = sorted.join(",");
  return createHash("sha256").update(joined).digest("hex").slice(0, 12); // or 8, 16, etc.
}
