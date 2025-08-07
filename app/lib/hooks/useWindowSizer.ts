import { useEffect, useState } from "react";
import {
  getCurrentWindow,
  currentMonitor,
  PhysicalSize,
} from "@tauri-apps/api/window";

export function useWindowSizer() {
  const [size, setSize] = useState<{
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    async function adjust() {
      const win = await getCurrentWindow();
      const mon = await currentMonitor();
      if (!mon) return;

      const phys = mon.size;
      const uiScale = mon.scaleFactor;
      const rawW = phys.width > 1470 ? 1320 : phys.width * 0.9;
      const rawH = phys.height * 0.9;
      const finalW = Math.round(rawW / uiScale);
      const finalH = Math.round(rawH / uiScale);

      await win.setSize(new PhysicalSize(finalW, finalH));
      await win.show();
      await win.center();
      setSize({
        width: Math.round(finalW),
        height: Math.round(finalH),
      });
    }

    adjust();
  }, []);

  return size;
}
