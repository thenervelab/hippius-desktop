"use client";

import React, { useRef } from "react";
import { useTheme } from "next-themes";
import { Sun, Moon, Monitor, Check, RotateCcw } from "lucide-react";
import {
  useAccentColor,
  ACCENT_PRESETS,
} from "@/lib/hooks/useAccentColor";

const THEME_OPTIONS = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
] as const;

const AppearanceSettings: React.FC = () => {
  const { theme, setTheme } = useTheme();
  const { accent, setAccent, customHex, setCustomHex, resetToDefaults } =
    useAccentColor();
  const colorInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-col gap-4 w-full">
      {/* Card 1: Theme */}
      <div className="shadow-menu rounded-lg bg-grey-100 p-4 w-full">
        <h3 className="text-sm font-semibold text-grey-10 mb-3">Theme</h3>
        <div className="flex gap-3">
          {THEME_OPTIONS.map(({ value, label, Icon }) => (
            <button
              key={value}
              onClick={() => setTheme(value)}
              className={`flex flex-1 flex-col items-center gap-2 rounded-lg border-2 px-4 py-3 transition-colors ${
                theme === value
                  ? "border-primary-50 bg-primary-100 text-primary-40"
                  : "border-grey-80 bg-grey-100 text-grey-50 hover:border-grey-70"
              }`}
            >
              <Icon className="size-5" />
              <span className="text-xs font-medium">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Card 2: Accent Color */}
      <div className="shadow-menu rounded-lg bg-grey-100 p-4 w-full">
        <h3 className="text-sm font-semibold text-grey-10 mb-3">
          Accent Color
        </h3>
        <div className="flex flex-wrap gap-3">
          {ACCENT_PRESETS.map((preset) => (
            <button
              key={preset.name}
              onClick={() => setAccent(preset.name)}
              className="group flex flex-col items-center gap-1.5"
              title={preset.label}
            >
              <div
                className={`relative size-9 rounded-full border-2 transition-all ${
                  accent === preset.name
                    ? "border-grey-10 scale-110"
                    : "border-transparent hover:scale-105"
                }`}
                style={{ backgroundColor: preset.hex }}
              >
                {accent === preset.name && (
                  <Check className="absolute inset-0 m-auto size-4 text-white drop-shadow-md" />
                )}
              </div>
              <span className="text-[10px] text-grey-50 font-medium">
                {preset.label}
              </span>
            </button>
          ))}

          {/* Custom color swatch */}
          <button
            onClick={() => {
              if (accent !== "custom") {
                setAccent("custom");
              }
              colorInputRef.current?.click();
            }}
            className="group flex flex-col items-center gap-1.5"
            title="Custom color"
          >
            <div
              className={`relative size-9 rounded-full border-2 transition-all ${
                accent === "custom"
                  ? "border-grey-10 scale-110"
                  : "border-grey-70 border-dashed hover:scale-105"
              }`}
              style={{
                backgroundColor: accent === "custom" ? customHex : undefined,
                background:
                  accent !== "custom"
                    ? "conic-gradient(from 0deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)"
                    : undefined,
              }}
            >
              {accent === "custom" && (
                <Check className="absolute inset-0 m-auto size-4 text-white drop-shadow-md" />
              )}
            </div>
            <span className="text-[10px] text-grey-50 font-medium">Custom</span>
          </button>

          <input
            ref={colorInputRef}
            type="color"
            value={customHex}
            onChange={(e) => {
              setAccent("custom");
              setCustomHex(e.target.value);
            }}
            className="sr-only"
            aria-label="Custom accent color picker"
          />
        </div>
      </div>

      {/* Card 3: Reset */}
      <div className="shadow-menu rounded-lg bg-grey-100 p-4 w-full">
        <h3 className="text-sm font-semibold text-grey-10 mb-1">
          Reset to Defaults
        </h3>
        <p className="text-xs text-grey-60 mb-3">
          Restore the default light theme with blue accents
        </p>
        <button
          onClick={() => {
            setTheme("light");
            resetToDefaults();
          }}
          className="flex items-center gap-2 rounded-lg border border-grey-80 px-3 py-2 text-sm font-medium text-grey-40 transition-colors hover:bg-grey-90 hover:text-grey-10"
        >
          <RotateCcw className="size-4" />
          Reset
        </button>
      </div>
    </div>
  );
};

export default AppearanceSettings;
