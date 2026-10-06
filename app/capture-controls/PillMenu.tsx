"use client";

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check } from "lucide-react";
import {
  getCaptureCameras,
  getCaptureMicrophones,
  setCaptureCameraSize,
  switchCaptureCamera,
  switchCaptureMicrophone,
  type CameraSize,
  type CaptureCameraState,
  type CaptureDevice,
  type CaptureMicrophoneState,
} from "@/app/lib/tauri/capture";
import { GLASS_FOCUS, GLASS_MUTED, GLASS_PANEL } from "@/app/lib/capture/glass";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { isDeviceInUse } from "@/app/capture-overlay/barText";
import { stepIndex } from "@/app/capture-overlay/keyNav";

/** Which of the pill's menus is open. */
export type PillMenuKind = "microphone" | "camera";

/** The bubble's sizes, as the bar and the bubble's own strip name them. */
const SIZES: { size: CameraSize; label: string }[] = [
  { size: "small", label: "Small" },
  { size: "large", label: "Large" },
  { size: "full", label: "Full size" },
];

const ITEMS = '[role="menuitemradio"]';

/**
 * A device list for an open menu: read once as it opens (which also starts
 * Rust's device watch), then replaced by every list Rust sends while it is
 * open. Null until the first answer.
 */
function useDevices(kind: PillMenuKind | null) {
  const [devices, setDevices] = useState<CaptureDevice[] | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!kind) return;
    let alive = true;
    const read =
      kind === "microphone" ? getCaptureMicrophones : getCaptureCameras;
    const event =
      kind === "microphone" ? "capture_microphones" : "capture_cameras";
    setLoading(true);
    void read()
      .then((d) => alive && setDevices(d))
      .catch(() => alive && setDevices((prev) => prev ?? []))
      .finally(() => alive && setLoading(false));
    const unlisten = listen<CaptureDevice[]>(event, (e) => {
      if (alive) setDevices(e.payload);
    });
    return () => {
      alive = false;
      void unlisten.then((fn) => fn());
    };
  }, [kind]);
  return { devices, loading };
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <p
      className={`px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.06em] ${GLASS_MUTED}`}
    >
      {children}
    </p>
  );
}

function Row({
  checked,
  disabled,
  onSelect,
  children,
}: {
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      onClick={() => {
        if (!disabled) onSelect();
      }}
      className={`flex w-full items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-left text-[13px] text-white/90 hover:bg-white/10 focus-visible:bg-white/10 ${GLASS_FOCUS}`}
    >
      <span className="grid size-4 shrink-0 place-items-center">
        {checked && <Check className="size-3.5" aria-hidden />}
      </span>
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}

/**
 * The pill's menu mid-recording: the microphones, or the camera's sizes
 * and cameras. Every choice is Rust's to apply (`capture_microphone_switch`,
 * `capture_camera_set_size`, `capture_camera_switch`); the menu stays open
 * until Rust has answered, says Rust's line when a choice is refused (a
 * microphone that went away), and closes on success. Arrow keys move, Escape
 * closes and gives focus back to the button that opened it.
 */
export function PillMenu({
  kind,
  microphone,
  camera,
  onMicrophone,
  onClose,
}: {
  kind: PillMenuKind;
  microphone: CaptureMicrophoneState | null;
  camera: CaptureCameraState | null;
  onMicrophone: (state: CaptureMicrophoneState) => void;
  onClose: (refocus?: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const switches =
    kind === "microphone" ? !!microphone?.canSwitch : !!camera?.switchFromPill;
  const sizes = kind === "camera" && !!camera?.resizeFromPill;
  const { devices, loading } = useDevices(switches ? kind : null);
  const chosen =
    kind === "microphone"
      ? (microphone?.deviceId ?? null)
      : (camera?.deviceId ?? null);
  const noun = kind === "microphone" ? "microphone" : "camera";

  // Focus starts on the menu's checked item, as a menu opened from a button
  // (again once the list has arrived).
  const listed = devices !== null;
  useEffect(() => {
    const items = ref.current?.querySelectorAll<HTMLElement>(ITEMS);
    const checked = ref.current?.querySelector<HTMLElement>(
      `${ITEMS}[aria-checked="true"]`,
    );
    (checked ?? items?.[0] ?? ref.current)?.focus();
  }, [listed]);

  const choose = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    try {
      await action();
      onClose(true);
    } catch (e) {
      setRefusal(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
      return;
    }
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [],
    );
    const at = items.findIndex((el) => el === document.activeElement);
    const next = stepIndex(e.key, at, items.length, "vertical");
    if (next === null) return;
    e.preventDefault();
    items[next]?.focus();
  };

  return (
    <div className="flex w-full justify-center px-2 py-1">
      <div
        className={`max-h-[288px] w-72 overflow-y-auto rounded-[12px] p-1.5 ${GLASS_PANEL}`}
      >
        <div
          ref={ref}
          role="menu"
          tabIndex={-1}
          aria-label={
            kind === "microphone" ? "Choose a microphone" : "Camera options"
          }
          aria-busy={busy || (switches && devices === null)}
          onKeyDown={onKeyDown}
          className={`rounded-[8px] ${GLASS_FOCUS}`}
        >
          {sizes && camera && (
            <>
              <Heading>Size</Heading>
              {SIZES.map(({ size, label }) => (
                <Row
                  key={size}
                  checked={camera.size === size}
                  disabled={busy}
                  onSelect={() => void choose(() => setCaptureCameraSize(size))}
                >
                  {label}
                </Row>
              ))}
            </>
          )}
          {switches && (
            <>
              <Heading>
                {kind === "microphone" ? "Microphone" : "Camera"}
              </Heading>
              {devices === null ? (
                <p className={`px-2.5 py-1.5 text-[13px] ${GLASS_MUTED}`}>
                  Looking for {noun}s…
                </p>
              ) : devices.length === 0 ? (
                <p className={`px-2.5 py-1.5 text-[13px] ${GLASS_MUTED}`}>
                  Only the default {noun} was found
                </p>
              ) : (
                devices.map((d) => (
                  <Row
                    key={d.id}
                    checked={isDeviceInUse(d, chosen, devices)}
                    disabled={busy}
                    onSelect={() =>
                      void choose(() =>
                        kind === "microphone"
                          ? switchCaptureMicrophone(d.id).then(onMicrophone)
                          : switchCaptureCamera(d.id),
                      )
                    }
                  >
                    {d.name}
                    {d.isDefault && (
                      <span className={`ml-1.5 ${GLASS_MUTED}`}>Default</span>
                    )}
                  </Row>
                ))
              )}
            </>
          )}
        </div>
        <p
          role="status"
          className={
            refusal
              ? "px-2.5 pb-1 pt-2 text-[11.5px] leading-snug text-amber-300"
              : "sr-only"
          }
        >
          {refusal ??
            (loading && devices !== null ? `Looking for more ${noun}s` : "")}
        </p>
      </div>
    </div>
  );
}
