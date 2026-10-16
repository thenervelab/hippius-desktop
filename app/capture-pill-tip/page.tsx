"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import "@/app/lib/capture/floating-window.css";
import { PILL_TIP_EVENT, getCapturePillTipNow, type CapturePillTipShown } from "@/app/lib/tauri/capture";
import { TIP_BOX, TipLines } from "@/app/capture-overlay/BarTooltip";
import { placeTooltip } from "@/app/capture-overlay/tooltipPlacement";

/**
 * The recording pill's tooltip, in a window of its own beside the pill.
 *
 * The pill's window is only as tall as the pill, so a tooltip drawn in it
 * above a button would be cut off. Rust puts this window just above the
 * pill (below it near the top of the screen), never over its glass, shows it
 * while the pill asks for a tooltip (`capture_pill_tip`) and hides it the
 * moment the pointer leaves the pill, so it never takes a click meant for
 * the pill or the app underneath. It never takes the keyboard, and the
 * recording leaves it out like the pill.
 *
 * The page decides nothing: it draws the text Rust sends against the
 * button's box (already in this window's pixels, so below this window's
 * bottom edge when it sits above the pill), placed the way the capture
 * bar places its own tooltip (`placeTooltip`: above the button, kept inside
 * the window), in the bar's glass, so both read as one tooltip.
 */
export default function CapturePillTipPage() {
  const [tip, setTip] = useState<CapturePillTipShown["tip"]>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Rust numbers what it sends: a first read that answers after an event
    // never puts an older tooltip back.
    let seq = -1;
    const take = (shown: CapturePillTipShown) => {
      if (shown.seq < seq) return;
      seq = shown.seq;
      setTip(shown.tip);
    };
    void getCapturePillTipNow()
      .then(take)
      .catch(() => undefined);
    const unlisten = listen<CapturePillTipShown>(PILL_TIP_EVENT, (e) => take(e.payload));
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Placed before paint, from the button's box and the tooltip's own size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!tip || !el) return;
    const size = el.getBoundingClientRect();
    const place = placeTooltip(tip.anchor, { width: size.width, height: size.height }, { width: window.innerWidth, height: window.innerHeight });
    el.style.left = `${place.left}px`;
    el.style.top = `${place.top}px`;
    el.dataset.side = place.side;
    el.style.visibility = "visible";
  }, [tip]);

  if (!tip) return null;
  return (
    <div ref={ref} role="tooltip" data-testid="capture-pill-tooltip" style={{ visibility: "hidden" }} className={TIP_BOX}>
      <TipLines label={tip.label} detail={tip.detail ?? undefined} />
    </div>
  );
}
