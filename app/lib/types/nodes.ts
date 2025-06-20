import { Pagination } from "./pagination";

export interface Node {
  minerId: string;
  status: "Online" | "Offline";
  storage: {
    used: number;
    total: number;
    unit: string;
  };
  location: string;
  performance: string;
  uptime: string;
}

/** One miner’s metrics response record */
export interface NodeMetric {
  miner_id: string;
  block_number: number;
  timestamp: number;
  avg_response_time_ms: number;
  bandwidth_mbps: number;
  consecutive_reliable_days: number;
  cpu_cores: number;
  cpu_model: string;
  current_storage_bytes: number;
  failed_challenges_count: number;
  free_memory_mb: number;
  geolocation: string;
  gpu_memory_mb: number;
  gpu_name: string;
  hypervisor_disk_type: string;
  ipfs_repo_size: number;
  ipfs_storage_max: number;
  ipfs_zfs_pool_alloc: number;
  ipfs_zfs_pool_free: number;
  ipfs_zfs_pool_size: number;
  is_sev_enabled: boolean;
  latency_ms: number;
  memory_mb: number;
  network_city: string;
  network_country: string;
  network_downlink_mb: number;
  network_interface_mac: string;
  network_interface_name: string;
  network_location: string;
  network_region: string;
  network_type: string;
  network_uplink_mb: number;
  peer_count: number;
  recent_downtime_hours: number;
  storage_growth_rate: number;
  storage_proof_time_ms: number;
  successful_challenges: number;
  successful_pin_checks: number;
  status?: boolean;
  total_challenges: number;
  total_latency_ms: number;
  total_minutes: number;
  total_pin_checks: number;
  total_storage_bytes: number;
  total_times_latency_checked: number;
  uptime_minutes: number;
  vm_count: number;
  success_rate: number;
}

export interface FileNodeMetric extends NodeMetric {
  file_id: string | number;
}

/** Full response from `/node-metrics` */
export interface NodeMetricsResponse {
  metrics: NodeMetric[];
  pagination: Pagination;
}
export interface NodeTooltipField {
  label: string;
  value: React.ReactNode;
  copyText?: string;
  toastMessage?: string;
  delay?: number;
}

export interface NodeToolTipProps {
  miner_id: string;
  cpu_cores: number;
  cpu_model: string;
  current_storage_bytes: number;
  ipfs_repo_size: number;
  ipfs_storage_max: number;
  peer_count: number;
  network_city: string;
  network_country: string;
}
