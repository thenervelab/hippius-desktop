// Each block below pins one of the defects from the 2026-07-31 screen
// recording of the Review Changes dialog. They are written against the
// projections rather than the component because that is where the bugs were:
// the rendering was always a faithful view of a wrong value.

import { describe, it, expect } from "vitest";

import {
  applyToAll,
  areAllConflictsResolved,
  deriveBulkSelection,
  describeStagedPath,
  isEntirelyDeferred,
  isUnresolvedPathHash,
  reconcileResolutions,
  type ResolutionMap,
} from "../stagedChangesLogic";
import type { StagedConflict } from "@/lib/types/syncTypes";

function conflict(fileId: string, path = `out/${fileId}.js`): StagedConflict {
  return {
    file_id: fileId,
    path,
    conflict_type: "modify_modify",
    has_local: true,
    has_remote: true,
  };
}

const HASH = "91c60cf7a26c14d7389bc0b7c35b570689f9cc4a1b2c3d4e5f60718293a4b5c6";

describe("isUnresolvedPathHash", () => {
  it("flags a bare 64-char lowercase hex id", () => {
    expect(HASH).toHaveLength(64);
    expect(isUnresolvedPathHash(HASH)).toBe(true);
  });

  it("does not flag real paths that merely contain hex", () => {
    for (const path of [
      "out/cache/webpack/client-production.pack",
      // A hashed build artifact — hex, but has a directory and an extension.
      `out/static/chunks/${HASH}.js`,
      `${HASH}.js`,
      // Wrong length either way.
      HASH.slice(0, 63),
      `${HASH}a`,
      // Uppercase is never what hex::encode emits.
      HASH.toUpperCase(),
      "",
    ]) {
      expect(isUnresolvedPathHash(path)).toBe(false);
    }
  });

  it("describeStagedPath splits the two cases for the renderer", () => {
    expect(describeStagedPath(HASH)).toEqual({ kind: "unknown", hash: HASH });
    expect(describeStagedPath("notes/todo.md")).toEqual({
      kind: "path",
      value: "notes/todo.md",
    });
  });
});

describe("reconcileResolutions", () => {
  const conflicts = [conflict("a"), conflict("b")];

  it("keeps picks across a staged-changes refresh", () => {
    // The reported wipe: a fresh `staged` object used to reset everything.
    const prev: ResolutionMap = { a: "keep_local", b: "accept_remote" };
    expect(reconcileResolutions(prev, conflicts)).toEqual(prev);
  });

  it("returns the same object identity when nothing was dropped", () => {
    // Guards against an effect loop if a caller feeds the result back in.
    const prev: ResolutionMap = { a: "keep_local" };
    expect(reconcileResolutions(prev, conflicts)).toBe(prev);
  });

  it("drops picks for conflicts the engine no longer reports", () => {
    // A stale file_id must never reach sync_with_conflict_resolutions —
    // validate_resolutions would accept it and the engine would ignore it,
    // so the only signal would be a silently unresolved conflict.
    const prev: ResolutionMap = { a: "keep_local", gone: "keep_both" };
    const next = reconcileResolutions(prev, conflicts);
    expect(next).toEqual({ a: "keep_local" });
    expect(next).not.toBe(prev);
  });

  it("survives the conflict set emptying out", () => {
    expect(reconcileResolutions({ a: "skip" }, [])).toEqual({});
  });
});

describe("deriveBulkSelection", () => {
  const conflicts = [conflict("a"), conflict("b"), conflict("c")];

  it("reports the shared resolution when every row agrees", () => {
    // This is the fix for "clicked Accept Remote, highlight stayed on Keep
    // Both": the control's value comes from the rows, not a static table.
    expect(deriveBulkSelection(applyToAll(conflicts, "accept_remote"), conflicts)).toBe(
      "accept_remote",
    );
  });

  it("reports null when the rows disagree", () => {
    const mixed: ResolutionMap = { a: "keep_local", b: "keep_local", c: "keep_both" };
    expect(deriveBulkSelection(mixed, conflicts)).toBeNull();
  });

  it("reports null when any row is still unset", () => {
    const partial: ResolutionMap = { a: "keep_both", b: "keep_both" };
    expect(deriveBulkSelection(partial, conflicts)).toBeNull();
  });

  it("reports null for an empty conflict set", () => {
    expect(deriveBulkSelection({}, [])).toBeNull();
  });

  it("round-trips every resolution verb", () => {
    for (const verb of ["keep_local", "accept_remote", "keep_both", "skip"] as const) {
      expect(deriveBulkSelection(applyToAll(conflicts, verb), conflicts)).toBe(verb);
    }
  });
});

describe("areAllConflictsResolved", () => {
  const conflicts = [conflict("a"), conflict("b")];

  it("is vacuously true with no conflicts", () => {
    expect(areAllConflictsResolved({}, [])).toBe(true);
  });

  it("is false while any conflict is unset", () => {
    expect(areAllConflictsResolved({ a: "keep_both" }, conflicts)).toBe(false);
  });

  it("is true once every conflict has a verb, including skip", () => {
    expect(areAllConflictsResolved({ a: "skip", b: "skip" }, conflicts)).toBe(true);
  });
});

describe("isEntirelyDeferred", () => {
  const conflicts = [conflict("a"), conflict("b")];

  it("flags an all-skip review, which resolves nothing", () => {
    expect(isEntirelyDeferred({ a: "skip", b: "skip" }, conflicts)).toBe(true);
  });

  it("does not flag a partial skip", () => {
    expect(isEntirelyDeferred({ a: "skip", b: "keep_local" }, conflicts)).toBe(false);
  });

  it("does not flag an unresolved review", () => {
    expect(isEntirelyDeferred({ a: "skip" }, conflicts)).toBe(false);
  });

  it("does not flag an empty conflict set", () => {
    expect(isEntirelyDeferred({}, [])).toBe(false);
  });
});
