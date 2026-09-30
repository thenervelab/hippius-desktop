"use client";

import dynamic from "next/dynamic";
import { Suspense } from "react";

/**
 * The root not-found boundary is part of EVERY route's first chunk list, so
 * its content is loaded on demand: statically, its UI and hook barrels put
 * react-query, the wallet stack and the icon set into the tray popover and
 * every capture window.
 */
const NotFoundContent = dynamic(() => import("@/app/components/NotFoundContent"));

export default function NotFound() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <NotFoundContent />
    </Suspense>
  );
}
