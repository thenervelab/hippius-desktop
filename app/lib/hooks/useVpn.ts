"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  MeshStatus,
  VpnConnectionInfo,
  VpnEndpoint,
  VpnStatusInfo,
  VmVpnTarget,
} from "@/app/lib/vpn/types";
import { resolveVmVpnView, type VmVpnView } from "@/app/lib/vpn/vmVpnView";

const targetKey = (t: { address: string; port: number }) => `${t.address}:${t.port}`;

interface VpnConnectionReadyPayload {
  address: string;
  port: number;
  endpoint: VpnEndpoint;
}

export interface UseVpnResult {
  /** Declarative view for the control (phase + which actions are enabled). */
  view: VmVpnView;
  /** Whether this build carries a real engine. */
  supported: boolean;
  /** A connect/disconnect/open call is in flight. */
  busy: boolean;
  /** Open localhost forwards, keyed by `${address}:${port}`. */
  endpoints: Record<string, VpnEndpoint>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  openConnection: (target: VmVpnTarget) => Promise<VpnEndpoint>;
  closeConnection: (target: VmVpnTarget) => Promise<void>;
}

/**
 * Thin wrapper over the `vpn_*` IPC commands and their events. All logic lives
 * in Rust (`crate::vpn`); this hook only invokes, tracks status from
 * `vpn_status_changed`, and records the open forwards. The action methods throw
 * on failure so the caller can surface its own toast.
 */
export function useVpn(): UseVpnResult {
  const [supported, setSupported] = useState(false);
  const [status, setStatus] = useState<MeshStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [endpoints, setEndpoints] = useState<Record<string, VpnEndpoint>>({});
  const mounted = useRef(true);
  // Count in-flight actions rather than a single boolean: if two overlap (e.g. a
  // logout-driven disconnect while an openConnection is still running), the
  // first to settle must not clear `busy` while the other is still pending.
  const inflight = useRef(0);

  const beginBusy = useCallback(() => {
    inflight.current += 1;
    if (mounted.current) setBusy(true);
  }, []);
  const endBusy = useCallback(() => {
    inflight.current = Math.max(0, inflight.current - 1);
    if (mounted.current) setBusy(inflight.current > 0);
  }, []);

  useEffect(() => {
    mounted.current = true;
    // `disposed` guards the listener-registration race: if the component
    // unmounts while `listen(...)` is still awaiting, any UnlistenFn that
    // resolves afterward is torn down immediately rather than leaked (the
    // cleanup closure captured an empty array). `track` centralizes that.
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    const track = (un: UnlistenFn) => {
      if (disposed) un();
      else unlisteners.push(un);
    };

    (async () => {
      try {
        const info = await invoke<VpnStatusInfo>("vpn_status");
        if (!disposed) {
          setSupported(info.supported);
          setStatus({ kind: info.kind, message: info.message });
        }
        // Rehydrate open forwards: the proxies persist in Rust, but
        // `vpn_connection_ready` only fires at open time, so a remount would
        // otherwise show an empty endpoint list while forwards are live.
        const conns = await invoke<VpnConnectionInfo[]>("vpn_list_connections");
        if (!disposed) {
          setEndpoints(
            Object.fromEntries(conns.map((c) => [targetKey(c), c.endpoint]))
          );
        }
      } catch {
        // Status/connection bootstrap is best-effort; the resolver treats the
        // absence as unsupported/disconnected.
      }

      track(
        await listen<MeshStatus>("vpn_status_changed", (e) => {
          if (mounted.current) setStatus(e.payload);
        })
      );
      track(
        await listen<VpnConnectionReadyPayload>("vpn_connection_ready", (e) => {
          if (!mounted.current) return;
          const { address, port, endpoint } = e.payload;
          setEndpoints((prev) => ({ ...prev, [targetKey({ address, port })]: endpoint }));
        })
      );
    })();

    return () => {
      mounted.current = false;
      disposed = true;
      for (const un of unlisteners) un();
    };
  }, []);

  const connect = useCallback(async () => {
    beginBusy();
    try {
      await invoke("vpn_connect");
    } finally {
      endBusy();
    }
  }, [beginBusy, endBusy]);

  const disconnect = useCallback(async () => {
    beginBusy();
    try {
      await invoke("vpn_disconnect");
      if (mounted.current) setEndpoints({});
    } finally {
      endBusy();
    }
  }, [beginBusy, endBusy]);

  const openConnection = useCallback(async (target: VmVpnTarget) => {
    beginBusy();
    try {
      const endpoint = await invoke<VpnEndpoint>("vpn_open_vm_connection", { target });
      if (mounted.current) {
        setEndpoints((prev) => ({ ...prev, [targetKey(target)]: endpoint }));
      }
      return endpoint;
    } finally {
      endBusy();
    }
  }, [beginBusy, endBusy]);

  const closeConnection = useCallback(async (target: VmVpnTarget) => {
    beginBusy();
    try {
      await invoke("vpn_close_vm_connection", { target });
      if (mounted.current) {
        setEndpoints((prev) => {
          const next = { ...prev };
          delete next[targetKey(target)];
          return next;
        });
      }
    } finally {
      endBusy();
    }
  }, [beginBusy, endBusy]);

  return {
    view: resolveVmVpnView(supported, status),
    supported,
    busy,
    endpoints,
    connect,
    disconnect,
    openConnection,
    closeConnection,
  };
}
