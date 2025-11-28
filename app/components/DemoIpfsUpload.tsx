/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";
import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

interface NebulaStats {
  udp_tx_bytes: number;
  udp_rx_bytes: number;
}

interface NebulaStatus {
  is_running: boolean;
  has_interface: boolean;
  message: string;
}

export default function NebulaTest() {
  const [ip, setIp] = useState<string>("");
  const [stats, setStats] = useState<NebulaStats | null>(null);
  const [status, setStatus] = useState<NebulaStatus | null>(null);
  const [error, setError] = useState<string>("");

  const fetchIp = async () => {
    try {
      const result = await invoke<string>("get_nebula_ip");
      setIp(result);
      setError("");
    } catch (e: any) {
      console.error("Failed to get IP:", e);
      setError("Failed to get IP: " + e.toString());
    }
  };

  const fetchStats = async () => {
    try {
      const result = await invoke<NebulaStats>("get_nebula_stats");
      setStats(result);
      setError("");
    } catch (e: any) {
      console.error("Failed to get stats:", e);
    }
  };

  const fetchStatus = async () => {
    try {
      const result = await invoke<NebulaStatus>("get_nebula_status");
      setStatus(result);
    } catch (e: any) {
      console.error("Failed to get status:", e);
    }
  };

  useEffect(() => {
    fetchIp();
    fetchStatus();
    const interval = setInterval(() => {
      fetchStats();
      fetchStatus();
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="p-6 border rounded-lg shadow-lg bg-white dark:bg-gray-800 text-black dark:text-white max-w-md mx-auto mt-10">
      <h2 className="text-2xl font-bold mb-6 border-b pb-2">
        Nebula Network Status
      </h2>

      {error && (
        <div
          className="bg-red-100 border-l-4 border-red-500 text-red-700 p-4 mb-6 rounded"
          role="alert"
        >
          <p className="font-bold">Error</p>
          <p>{error}</p>
        </div>
      )}

      {/* Connection Status */}
      {status && (
        <div className="mb-6">
          <div className="flex items-center gap-2">
            <div
              className={`w-3 h-3 rounded-full ${
                status.has_interface
                  ? "bg-green-500 animate-pulse"
                  : "bg-gray-400"
              }`}
            ></div>
            <span className="text-sm font-semibold">{status.message}</span>
          </div>
        </div>
      )}

      <div className="mb-6">
        <div className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400 font-semibold mb-1">
          Nebula IP Address
        </div>
        <div className="text-xl font-mono bg-gray-100 dark:bg-gray-900 p-3 rounded border dark:border-gray-700">
          {ip || "Loading..."}
        </div>
      </div>

      <div className="mb-6">
        <h3 className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400 font-semibold mb-2">
          Traffic Statistics
        </h3>
        {stats && status?.has_interface ? (
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded border border-blue-100 dark:border-blue-800">
              <div className="text-xs text-blue-500 dark:text-blue-400 font-bold mb-1">
                TX (Sent)
              </div>
              <div className="text-2xl font-mono text-blue-700 dark:text-blue-300">
                {(stats.udp_tx_bytes / 1024 / 1024).toFixed(2)}{" "}
                <span className="text-sm font-sans text-gray-500">MB</span>
              </div>
            </div>
            <div className="bg-green-50 dark:bg-green-900/20 p-4 rounded border border-green-100 dark:border-green-800">
              <div className="text-xs text-green-500 dark:text-green-400 font-bold mb-1">
                RX (Received)
              </div>
              <div className="text-2xl font-mono text-green-700 dark:text-green-300">
                {(stats.udp_rx_bytes / 1024 / 1024).toFixed(2)}{" "}
                <span className="text-sm font-sans text-gray-500">MB</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="text-gray-500 italic">
            {status?.is_running
              ? "Waiting for interface..."
              : "Nebula not running"}
          </div>
        )}
      </div>

      <div className="flex gap-3">
        <button
          onClick={fetchIp}
          className="flex-1 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-white font-semibold py-2 px-4 rounded transition duration-200"
        >
          Refresh IP
        </button>
        <button
          onClick={() => {
            fetchStats();
            fetchStatus();
          }}
          className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2 px-4 rounded transition duration-200"
        >
          Refresh Stats
        </button>
      </div>
    </div>
  );
}
