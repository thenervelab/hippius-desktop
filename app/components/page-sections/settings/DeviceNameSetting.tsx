"use client";

import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icons } from "@/components/ui";
import { toast } from "sonner";
import { Monitor, Check, Pencil } from "lucide-react";
import SectionHeader from "./SectionHeader";

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

  const handleSave = async () => {
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSave();
    } else if (e.key === "Escape") {
      handleCancel();
    }
  };

  return (
    <div className="flex flex-col w-full">
      <SectionHeader
        Icon={Monitor}
        title="Device Name"
        subtitle="A friendly name for this device, shown to your other devices when browsing remote sync folders."
      />

      <div className="mt-4 flex items-center gap-3">
        {isEditing ? (
          <>
            <input
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 px-3 py-2 text-sm border border-grey-80 rounded focus:outline-none focus:border-primary-50 bg-white"
              placeholder="e.g. Work MacBook, Home PC"
              autoFocus
              disabled={isSaving}
              maxLength={64}
            />
            <button
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-primary-50 hover:bg-primary-40 border border-primary-40 rounded transition-colors disabled:opacity-50"
              onClick={handleSave}
              disabled={isSaving || !editValue.trim()}
            >
              {isSaving ? (
                <Icons.Loader className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              Save
            </button>
            <button
              className="px-3 py-2 text-sm font-medium text-grey-40 bg-grey-95 hover:bg-grey-90 border border-grey-80 rounded transition-colors"
              onClick={handleCancel}
              disabled={isSaving}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <div className="flex-1 flex items-center gap-2 px-3 py-2 text-sm text-grey-10 bg-grey-98 border border-grey-80 rounded">
              <Monitor className="size-4 text-grey-50 flex-shrink-0" />
              <span className="truncate">{deviceName || "Loading..."}</span>
            </div>
            <button
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-grey-10 bg-grey-90 hover:bg-grey-80 border border-grey-80 rounded transition-colors"
              onClick={() => setIsEditing(true)}
            >
              <Pencil className="size-4" />
              Edit
            </button>
          </>
        )}
      </div>
    </div>
  );
}
