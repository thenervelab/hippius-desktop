import { describe, expect, it } from "vitest";
import type { FolderShareSummary, ShareSummary } from "@/app/lib/tauri/shares";
import {
  activeShareRowId,
  FOREIGN_FOLDER_EXPIRY_TOOLTIP,
  FOREIGN_FOLDER_REVOKE_TOOLTIP,
  folderSharePathLabel,
  folderShareRowPlan,
  mergeActiveShareRows,
  pickHistoryRowDisplay,
} from "../shareRowDisplay";

describe("pickHistoryRowDisplay", () => {
  it("returns the supplied filename when present", () => {
    expect(pickHistoryRowDisplay("report.pdf")).toEqual({
      text: "report.pdf",
      isPlaceholder: false,
    });
  });

  it("returns the console-origin placeholder when filename is null", () => {
    // History rows captured by the diff path on a device that never
    // had the keystore entry surface with `filename: null` — the same
    // marker the active-list helper handles via `shareUrl === null`.
    expect(pickHistoryRowDisplay(null)).toEqual({
      text: "Created from the console",
      isPlaceholder: true,
    });
  });

  it("returns a literal `<unknown>` filename verbatim", () => {
    // Defense in depth: an upstream wire change could surface the
    // marker string with a non-null filename column. Pin the
    // null-only branch so we don't silently start italicising it.
    expect(pickHistoryRowDisplay("<unknown>")).toEqual({
      text: "<unknown>",
      isPlaceholder: false,
    });
  });
});

// =============================================================================
// Merged active rows + folder-row action plan
// =============================================================================

const NOW = Date.parse("2026-08-24T12:00:00Z");

const fileRow = (over: Partial<ShareSummary> = {}): ShareSummary => ({
  shareToken: "file-tok",
  filename: "report.pdf",
  plaintextSize: 10,
  ciphertextSize: 12,
  mimeType: "application/pdf",
  createdAt: "2026-08-20T10:00:00Z",
  expiresAt: null,
  shareUrl: "https://console.hippius.com/share/file-tok#k=K",
  isPrivate: false,
  folderLabel: "Drive",
  relativePath: "report.pdf",
  ...over,
});

const folderRow = (over: Partial<FolderShareSummary> = {}): FolderShareSummary => ({
  tokenHash: "ab".repeat(32),
  folderHash: "37a8eec1ce19687d",
  pathPrefix: "Trips/Photos",
  displayName: "Photos",
  createdAt: "2026-08-21T10:00:00Z",
  expiresAt: null,
  revokedAt: null,
  resolvable: true,
  shareToken: "folder-tok",
  shareUrl: "https://console.hippius.com/shared-folder/folder-tok#k=K",
  isPrivate: false,
  ...over,
});

describe("mergeActiveShareRows", () => {
  it("interleaves both kinds newest-first by createdAt", () => {
    const rows = mergeActiveShareRows(
      [fileRow({ createdAt: "2026-08-20T10:00:00Z" })],
      [folderRow({ createdAt: "2026-08-21T10:00:00Z" })],
    );

    expect(rows.map((r) => r.kind)).toEqual(["folder", "file"]);
  });

  it("tolerates either listing being absent", () => {
    expect(mergeActiveShareRows(undefined, undefined)).toEqual([]);
    expect(mergeActiveShareRows([fileRow()], undefined)).toHaveLength(1);
    expect(mergeActiveShareRows(undefined, [folderRow()])).toHaveLength(1);
  });

  it("gives every row a kind-prefixed id, foreign folder rows included", () => {
    // A foreign folder row has no shareToken at all — its id must come from
    // the token hash so the table can still key it.
    const rows = mergeActiveShareRows(
      [fileRow()],
      [folderRow({ resolvable: false, shareToken: null, shareUrl: null })],
    );

    const ids = rows.map(activeShareRowId);
    expect(ids).toContain("file:file-tok");
    expect(ids).toContain(`folder:${"ab".repeat(32)}`);
  });
});

describe("folderSharePathLabel", () => {
  it("renders the whole-drive idiom for an empty prefix", () => {
    expect(folderSharePathLabel("")).toBe("Whole drive");
  });

  it("passes a real prefix through", () => {
    expect(folderSharePathLabel("Trips/Photos")).toBe("Trips/Photos");
  });
});

describe("folderShareRowPlan", () => {
  it("live resolvable row: copy and manage both available", () => {
    const plan = folderShareRowPlan(folderRow(), NOW);

    expect(plan.state).toBe("live");
    expect(plan.canCopy).toBe(true);
    expect(plan.copyTooltip).toBeUndefined();
    expect(plan.canManage).toBe(true);
    expect(plan.revokeTooltip).toBeUndefined();
    expect(plan.expiryTooltip).toBeUndefined();
  });

  it("foreign row: view-only with the honest device tooltips", () => {
    // Revoke and expiry are keyed by the plaintext token, which only the
    // minting device's keystore holds — so both are disabled, with copy the
    // console uses, rather than silently hidden.
    const plan = folderShareRowPlan(
      folderRow({ resolvable: false, shareToken: null, shareUrl: null }),
      NOW,
    );

    expect(plan.state).toBe("live");
    expect(plan.canCopy).toBe(false);
    expect(plan.copyTooltip).toMatch(/device that created it/i);
    expect(plan.canManage).toBe(false);
    expect(plan.revokeTooltip).toBe(FOREIGN_FOLDER_REVOKE_TOOLTIP);
    expect(plan.expiryTooltip).toBe(FOREIGN_FOLDER_EXPIRY_TOOLTIP);
  });

  it("revoked row: nothing left to copy or manage, even when resolvable", () => {
    const plan = folderShareRowPlan(
      folderRow({ revokedAt: "2026-08-22T10:00:00Z" }),
      NOW,
    );

    expect(plan.state).toBe("revoked");
    expect(plan.canCopy).toBe(false);
    expect(plan.copyTooltip).toMatch(/revoked/i);
    expect(plan.canManage).toBe(false);
    expect(plan.revokeTooltip).toBeUndefined();
    expect(plan.expiryTooltip).toBeUndefined();
  });

  it("expired resolvable row: copy suppressed, manage still available", () => {
    // Copy must not hand out a dead link even though this device can still
    // rebuild the URL; extending the expiry (or revoking) stays offered —
    // the backend answers authoritatively if the row is beyond saving.
    const plan = folderShareRowPlan(
      folderRow({ expiresAt: "2026-08-23T10:00:00Z" }),
      NOW,
    );

    expect(plan.state).toBe("expired");
    expect(plan.canCopy).toBe(false);
    expect(plan.copyTooltip).toMatch(/expired/i);
    expect(plan.canManage).toBe(true);
  });

  it("revocation wins over expiry", () => {
    const plan = folderShareRowPlan(
      folderRow({
        revokedAt: "2026-08-22T10:00:00Z",
        expiresAt: "2026-08-23T10:00:00Z",
      }),
      NOW,
    );

    expect(plan.state).toBe("revoked");
  });
});
