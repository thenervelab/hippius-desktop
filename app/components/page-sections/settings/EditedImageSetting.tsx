"use client";

import { useEffect, useState } from "react";
import { PenLine } from "lucide-react";
import { toast } from "sonner";

import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { getSavePreference, setSavePreference, type SavePreference } from "@/app/lib/tauri/captureEditor";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { SettingIcon } from "./SettingIcon";

const OPTIONS: { value: SavePreference; label: string }[] = [
  { value: "ask", label: "Ask" },
  { value: "copy", label: "Save a copy" },
  { value: "replace", label: "Replace the original" },
];

/**
 * What Save does in the screenshot editor: ask each time, or always keep a
 * copy, or always replace. The same choice the save dialog's "Remember my
 * choice" stores; Rust keeps it (`capture_editor_save_preference`).
 */
export default function EditedImageSetting({ rowClassName }: { rowClassName: string }) {
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
    <div className={rowClassName}>
      <div className="flex min-w-0 items-start gap-3">
        <SettingIcon>
          <PenLine className="size-[18px]" strokeWidth={2} />
        </SettingIcon>
        <div className="min-w-0">
          <p className="text-sm font-medium text-grey-10 dark:text-white">When saving an edited image</p>
          <p className="mt-1 text-sm text-[#7D7D7D] dark:text-grey-dark-600">
            Keep the original and save a copy beside it, or write over the original.
          </p>
        </div>
      </div>
      <div className="w-full sm:w-auto">
        <SegmentedControl
          ariaLabel="When saving an edited image"
          options={OPTIONS}
          value={value}
          onChange={change}
          disabled={value === null}
          fullWidth
          showActiveIndicator={false}
        />
      </div>
    </div>
  );
}
