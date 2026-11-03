"use client";

import { useEffect, useState } from "react";
import { PenLine } from "lucide-react";
import { toast } from "sonner";

import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { getSavePreference, setSavePreference, type SavePreference } from "@/app/lib/tauri/captureEditor";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { SettingRow } from "./SettingRow";

const OPTIONS: { value: SavePreference; label: string }[] = [
  { value: "ask", label: "Ask" },
  { value: "copy", label: "Save a copy" },
  { value: "replace", label: "Replace" },
];

/**
 * What Save does in the screenshot editor: ask each time, or always keep a
 * copy, or always replace. The same choice the save dialog's "Remember my
 * choice" stores; Rust keeps it (`capture_editor_save_preference`).
 */
export default function EditedImageSetting() {
  const [value, setValue] = useState<SavePreference | null>(null);

  useEffect(() => {
    let alive = true;
    getSavePreference()
      .then((p) => alive && setValue(p))
      .catch(() => alive && setValue("ask"));
    return () => {
      alive = false;
    };
  }, []);

  const change = (next: SavePreference) => {
    const before = value;
    setValue(next);
    setSavePreference(next).catch((e) => {
      setValue(before);
      toast.error(errorMessage(e));
    });
  };

  return (
    <SettingRow
      wide
      icon={<PenLine className="size-[18px]" strokeWidth={2} />}
      title="When saving an edited image"
      description="What Save does in the screenshot editor."
      control={
        <SegmentedControl
          ariaLabel="When saving an edited image"
          options={OPTIONS}
          value={value}
          onChange={change}
          disabled={value === null}
          fullWidth
          showActiveIndicator={false}
        />
      }
    />
  );
}
