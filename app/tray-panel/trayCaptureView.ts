import type { CaptureMode, CaptureSupport } from "@/app/lib/tauri/capture";
import { disabledRecordingNote, offeredModes, supportedModesOf } from "@/app/lib/capture/modes";
import { recordAvailability, type RecordAvailability } from "@/app/lib/capture/recordAvailability";

/**
 * What the tray popover's capture row shows. Every decision is Rust's
 * (`capture_support`); this only reads it the way the Drive page's
 * `CaptureButtons` does, so the two surfaces always offer the same things.
 *
 * - `hidden`: the feature is off for this lane, or this platform cannot
 *   capture (or Rust could not say).
 * - `loading`: Rust has not answered yet; the row holds its place with a
 *   skeleton so the upload list below does not jump when it arrives.
 * - `ready`: the Screenshot button, and Record per `record`.
 */
export type TrayCaptureView =
  | { state: "hidden" }
  | { state: "loading" }
  | {
      state: "ready";
      /** The modes the Screenshot menu offers (`offeredModes`). */
      screenshotModes: CaptureMode[];
      /** Wayland: the desktop's own tool chooses, so the menu has one item. */
      systemPicker: boolean;
      /** Rust's line saying the desktop's tool chooses; null elsewhere. */
      systemPickerNote: string | null;
      /** Available, shown disabled with Rust's reason, or not offered here. */
      record: RecordAvailability;
      /** The modes the Record menu offers. */
      recordModes: CaptureMode[];
    };

/**
 * @param support `undefined` while Rust is being asked, `null` when asking
 *   failed, else its answer.
 */
export function trayCaptureView(
  enabled: boolean,
  support: CaptureSupport | null | undefined,
  mac: boolean,
): TrayCaptureView {
  if (!enabled) return { state: "hidden" };
  if (support === undefined) return { state: "loading" };
  if (support === null || !support.supported) return { state: "hidden" };
  const modes = supportedModesOf(support);
  const recordModes = offeredModes("recording", modes);
  const record = recordAvailability(support, mac, disabledRecordingNote(support));
  return {
    state: "ready",
    screenshotModes: offeredModes("screenshot", modes),
    systemPicker: support.selection === "systemPicker",
    systemPickerNote: support.systemPickerNote ?? null,
    // A recorder with no mode to offer has nothing to press.
    record: record.state === "available" && recordModes.length === 0 ? { state: "hidden" } : record,
    recordModes,
  };
}
