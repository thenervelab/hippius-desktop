"use client";
import React from "react";
import { HippiusLogo } from "@/components/ui/icons";

export default function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-screen h-screen w-screen bg-grey-100">
      <div
        role="status"
        aria-live="polite"
        className="flex flex-col items-center gap-4"
      >
        <div className="relative h-24 w-24">
          {/* soft glow */}
          <div className="absolute -inset-4 rounded-full bg-primary-50/15 blur-2xl animate-pulse" />

          {/* outer spinning ring */}
          <div
            className="absolute inset-0 rounded-full border-2 border-primary-50/30 border-t-primary-50 animate-spin"
            style={{ animationDuration: "1.2s" }}
          />

          {/* inner counter-rotating ring */}
          <div
            className="absolute inset-2 rounded-full border-2 border-primary-50/20 border-b-primary-50"
            style={{ animation: "spin 2s linear infinite reverse" }}
          />

          {/* orbiting dots */}
          <div
            className="absolute inset-0 animate-spin"
            style={{ animationDuration: "2.8s" }}
          >
            <span className="absolute left-1/2 top-0 -translate-x-1/2 size-2 rounded-full bg-primary-50" />
            <span className="absolute right-0 top-1/2 -translate-y-1/2 size-2 rounded-full bg-primary-50/80" />
            <span className="absolute left-1/2 bottom-0 -translate-x-1/2 size-2 rounded-full bg-primary-50/60" />
            <span className="absolute left-0 top-1/2 -translate-y-1/2 size-2 rounded-full bg-primary-50/40" />
          </div>

          {/* logo tile */}
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <div className="rounded-xl bg-white shadow-md ring-1 ring-primary-50/20 p-2">
              <HippiusLogo className="size-9 bg-primary-50 rounded text-white" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
