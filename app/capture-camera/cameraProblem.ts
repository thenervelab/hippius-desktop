/**
 * Why the bubble shows no camera, in plain words with what to do about it.
 *
 * Rust says what the system answered when it asked for the camera
 * (`CameraState.access`, Linux's Camera portal) and where this system's
 * camera switch is (`privacyPlace`). A failure the page meets itself
 * (`getUserMedia` refused, no camera, busy, no picture) is named from the
 * error WebKit gives. The bubble used to say only "Camera unavailable",
 * which looked broken and told the user nothing.
 */

import type { CaptureCameraAccess } from "@/app/lib/tauri/capture";

export type CameraProblem = "asking" | "notAllowed" | "turnedOff" | "notFound" | "busy" | "noPicture" | "unsupported" | "other";

/** The problem Rust's answer means before any camera is opened, if any. */
export function problemFromAccess(access: CaptureCameraAccess | undefined): CameraProblem | null {
  switch (access) {
    case "asking":
      return "asking";
    case "denied":
      return "notAllowed";
    case "turnedOff":
      return "turnedOff";
    default:
      return null;
  }
}

/**
 * The problem a failed `getUserMedia` means, from the error's name. With
 * no camera the system sees (`cameraPresent` false) a refusal reads as
 * "no camera": WebKit finds no device to offer.
 */
export function problemFromError(e: unknown, cameraPresent?: boolean | null): CameraProblem {
  const name = e && typeof e === "object" && typeof (e as { name?: unknown }).name === "string" ? (e as { name: string }).name : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return cameraPresent === false ? "notFound" : "notAllowed";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "notFound";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "busy";
    default:
      return "other";
  }
}

const AGAIN = "then turn the camera off and on again.";

/** The bubble's title and the line under it. */
export function problemText(problem: CameraProblem, privacyPlace?: string): { title: string; hint: string } {
  const place = privacyPlace || "your system's privacy settings";
  switch (problem) {
    case "asking":
      return { title: "Allow camera access", hint: "Answer the camera question on your screen." };
    case "notAllowed":
      return { title: "Camera not allowed", hint: `Allow Hippius in ${place}, ${AGAIN}` };
    case "turnedOff":
      return { title: "Camera access is off", hint: `Turn on camera access in ${place}, ${AGAIN}` };
    case "notFound":
      return { title: "No camera found", hint: `Connect a camera, ${AGAIN}` };
    case "busy":
      return { title: "Camera is in use", hint: `Close other apps using the camera, such as a video call or a browser tab, ${AGAIN}` };
    case "noPicture":
      return { title: "No picture from the camera", hint: `Check the camera is connected and not used by another app, ${AGAIN}` };
    case "unsupported":
      return { title: "Camera not available here", hint: "This system cannot share the camera with Hippius. Update the system, then try again." };
    default:
      return { title: "Camera could not start", hint: `Turn the camera off and on again. If it keeps failing, restart Hippius.` };
  }
}
