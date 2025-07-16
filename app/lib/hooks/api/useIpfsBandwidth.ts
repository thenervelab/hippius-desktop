import { useEffect, useState } from "react";
import { IPFS_NODE_CONFIG } from "@/app/lib/config";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";

type Bandwidth = { in: number; out: number };

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes.toFixed(0)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function useIpfsBandwidth(intervalMs = 1000) {
  const [bw, setBw] = useState<Bandwidth>({ in: 0, out: 0 });
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const MAX_RETRIES = 3;

  useEffect(() => {
    let mounted = true;

    const fetchBandwidth = async () => {
      try {
        const response = await tauriFetch(
          `${IPFS_NODE_CONFIG.baseURL}/api/v0/stats/bw`,
          {
            method: "POST",
          }
        );

        if (response.ok) {
          const data = await response.json();
          if (mounted) {
            setBw({ in: data.RateIn, out: data.RateOut });
            setIsRetrying(false);
            setRetryCount(0);
          }
        } else {
          throw new Error(`HTTP error ${response.status}`);
        }
      } catch (error) {
        console.warn("Failed to fetch bandwidth stats:", error);

        try {
          const bwData = await invoke<{ RateIn: number; RateOut: number }>(
            "get_ipfs_bandwidth"
          );
          if (mounted) {
            setBw({ in: bwData.RateIn, out: bwData.RateOut });
            setIsRetrying(false);
            setRetryCount(0);
          }
        } catch (invokeError) {
          console.error("Tauri invoke also failed:", invokeError);

          if (retryCount < MAX_RETRIES) {
            setIsRetrying(true);
            setRetryCount((prev) => prev + 1);
          } else if (mounted) {
            setBw({ in: 0, out: 0 });
            setIsRetrying(false);
          }
        }
      }
    };

    fetchBandwidth();

    const intervalId = setInterval(fetchBandwidth, intervalMs);

    let retryId: NodeJS.Timeout | null = null;
    if (isRetrying) {
      retryId = setTimeout(() => {
        if (mounted) {
          fetchBandwidth();
        }
      }, 2000 * retryCount);
    }

    return () => {
      mounted = false;
      clearInterval(intervalId);
      if (retryId) clearTimeout(retryId);
    };
  }, [intervalMs, isRetrying, retryCount]);

  return {
    download: formatBytes(bw.in) + "/s",
    upload: formatBytes(bw.out) + "/s",
    rawData: bw,
  };
}
