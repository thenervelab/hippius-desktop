// Renders `NameCell` across the sync-status states that map to a visible
// badge (`uploading`, `pending`, `downloading`, `failed`, `synced`) and pins:
//
// 1. Only the badge for the active state is in the DOM.
// 2. The `failed` badge is the settled red text pill from the Figma table
//    spec, distinct from the in-flight progress circle. This is the visual
//    seam the 402 fix relies on: a row stuck on `failed` must not keep
//    masquerading as `uploading` (the pre-fix bug).
// 3. `failed` reports an accessible `aria-label="Upload failed"` for AT.
// 4. A row that loads as already `synced` shows no badge — only fresh
//    transitions through the live snapshot light up the synced pill, and
//    the pill auto-hides after `syncedBadgeMs`.
//
// We don't exercise the row enricher here — that's covered by integration
// tests against `files-table/index.tsx`. This file pins the badge contract
// the enricher and the live snapshot subscription depend on.

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import NameCell from "./NameCell";

// `next/link` reaches for the router context; replacing it with a plain
// `<a>` keeps the icon rendering pure and avoids dragging the App Router
// shim into a leaf-component test.
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string | { pathname: string };
  } & Record<string, unknown>) => (
    <a href={typeof href === "string" ? href : href.pathname} {...rest}>
      {children}
    </a>
  ),
}));

// `useUrlParams` reads from `useSearchParams`/`usePathname` — both unavailable
// in jsdom without a Next Router. The cell only uses the parameter values
// for folder navigation, which is orthogonal to the badge assertion.
vi.mock("@/app/utils/hooks/useUrlParams", () => ({
  useUrlParams: () => ({
    getParam: (_key: string, fallback: string) => fallback,
  }),
}));

// `SharedLinkBadge` does its own atom + Tauri-IPC dance. The badge under
// test sits next to it but doesn't depend on it; stubbing keeps the test
// hermetic.
vi.mock("@/components/page-sections/drive/SharedLinkBadge", () => ({
  default: () => null,
}));

// The file-status badge subscribes to the sync snapshot. The hook's only
// job here is to merge the live snapshot status with the static prop —
// returning an empty result mirrors a row that isn't in the live cycle,
// so the badge falls through to the `syncStatus` prop under test.
vi.mock("@/app/lib/hooks/useFileLiveProgress", () => ({
  useFileLiveProgress: () => ({ status: null, progressPercent: null }),
}));

// The failed badge now reads the persisted failure (via TanStack Query) and a
// retry mutation. Stub both so the badge-contract test stays hermetic (no
// QueryClient needed) — the failure→message mapping is covered by its own unit
// test, and the persist/retry path by the Rust tests.
vi.mock("@/app/lib/hooks/useFileFailure", () => ({
  useFileFailure: () => null,
  useRetryFailure: () => ({ retryFile: { mutate: () => {}, isPending: false } }),
}));

// Stub the file-type icon to a no-op so we don't pull in the full
// `getFileIcon` table — the row's leading icon isn't what we're asserting.
vi.mock("@/lib/utils/fileTypeUtils", () => ({
  getFileIcon: () => ({
    icon: ({ className }: { className?: string }) => (
      <span data-testid="file-icon" className={className} />
    ),
    color: "text-grey-50",
  }),
}));

// `MiddleTruncatedName` renders the suffix slot (where the sync-status
// badge lives) inside a span. We pass the suffix through unchanged so the
// badge is reachable via testing-library queries.
vi.mock("@/components/ui/MiddleTruncatedName", () => ({
  default: ({
    name,
    suffix,
  }: {
    name: string;
    suffix?: React.ReactNode;
  }) => (
    <span>
      {name}
      {suffix}
    </span>
  ),
}));

const baseProps = {
  rawName: "photo.jpg",
  actualName: "photo.jpg",
  arionHash: "0xdeadbeef",
  isAssigned: true,
  isFolder: false,
};

describe("NameCell sync-status badge", () => {
  it("renders the red 'Failed' pill with the 'Upload failed' label when syncStatus is 'failed'", () => {
    render(<NameCell {...baseProps} syncStatus="failed" />);

    const failedBadge = screen.getByTestId("sync-status-failed");
    expect(failedBadge).toBeInTheDocument();
    expect(failedBadge).toHaveAttribute("aria-label", "Upload failed");
    // The pulse is reserved for in-flight states; a settled failure must be
    // visually static so users can tell it isn't recovering on its own.
    expect(failedBadge).not.toHaveClass("animate-pulse");
    expect(failedBadge).toHaveTextContent("Failed");
  });

  // Each non-failed state pins BOTH halves: failed badge absent AND the
  // expected badge for that state present. Without the positive assertion a
  // future refactor that made `FileStatusBadge` return `null` unconditionally
  // would let all four negative tests pass while regressing the entire row.
  it("routes 'uploading' to the uploading badge, not the failed badge", () => {
    render(<NameCell {...baseProps} syncStatus="uploading" />);

    expect(screen.queryByTestId("sync-status-failed")).not.toBeInTheDocument();
    expect(screen.getByTestId("sync-status-uploading")).toBeInTheDocument();
  });

  it("routes 'downloading' to the downloading badge, not the failed badge", () => {
    render(<NameCell {...baseProps} syncStatus="downloading" />);

    expect(screen.queryByTestId("sync-status-failed")).not.toBeInTheDocument();
    expect(screen.getByTestId("sync-status-downloading")).toBeInTheDocument();
  });

  it("renders the yellow 'Pending' text pill when syncStatus is 'pending'", () => {
    render(<NameCell {...baseProps} syncStatus="pending" />);

    expect(screen.queryByTestId("sync-status-failed")).not.toBeInTheDocument();
    const pending = screen.getByTestId("sync-status-pending");
    expect(pending).toBeInTheDocument();
    expect(pending).toHaveTextContent("Pending");
  });

  // `synced` loaded statically (no live transition through the snapshot)
  // means the row has been quietly synced for a while — flashing the
  // celebratory pill on every page mount would create constant noise on
  // already-synced drives. The badge only lights up for fresh transitions.
  it("renders no sync-status badge for a statically-synced row", () => {
    render(<NameCell {...baseProps} syncStatus="synced" />);

    expect(screen.queryByTestId(/^sync-status-/)).not.toBeInTheDocument();
  });

  it("renders no sync-status badge when syncStatus is undefined", () => {
    // Most `FormattedUserFile` rows arrive without a `syncStatus` set; the
    // badge must stay silent in that case so non-synced legacy rows don't
    // sprout a stray pill.
    render(<NameCell {...baseProps} syncStatus={undefined} />);

    expect(screen.queryByTestId(/^sync-status-/)).not.toBeInTheDocument();
  });
});
