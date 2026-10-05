"use client";

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { MIC_LEVEL_EVENT, startCaptureMicMeter, stopCaptureMicMeter } from "@/app/lib/tauri/capture";
import { litBars } from "./micLevel";

const BARS = 5;

/**
 * A small live level meter beside the microphone row, so a user can see the
 * chosen microphone hears them before they record, as Loom shows.
 *
 * Rust measures it in the recording helper and sends the level; this page
 * never opens the microphone. WebKit lets one page capture at a time, so a
 * `getUserMedia` here muted the camera bubble (black) and the bubble opening
 * again muted this, back and forth on every toggle. Rust also stops the meter
 * before the recorder takes the microphone. Anything that fails (no
 * permission, no device, no helper) just leaves it dark.
 */
export default function MicMeter({ deviceId }: { deviceId: string | null }) {
  const [lit, setLit] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const unlisten = listen<number>(MIC_LEVEL_EVENT, (e) => {
      if (!cancelled) setLit(litBars(e.payload, BARS));
    });
    // Stop exactly the meter this mount started: a newer one (another
    // microphone picked) may already be running when this cleanup lands.
    const started = startCaptureMicMeter(deviceId).catch(() => null);
    return () => {
      cancelled = true;
      void unlisten.then((fn) => fn());
      void started.then((generation) => {
        if (generation !== null) void stopCaptureMicMeter(generation).catch(() => undefined);
      });
      setLit(0);
    };
  }, [deviceId]);

  return (
    <span aria-hidden className="flex h-3.5 items-end gap-[2px]">
      {Array.from({ length: BARS }, (_, i) => (
        <span
          key={i}
          className={`w-[3px] rounded-full transition-colors duration-75 ${i < lit ? "bg-[#30D158]" : "bg-white/20"}`}
          style={{ height: `${40 + i * 15}%` }}
        />
      ))}
    </span>
  );
}
