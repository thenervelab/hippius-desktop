import { NodeMetric } from "../types";

export const avgLatency = (r: NodeMetric): number =>
  r.avg_response_time_ms ??
  (r.total_latency_ms && r.total_times_latency_checked
    ? r.total_latency_ms / r.total_times_latency_checked
    : (r.latency_ms ?? 0));
