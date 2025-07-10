import { useEffect, useState } from "react";
import { IPFS_NODE_CONFIG } from "@/app/lib/config";

type Bandwidth = { in: number; out: number };

function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes.toFixed(0)} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function useIpfsBandwidth(intervalMs = 1000) {
    const [bw, setBw] = useState<Bandwidth>({ in: 0, out: 0 });

    useEffect(() => {
        let mounted = true;

        const fetchBw = async () => {
            try {
                const res = await fetch(
                    `${IPFS_NODE_CONFIG.baseURL}/api/v0/stats/bw`
                    , { method: "POST" });
                const { RateIn, RateOut } = await res.json();
                if (mounted) setBw({ in: RateIn, out: RateOut });
            } catch {
                /* ignore errors */
            }
        };

        fetchBw();
        const id = setInterval(fetchBw, intervalMs);
        return () => { mounted = false; clearInterval(id) };
    }, [intervalMs]);

    return {
        download: formatBytes(bw.in) + "/s",
        upload: formatBytes(bw.out) + "/s",
    };
}
