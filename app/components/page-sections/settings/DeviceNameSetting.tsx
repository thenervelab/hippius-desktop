"use client";

import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Monitor } from "lucide-react";

export default function DeviceNameSetting() {
  const [deviceName, setDeviceName] = useState("");
  const [editValue, setEditValue] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const loadDeviceName = useCallback(async () => {
    try {
      const name = await invoke<string>("get_device_name");
      setDeviceName(name);
      setEditValue(name);
    } catch (error) {
      console.error("Failed to load device name:", error);
    }
  }, []);

  useEffect(() => {
    loadDeviceName();
  }, [loadDeviceName]);

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = editValue.trim();
    if (!trimmed) {
      toast.error("Device name cannot be empty");
      return;
    }
    if (trimmed === deviceName) {
      setIsEditing(false);
      return;
    }
    setIsSaving(true);
    try {
      await invoke("set_device_name", { name: trimmed });
      setDeviceName(trimmed);
      setIsEditing(false);
      toast.success("Device name updated");
    } catch (error) {
      console.error("Failed to save device name:", error);
      toast.error("Failed to save device name");
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setEditValue(deviceName);
    setIsEditing(false);
  };

  return (
    <div className="border border-grey-80 rounded-lg bg-white dark:bg-[#1A1A1A] overflow-hidden">
      {/* Section header */}
      <div className="flex items-center gap-1.5 px-4 py-3">
        <Monitor className="size-4 text-primary-50" />
        <span className="text-xs font-semibold tracking-[0.5px] uppercase text-primary-50">
          Device Name
        </span>
      </div>
      <div className="border-t border-grey-80" />

      {/* Content */}
      {isEditing ? (
        <form onSubmit={handleSave} className="px-4 py-4">
          <input
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            autoFocus
            maxLength={64}
            placeholder="e.g. Work MacBook, Home PC"
            className="w-full border border-grey-80 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-grey-10 dark:text-white bg-white dark:bg-[#2A2A2A] outline-none focus:ring-2 focus:ring-primary-50/20 focus:border-primary-50 transition-colors"
          />
          <div className="flex items-center justify-end gap-2 mt-3">
            <button
              type="button"
              onClick={handleCancel}
              className="px-4 py-2 text-sm font-medium text-grey-40 dark:text-grey-60 border border-grey-80 dark:border-white/10 rounded-lg hover:bg-grey-98 dark:hover:bg-white/5 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving || !editValue.trim() || editValue.trim() === deviceName}
              className="px-4 py-2 text-sm font-medium text-white bg-primary-50 rounded-lg hover:bg-primary-40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSaving ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      ) : (
        <div className="flex items-center justify-between px-4 py-4">
          <span className="text-sm font-medium text-grey-10 dark:text-white">
            {deviceName}
          </span>
          <button
            type="button"
            onClick={() => setIsEditing(true)}
            className="px-3 py-1.5 text-sm font-medium text-white bg-primary-50 rounded-lg hover:bg-primary-40 transition-colors"
          >
            Edit Name
          </button>
        </div>
      )}
    </div>
  );
}
