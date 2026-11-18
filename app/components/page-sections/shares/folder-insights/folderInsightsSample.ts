// The made-up rows drawn, blurred and labelled "Sample data", behind the
// upgrade prompt on a plan without the viewer list. Never a real number:
// Rust sends none for a locked plan.

import type { RoomPerson } from "@/app/lib/tauri/folderInsights";

export const SAMPLE_FILES: ReadonlyArray<{ name: string; facts: string }> = [
  { name: "Sample proposal.pdf", facts: "14 views · 6 people · 72% read" },
  { name: "Sample pricing.pdf", facts: "9 views · 5 people · 48% read" },
  { name: "Sample demo.mp4", facts: "4 views · 3 people" },
];

export const SAMPLE_PEOPLE: RoomPerson[] = [
  { viewerId: "sample-a", label: "Sample viewer A", visits: 5, lastViewedAt: null, pageTimeMs: 412_000, files: [] },
  { viewerId: "sample-b", label: "Sample viewer B", visits: 3, lastViewedAt: null, pageTimeMs: 198_000, files: [] },
  { viewerId: "sample-c", label: "Sample viewer C", visits: 1, lastViewedAt: null, pageTimeMs: 64_000, files: [] },
];
