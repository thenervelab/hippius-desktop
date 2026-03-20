"use client";

import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  RevealTextLine,
  Input,
  CardButton,
  IconButton,
} from "@/components/ui";
import { toast } from "sonner";
import { Monitor } from "lucide-react";
import SectionHeader from "./SectionHeader";
import { Label } from "@/components/ui/label";
import { InView } from "react-intersection-observer";
import { Edit } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

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

  const toggleEditMode = () => {
    setIsEditing(!isEditing);
    if (isEditing) {
      setEditValue(deviceName);
    }
  };

  const hasChanged = editValue.trim() !== deviceName && editValue.trim() !== "";

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className="flex gap-6 w-full flex-col border border-grey-80 rounded-lg p-4 relative bg-[url('/assets/rpc-bg-layer.png')] bg-repeat-round bg-cover dark:bg-none"
        >
          <div className="w-full flex flex-col">
            <div className="w-full">
              <RevealTextLine
                rotate
                reveal={inView}
                parentClassName="w-full"
                className="delay-300 w-full"
              >
                <div className="w-full flex justify-between gap-4">
                  <SectionHeader
                    Icon={Monitor}
                    title="Device Name"
                    subtitle="A friendly name for this device, shown to your other devices when browsing remote sync folders."
                  />
                  {!isEditing && (
                    <IconButton
                      className="w-[146px] h-[42px]"
                      icon={Edit}
                      text="Edit Name"
                      onClick={toggleEditMode}
                    />
                  )}
                </div>
              </RevealTextLine>
            </div>
            <form className="w-full flex flex-col" onSubmit={handleSave}>
              <RevealTextLine
                rotate
                reveal={inView}
                parentClassName="w-full"
                className="delay-300 w-full mt-4"
              >
                <div className="space-y-1 text-grey-10 w-full flex flex-col">
                  <Label
                    htmlFor="device-name"
                    className="text-sm font-medium text-grey-70"
                  >
                    Device Name
                  </Label>
                  <div className="relative flex items-start w-full">
                    <Monitor className="size-6 absolute left-3 top-[28px] transform -translate-y-1/2 text-grey-60" />
                    <Input
                      id="device-name"
                      placeholder="e.g. Work MacBook, Home PC"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      disabled={!isEditing}
                      maxLength={64}
                      className="px-11 border-grey-80 h-14 text-grey-30 w-full
                        bg-transparent py-4 font-medium text-base rounded-lg duration-300 outline-none
                        hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus bg-grey-100"
                    />
                  </div>
                </div>
              </RevealTextLine>

              <div
                className={cn(
                  "overflow-hidden transition-all duration-300 ease-in-out",
                  isEditing
                    ? "max-h-96 opacity-100 mt-6"
                    : "max-h-0 opacity-0"
                )}
              >
                <RevealTextLine
                  rotate
                  reveal={inView && isEditing}
                  className="delay-300 w-full"
                >
                  <CardButton
                    type="submit"
                    className="max-w-[160px] h-[48px]"
                    variant="dialog"
                    disabled={isSaving || !hasChanged}
                    onClick={handleSave}
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex items-center text-lg leading-6 font-medium">
                        {isSaving ? "Saving..." : "Save"}
                      </span>
                    </div>
                  </CardButton>
                </RevealTextLine>
              </div>
            </form>
          </div>
        </div>
      )}
    </InView>
  );
}
