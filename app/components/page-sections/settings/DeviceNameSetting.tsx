"use client";

import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Monitor } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SettingsCard } from "./SettingsCard";

/**
 * Device name editor. Reads / writes the local device name via the
 * `get_device_name` / `set_device_name` Rust commands. Styled to match
 * the SettingsCard pattern used by CustomizeRPC: grey header strip
 * with mono uppercase label, white content area with the device name
 * (or an editable input in edit mode). Action buttons (Edit Name in
 * view mode, Cancel / Save in edit mode) sit below the card.
 */
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

  const startEditing = () => {
    setEditValue(deviceName);
    setIsEditing(true);
  };

  const handleCancel = () => {
    setEditValue(deviceName);
    setIsEditing(false);
  };

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

  const hasChange = editValue.trim() !== "" && editValue.trim() !== deviceName;

  return (
    <div className="flex flex-col gap-3">
      <SettingsCard label="Device Name" icon={<Monitor className="size-4" />}>
        {isEditing ? (
          <form onSubmit={handleSave}>
            <input
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              autoFocus
              maxLength={64}
              placeholder="e.g. Work MacBook, Home PC"
              disabled={isSaving}
              className={cn(
                "block w-full bg-transparent border-0 outline-none px-4 py-3",
                "text-sm font-medium text-grey-10 dark:text-white",
                "placeholder:text-grey-60 dark:placeholder:text-grey-dark-500",
                "disabled:opacity-60 disabled:cursor-not-allowed"
              )}
            />
          </form>
        ) : (
          <div className="px-4 py-3 text-sm font-medium text-grey-10 dark:text-white">
            {deviceName || (
              <span className="text-grey-60 dark:text-grey-dark-500">
                Loading…
              </span>
            )}
          </div>
        )}
      </SettingsCard>

      {isEditing ? (
        <div className="flex items-center gap-3">
          <Button
            variant="defaultStable"
            size="auto"
            onClick={handleCancel}
            disabled={isSaving}
            className={cn(
              "h-[30px] px-3 gap-[7px] rounded-[6px] border text-sm font-medium",
              "border-grey-dark-100 bg-[#FEFEFE] text-[#4F4F4F]",
              "shadow-[0_5px_2.3px_rgba(0,0,0,0.03),0_1px_1.9px_rgba(0,0,0,0.14),0_0_1px_rgba(0,0,0,0.16),inset_0_1px_0_#FFF]",
              "hover:bg-[#F5F5F5]",
              "dark:border-black-300 dark:bg-black-600 dark:text-grey-dark-700 dark:shadow-[0_1px_2px_rgba(0,0,0,0.4)] dark:hover:bg-black-500"
            )}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="auto"
            onClick={() => handleSave()}
            disabled={isSaving || !hasChange}
            loading={isSaving}
            className={cn(
              "h-[30px] px-3 gap-[10px] rounded-[6px] border text-sm font-medium",
              "border-[#3167DD] bg-[#3167DD] text-white",
              "hover:bg-[#2454c4] hover:border-[#2454c4]",
              "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]"
            )}
          >
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </div>
      ) : (
        <div>
          <Button
            variant="primary"
            size="auto"
            onClick={startEditing}
            disabled={!deviceName}
            className={cn(
              "h-[30px] px-3 gap-[10px] rounded-[6px] border text-sm font-medium",
              "border-[#3167DD] bg-[#3167DD] text-white",
              "hover:bg-[#2454c4] hover:border-[#2454c4]",
              "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]"
            )}
          >
            Edit Name
          </Button>
        </div>
      )}
    </div>
  );
}
