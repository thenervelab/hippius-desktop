"use client";

import React from "react";
import { useAtom } from "jotai";

import {
  storageOverviewDevOverrideAtom,
  type StorageOverviewDevScenario,
} from "@/app/lib/hooks/api/storageOverviewDevOverride";

const IS_DEV = process.env.NODE_ENV === "development";

const OPTIONS: Array<{ value: StorageOverviewDevScenario; label: string }> = [
  { value: null, label: "Live overview" },
  { value: "none", label: "No plan (access-key)" },
  { value: "free-under", label: "Free under 10 GB" },
  { value: "free-over", label: "Free over 10 GB" },
  { value: "paid-under", label: "Paid under limit" },
  { value: "paid-over", label: "Paid over limit" },
];

/**
 * Floating control for quota UX scenarios. Development builds only.
 * Stripped from production by the `IS_DEV` gate.
 */
const StorageQuotaDevPanel: React.FC = () => {
  const [scenario, setScenario] = useAtom(storageOverviewDevOverrideAtom);

  if (!IS_DEV) return null;

  return (
    <div
      className="fixed bottom-3 left-3 z-[9999] max-w-[240px] rounded-md border border-grey-dark-100 bg-white p-2 shadow-md dark:border-black-300 dark:bg-black-600"
      data-testid="storage-quota-dev-panel"
    >
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-grey-50 dark:text-grey-dark-500">
        Dev: storage overview
      </p>
      <select
        className="w-full rounded border border-grey-dark-100 bg-white px-2 py-1 text-[12px] text-grey-10 dark:border-black-300 dark:bg-black-700 dark:text-white"
        value={scenario ?? ""}
        onChange={(e) => {
          const raw = e.target.value;
          setScenario(
            (raw === "" ? null : raw) as StorageOverviewDevScenario,
          );
        }}
      >
        {OPTIONS.map((opt) => (
          <option key={String(opt.value)} value={opt.value ?? ""}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
};

export default StorageQuotaDevPanel;
