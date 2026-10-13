import { Circle, Maximize2, Minimize2 } from "lucide-react";
import type { SizeIcon } from "./cameraDevices";

/**
 * The bubble's size buttons' icon: a small or large dot for the round
 * sizes, and the full-size toggle's arrows. Shared by the bubble's own strip
 * (while choosing) and its controls window (while recording).
 */
export function SizeGlyph({ icon }: { icon: SizeIcon }) {
  if (icon === "enterFull") return <Maximize2 className="size-3.5" aria-hidden />;
  if (icon === "exitFull") return <Minimize2 className="size-3.5" aria-hidden />;
  return <Circle className={icon === "small" ? "size-2.5" : "size-3.5"} strokeWidth={2.4} aria-hidden />;
}
