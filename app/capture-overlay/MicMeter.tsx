"use client";

import { useEffect, useState } from "react";
import { inputIdByName, levelFrom, litBars } from "./micLevel";

const BARS = 5;

/**
 * A small live level meter beside the microphone row, so a user can see the
 * chosen microphone hears them before they record, as Loom shows. It opens
 * the microphone in this webview only while shown; the capture bar unmounts
 * it before the countdown, so it never holds the device while recording.
 * Anything that fails (no permission, no device) just leaves it dark.
 */
export default function MicMeter({ deviceName }: { deviceName: string | null }) {
  const [lit, setLit] = useState(0);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let frame = 0;
    let cancelled = false;

    const start = async () => {
      const media = navigator.mediaDevices;
      if (!media?.getUserMedia || typeof AudioContext === "undefined") return;
      const devices = await media.enumerateDevices();
      const id = inputIdByName(devices, deviceName);
      const s = await media.getUserMedia({ audio: id ? { deviceId: { exact: id } } : true, video: false });
      if (cancelled) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = s;
      context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(s).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      let last = -1;
      const tick = () => {
        analyser.getFloatTimeDomainData(samples);
        const next = litBars(levelFrom(samples), BARS);
        if (next !== last) {
          last = next;
          setLit(next);
        }
        frame = requestAnimationFrame(tick);
      };
      tick();
    };

    start().catch(() => setLit(0));
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((t) => t.stop());
      void context?.close().catch(() => undefined);
      setLit(0);
    };
  }, [deviceName]);

  return (
    <span aria-hidden className="flex h-3.5 items-end gap-[2px]" title="Microphone level">
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
